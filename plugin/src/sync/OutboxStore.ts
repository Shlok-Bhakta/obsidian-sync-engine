import type { DataAdapter } from "obsidian";
import type { Mutation } from "obsidian-sync-protocol";
import * as Y from "yjs";
import { atomicWrite, atomicWriteBinary, sha256 } from "./storage";

export type OutboxEntry = {
  mutation: Mutation;
  createdAt: string;
  inFlight: boolean;
};

type PersistedOutbox = { version: 1; entries: OutboxEntry[] };

export class OutboxStore {
  private entries: OutboxEntry[] = [];
  private loaded = false;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly indexPath: string,
    private readonly payloadDirectory: string,
  ) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    if (await this.adapter.exists(this.indexPath)) {
      const value = JSON.parse(await this.adapter.read(this.indexPath)) as PersistedOutbox;
      this.entries = value.entries.map((entry) => ({ ...entry, inFlight: false }));
    }
    this.loaded = true;
    await this.persist();
  }

  list(): readonly OutboxEntry[] { return this.entries; }
  get(mutationId: string): OutboxEntry | undefined { return this.entries.find((entry) => entry.mutation.mutationId === mutationId); }

  async cachePayload(bytes: Uint8Array): Promise<string> {
    const hash = await sha256(bytes);
    const path = `${this.payloadDirectory}/${hash}`;
    if (!(await this.adapter.exists(path))) {
      await atomicWriteBinary(this.adapter, path, bytes.slice().buffer);
    }
    return hash;
  }

  async readPayload(hash: string): Promise<Uint8Array> {
    return new Uint8Array(await this.adapter.readBinary(`${this.payloadDirectory}/${hash}`));
  }

  async enqueue(mutation: Mutation, payload?: Uint8Array): Promise<OutboxEntry> {
    if (this.get(mutation.mutationId)) return this.get(mutation.mutationId)!;
    if (payload) {
      const hash = await this.cachePayload(payload);
      if (mutation.objectHash !== hash) throw new Error("outbox payload hash does not match mutation objectHash");
    }
    if (mutation.operation === "yjs_update" && payload) {
      const previous = [...this.entries].reverse().find((entry) =>
        !entry.inFlight && entry.mutation.operation === "yjs_update" && entry.mutation.fileId === mutation.fileId,
      );
      if (previous?.mutation.objectHash) {
        const merged = Y.mergeUpdates([await this.readPayload(previous.mutation.objectHash), payload]);
        const mergedHash = await this.cachePayload(merged);
        previous.mutation = { ...previous.mutation, objectHash: mergedHash };
        await this.persist();
        return previous;
      }
    }
    const entry = { mutation, createdAt: new Date().toISOString(), inFlight: false };
    this.entries.push(entry);
    await this.persist();
    return entry;
  }

  async markInFlight(mutationId: string, value: boolean): Promise<void> {
    const entry = this.get(mutationId);
    if (entry) { entry.inFlight = value; await this.persist(); }
  }

  async acknowledge(mutationId: string): Promise<void> {
    const entry = this.get(mutationId);
    this.entries = this.entries.filter((item) => item.mutation.mutationId !== mutationId);
    await this.persist();
    const hash = entry?.mutation.objectHash;
    if (hash && !this.entries.some((item) => item.mutation.objectHash === hash)) {
      const path = `${this.payloadDirectory}/${hash}`;
      if (await this.adapter.exists(path)) await this.adapter.remove(path);
    }
  }

  async clear(): Promise<void> {
    for (const mutationId of this.entries.map((entry) => entry.mutation.mutationId)) {
      await this.acknowledge(mutationId);
    }
  }

  async rebaseFile(fileId: string, revision: string): Promise<void> {
    let changed = false;
    for (const entry of this.entries) {
      if (entry.mutation.fileId !== fileId || entry.mutation.operation === "create") continue;
      if (BigInt(entry.mutation.baseRevision) >= BigInt(revision)) continue;
      entry.mutation = { ...entry.mutation, baseRevision: revision };
      changed = true;
    }
    if (changed) await this.persist();
  }

  async replaceWith(mutationId: string, replacements: Array<{ mutation: Mutation; payload?: Uint8Array }>): Promise<void> {
    const index = this.entries.findIndex((entry) => entry.mutation.mutationId === mutationId);
    if (index < 0) throw new Error("conflicted outbox entry is missing");
    const built: OutboxEntry[] = [];
    for (const replacement of replacements) {
      if (replacement.payload) {
        const hash = await this.cachePayload(replacement.payload);
        if (replacement.mutation.objectHash !== hash) throw new Error("replacement payload hash mismatch");
      }
      built.push({ mutation: replacement.mutation, createdAt: new Date().toISOString(), inFlight: false });
    }
    this.entries.splice(index, 1, ...built);
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.loaded) throw new Error("outbox must be loaded before use");
    await atomicWrite(this.adapter, this.indexPath, JSON.stringify({ version: 1, entries: this.entries } satisfies PersistedOutbox));
  }
}
