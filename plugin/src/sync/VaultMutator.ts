import { normalizePath, type Vault } from "obsidian";
import type { SyncEvent } from "obsidian-sync-protocol";
import { HttpClient } from "./HttpClient";
import { MetadataStore, type FileMetadata } from "./MetadataStore";
import { atomicWrite, atomicWriteBinary, sha256 } from "./storage";
import { YjsStateStore } from "../yjs/YjsStateStore";

export class VaultMutator {
  private suppressions = new Map<string, string | null>();

  constructor(
    private readonly vault: Vault,
    private readonly metadata: MetadataStore,
    private readonly yjsStates: YjsStateStore,
    private readonly http: HttpClient,
  ) {}

  async apply(event: SyncEvent, ownClientId: string): Promise<void> {
    const current = this.metadata.fileById(event.fileId);
    if (event.clientId === ownClientId) {
      await this.applyOwnMetadata(event, current);
      await this.metadata.advanceRevision(event.revision);
      return;
    }

    if (event.operation === "delete") {
      const path = normalizePath(current?.path ?? event.path);
      this.suppressions.set(path, null);
      if (await this.vault.adapter.exists(path)) await this.vault.adapter.remove(path);
      if (current) await this.metadata.putFile({ ...current, revision: event.revision, deleted: true });
    } else if (event.operation === "rename") {
      const source = normalizePath(current?.path ?? event.path);
      const destination = normalizePath(event.destinationPath!);
      this.suppressions.set(source, null);
      this.suppressions.set(destination, current?.contentHash ?? null);
      if (source !== destination && await this.vault.adapter.exists(source)) await this.vault.adapter.rename(source, destination);
      if (current) await this.metadata.putFile({ ...current, path: destination, revision: event.revision, deleted: false });
    } else if (event.objectHash) {
      const bytes = await this.http.downloadObject(event.objectHash);
      const kind = event.path.toLowerCase().endsWith(".md") ? "markdown" : "blob";
      const occupied = this.metadata.fileByPath(event.path);
      const preserveLocal = occupied !== undefined && occupied.fileId !== event.fileId;
      if (kind === "markdown") {
        const result = await this.yjsStates.apply(event.fileId, bytes);
        const materialized = new TextEncoder().encode(result.text);
        const contentHash = await sha256(materialized);
        if (!preserveLocal) {
          this.suppressions.set(event.path, contentHash);
          await atomicWrite(this.vault.adapter, event.path, result.text);
        }
        await this.metadata.putFile({ fileId: event.fileId, path: event.path, kind, revision: event.revision, contentHash, deleted: false });
      } else {
        const contentHash = await sha256(bytes);
        if (!preserveLocal) {
          this.suppressions.set(event.path, contentHash);
          await atomicWriteBinary(this.vault.adapter, event.path, bytes.slice().buffer);
        }
        await this.metadata.putFile({ fileId: event.fileId, path: event.path, kind, revision: event.revision, contentHash, deleted: false });
      }
    }
    await this.metadata.advanceRevision(event.revision);
  }

  async consumeSuppression(path: string): Promise<boolean> {
    if (!this.suppressions.has(path)) return false;
    const expected = this.suppressions.get(path) ?? null;
    this.suppressions.delete(path);
    if (expected === null) return true;
    if (!(await this.vault.adapter.exists(path))) return false;
    const actual = await sha256(await this.vault.adapter.readBinary(path));
    return actual === expected;
  }

  async applyRemoteConflict(record: FileMetadata, hash: string | undefined, deleted: boolean, remotePath?: string): Promise<void> {
    if (deleted) {
      if (await this.vault.adapter.exists(record.path)) await this.vault.adapter.remove(record.path);
      await this.metadata.putFile({ ...record, path: remotePath ?? record.path, deleted: true });
      return;
    }
    if (remotePath && remotePath !== record.path && await this.vault.adapter.exists(record.path)) {
      await this.vault.adapter.rename(record.path, remotePath);
      record = { ...record, path: remotePath };
    }
    if (hash) {
      const bytes = await this.http.downloadObject(hash);
      if (record.kind === "markdown") {
        const result = await this.yjsStates.apply(record.fileId, bytes);
        await atomicWrite(this.vault.adapter, record.path, result.text);
        record = { ...record, contentHash: await sha256(new TextEncoder().encode(result.text)) };
      } else {
        await atomicWriteBinary(this.vault.adapter, record.path, bytes.slice().buffer);
        record = { ...record, contentHash: await sha256(bytes) };
      }
    }
    await this.metadata.putFile({ ...record, deleted: false });
  }

  private async applyOwnMetadata(event: SyncEvent, current?: FileMetadata): Promise<void> {
    if (!current) return;
    const path = event.operation === "rename" ? event.destinationPath! : current.path;
    await this.metadata.putFile({ ...current, path, revision: event.revision, deleted: event.operation === "delete" });
  }
}
