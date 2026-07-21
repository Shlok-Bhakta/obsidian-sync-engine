import type { DataAdapter } from "obsidian";
import type { Conflict, FileKind, Mutation, Revision } from "obsidian-sync-protocol";
import { atomicWrite } from "./storage";

export type FileMetadata = {
  fileId: string;
  path: string;
  kind: FileKind;
  revision: Revision;
  contentHash: string | null;
  deleted: boolean;
};

export type ConflictRecord = {
  conflict: Conflict;
  localMutation: Mutation;
  detectedAt: string;
};

type PersistedMetadata = {
  version: 1;
  lastAppliedRevision: Revision;
  files: Record<string, FileMetadata>;
  conflicts: ConflictRecord[];
  bootstrapId?: string;
  bootstrapManifest?: unknown;
};

const EMPTY: PersistedMetadata = { version: 1, lastAppliedRevision: "0", files: {}, conflicts: [] };

export class MetadataStore {
  private state: PersistedMetadata = structuredClone(EMPTY);
  private loaded = false;

  constructor(private readonly adapter: DataAdapter, private readonly path: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    if (await this.adapter.exists(this.path)) {
      const parsed = JSON.parse(await this.adapter.read(this.path)) as Partial<PersistedMetadata>;
      this.state = { ...structuredClone(EMPTY), ...parsed, files: parsed.files ?? {}, conflicts: parsed.conflicts ?? [] };
    }
    this.loaded = true;
  }

  get revision(): Revision { return this.state.lastAppliedRevision; }
  get conflicts(): readonly ConflictRecord[] { return this.state.conflicts; }
  get files(): readonly FileMetadata[] { return Object.values(this.state.files); }
  get bootstrapId(): string | undefined { return this.state.bootstrapId; }
  get bootstrapManifest(): unknown { return this.state.bootstrapManifest; }

  fileById(fileId: string): FileMetadata | undefined { return this.state.files[fileId]; }
  fileByPath(path: string): FileMetadata | undefined { return Object.values(this.state.files).find((file) => file.path === path && !file.deleted); }

  async putFile(file: FileMetadata): Promise<void> {
    this.state.files[file.fileId] = file;
    await this.persist();
  }

  async removeFile(fileId: string): Promise<void> {
    delete this.state.files[fileId];
    await this.persist();
  }

  async advanceRevision(revision: Revision): Promise<void> {
    if (BigInt(revision) < BigInt(this.state.lastAppliedRevision)) throw new Error("revision cursor cannot move backwards");
    this.state.lastAppliedRevision = revision;
    await this.persist();
  }

  async addConflict(record: ConflictRecord): Promise<void> {
    this.state.conflicts = this.state.conflicts.filter((item) => item.localMutation.mutationId !== record.localMutation.mutationId);
    this.state.conflicts.push(record);
    await this.persist();
  }

  async replaceConflict(record: ConflictRecord): Promise<void> { await this.addConflict(record); }

  async clearConflict(mutationId: string): Promise<void> {
    this.state.conflicts = this.state.conflicts.filter((item) => item.localMutation.mutationId !== mutationId);
    await this.persist();
  }

  async clearConflicts(): Promise<void> {
    this.state.conflicts = [];
    await this.persist();
  }

  async setBootstrap(bootstrapId: string | undefined, manifest: unknown = undefined): Promise<void> {
    this.state.bootstrapId = bootstrapId;
    this.state.bootstrapManifest = manifest;
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (!this.loaded) throw new Error("metadata store must be loaded before use");
    await atomicWrite(this.adapter, this.path, JSON.stringify(this.state));
  }
}
