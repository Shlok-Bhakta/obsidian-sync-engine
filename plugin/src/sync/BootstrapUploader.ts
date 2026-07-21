import type { BootstrapManifest } from "obsidian-sync-protocol";
import { HttpClient } from "./HttpClient";
import { MetadataStore } from "./MetadataStore";
import { OutboxStore } from "./OutboxStore";
import { VaultScanner } from "./VaultScanner";

export class BootstrapUploader {
  constructor(
    private readonly scanner: VaultScanner,
    private readonly metadata: MetadataStore,
    private readonly http: HttpClient,
    private readonly outbox: OutboxStore,
  ) {}

  async run(): Promise<{ accepted: boolean; snapshotRevision: string }> {
    let manifest: BootstrapManifest;
    let payloads: Map<string, Uint8Array>;
    const saved = this.metadata.bootstrapManifest as BootstrapManifest | undefined;
    if (saved && this.metadata.bootstrapId === saved.bootstrapId) {
      manifest = saved;
      payloads = new Map();
    } else {
      const built = await this.scanner.buildBootstrapManifest(this.metadata.bootstrapId);
      manifest = built.manifest;
      payloads = built.payloads;
      for (const [hash, payload] of payloads) {
        const cachedHash = await this.outbox.cachePayload(payload);
        if (cachedHash !== hash) throw new Error("Bootstrap payload cache verification failed");
      }
      await this.metadata.setBootstrap(manifest.bootstrapId, manifest);
    }
    for (const entry of manifest.entries) {
      if (await this.http.hasObject(entry.objectHash)) continue;
      const payload = payloads.get(entry.objectHash) ?? await this.outbox.readPayload(entry.objectHash);
      await this.http.uploadObject(entry.objectHash, payload);
    }
    const response = await this.http.commitInitialBootstrap(manifest);
    if (response.accepted) {
      const revisions = new Map(response.fileRevisions.map((file) => [file.fileId, file.revision]));
      await this.outbox.clear();
      await this.metadata.clearConflicts();
      for (const entry of manifest.entries) {
        const file = this.metadata.fileById(entry.fileId);
        const revision = revisions.get(entry.fileId);
        if (!revision) throw new Error(`Bootstrap response omitted revision for ${entry.fileId}`);
        if (file) await this.metadata.putFile({ ...file, revision });
      }
      await this.metadata.advanceRevision(response.snapshotRevision);
      await this.metadata.setBootstrap(undefined);
    }
    return { accepted: response.accepted, snapshotRevision: response.snapshotRevision };
  }
}
