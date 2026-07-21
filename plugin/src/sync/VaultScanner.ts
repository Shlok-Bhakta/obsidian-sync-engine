import { normalizePath, type Vault } from "obsidian";
import { shouldSyncVaultPath, type BootstrapManifest, type FileKind, type Mutation } from "obsidian-sync-protocol";
import * as Y from "yjs";
import { MetadataStore, type FileMetadata } from "./MetadataStore";
import { OutboxStore } from "./OutboxStore";
import { sha256 } from "./storage";
import { YjsStateStore } from "../yjs/YjsStateStore";

export type ScanResult = { discovered: number; journaled: number };

export class VaultScanner {
  private scanPromise: Promise<ScanResult> | null = null;
  private scanAgain = false;

  constructor(
    private readonly vault: Vault,
    private readonly metadata: MetadataStore,
    private readonly outbox: OutboxStore,
    private readonly yjsStates: YjsStateStore,
    private readonly pluginId: string,
  ) {}

  async scan(): Promise<ScanResult> {
    if (this.scanPromise) {
      this.scanAgain = true;
      return this.scanPromise;
    }
    this.scanPromise = this.runScans();
    try { return await this.scanPromise; }
    finally { this.scanPromise = null; }
  }

  private async runScans(): Promise<ScanResult> {
    let result: ScanResult = { discovered: 0, journaled: 0 };
    do {
      this.scanAgain = false;
      const current = await this.scanOnce();
      result = { discovered: current.discovered, journaled: result.journaled + current.journaled };
    } while (this.scanAgain);
    return result;
  }

  private async scanOnce(): Promise<ScanResult> {
    const paths = (await this.listFiles("")).filter((path) => shouldSyncVaultPath(path, {
      configDir: this.vault.configDir, pluginId: this.pluginId,
    }));
    const actual = new Map<string, { bytes: Uint8Array; hash: string; kind: FileKind }>();
    for (const path of paths) {
      const bytes = new Uint8Array(await this.vault.adapter.readBinary(path));
      actual.set(path, { bytes, hash: await sha256(bytes), kind: path.toLowerCase().endsWith(".md") ? "markdown" : "blob" });
    }

    let journaled = 0;
    const missing = this.metadata.files.filter((file) => !file.deleted && !actual.has(file.path));
    const unmatchedPaths = new Set(paths.filter((path) => !this.metadata.fileByPath(path)));

    for (const file of missing) {
      const renamePath = [...unmatchedPaths].sort().find((path) => actual.get(path)?.hash === file.contentHash && actual.get(path)?.kind === file.kind);
      if (renamePath) {
        await this.enqueue({
          mutationId: crypto.randomUUID(), operation: "rename", fileId: file.fileId, path: file.path,
          destinationPath: renamePath, baseRevision: file.revision,
        });
        await this.metadata.putFile({ ...file, path: renamePath });
        unmatchedPaths.delete(renamePath);
      } else {
        await this.enqueue({ mutationId: crypto.randomUUID(), operation: "delete", fileId: file.fileId, path: file.path, baseRevision: file.revision });
        await this.metadata.putFile({ ...file, deleted: true });
      }
      journaled += 1;
    }

    for (const path of paths) {
      const value = actual.get(path)!;
      const file = this.metadata.fileByPath(path);
      if (!file) {
        await this.journalCreate(path, value.bytes, value.hash, value.kind);
        journaled += 1;
      } else if (file.contentHash !== value.hash) {
        await this.journalUpdate(file, value.bytes, value.hash);
        journaled += 1;
      }
    }
    return { discovered: paths.length, journaled };
  }

  async buildBootstrapManifest(existingId?: string): Promise<{ manifest: BootstrapManifest; payloads: Map<string, Uint8Array> }> {
    const bootstrapId = existingId ?? crypto.randomUUID();
    const payloads = new Map<string, Uint8Array>();
    const entries: BootstrapManifest["entries"] = [];
    const paths = (await this.listFiles("")).filter((path) => shouldSyncVaultPath(path, {
      configDir: this.vault.configDir, pluginId: this.pluginId,
    })).sort();
    for (const path of paths) {
      const bytes = new Uint8Array(await this.vault.adapter.readBinary(path));
      let file = this.metadata.fileByPath(path);
      const kind: FileKind = path.toLowerCase().endsWith(".md") ? "markdown" : "blob";
      let object: Uint8Array<ArrayBufferLike> = bytes;
      if (kind === "markdown") {
        const doc = new Y.Doc();
        doc.getText("content").insert(0, new TextDecoder().decode(bytes));
        object = Y.encodeStateAsUpdate(doc);
        const fileId = file?.fileId ?? crypto.randomUUID();
        await this.yjsStates.save(fileId, doc);
        file ??= { fileId, path, kind, revision: "0", contentHash: await sha256(bytes), deleted: false };
      } else {
        file ??= { fileId: crypto.randomUUID(), path, kind, revision: "0", contentHash: await sha256(bytes), deleted: false };
      }
      await this.metadata.putFile(file);
      const objectHash = await sha256(object);
      payloads.set(objectHash, object);
      entries.push({ fileId: file.fileId, path, kind, objectHash });
    }
    return { manifest: { bootstrapId, entries }, payloads };
  }

  private async journalCreate(path: string, bytes: Uint8Array, contentHash: string, kind: FileKind): Promise<void> {
    const fileId = crypto.randomUUID();
    let payload = bytes;
    if (kind === "markdown") {
      const doc = new Y.Doc();
      doc.getText("content").insert(0, new TextDecoder().decode(bytes));
      payload = Y.encodeStateAsUpdate(doc);
      await this.yjsStates.save(fileId, doc);
    }
    const objectHash = await sha256(payload);
    await this.enqueue({ mutationId: crypto.randomUUID(), operation: "create", fileId, path, baseRevision: "0", objectHash }, payload);
    await this.metadata.putFile({ fileId, path, kind, revision: "0", contentHash, deleted: false });
  }

  private async journalUpdate(file: FileMetadata, bytes: Uint8Array, contentHash: string): Promise<void> {
    if (file.kind === "blob") {
      const objectHash = await sha256(bytes);
      await this.enqueue({ mutationId: crypto.randomUUID(), operation: "update", fileId: file.fileId, path: file.path, baseRevision: file.revision, objectHash }, bytes);
    } else {
      const doc = new Y.Doc();
      const persisted = await this.yjsStates.load(file.fileId);
      if (persisted) Y.applyUpdate(doc, persisted);
      const text = doc.getText("content");
      const target = new TextDecoder().decode(bytes);
      let update: Uint8Array | null = null;
      doc.on("update", (value: Uint8Array, origin: unknown) => { if (origin === "external-scan") update = value; });
      doc.transact(() => { text.delete(0, text.length); text.insert(0, target); }, "external-scan");
      if (update) {
        const objectHash = await sha256(update);
        await this.enqueue({ mutationId: crypto.randomUUID(), operation: "yjs_update", fileId: file.fileId, path: file.path, baseRevision: file.revision, objectHash }, update);
      }
      await this.yjsStates.save(file.fileId, doc);
    }
    await this.metadata.putFile({ ...file, contentHash, deleted: false });
  }

  private async enqueue(mutation: Mutation, payload?: Uint8Array): Promise<void> { await this.outbox.enqueue(mutation, payload); }

  private async listFiles(folder: string): Promise<string[]> {
    const listing = await this.vault.adapter.list(folder);
    const nested = await Promise.all(listing.folders.map((child) => this.listFiles(child)));
    return [...listing.files.map(normalizePath), ...nested.flat()];
  }
}
