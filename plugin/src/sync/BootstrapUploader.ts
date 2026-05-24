import { App, TFile, TFolder, normalizePath } from "obsidian";
import * as Y from "yjs";
import { BootstrapStatus, SyncMutation, opType } from "../../../shared/types";
import { encodeUpdateBatchJsonl } from "../../../shared/protocol";
import { docStateFromContent } from "../../../shared/yjsSeed";
import { shouldSyncPath, shouldUseYjs } from "../../../shared/pathPolicy";
import { errorContext, Logger } from "../../../shared/logger";
import { SyncEngineSettings } from "../settings";
import { YjsStateStore } from "../yjs/YjsStateStore";
import { BootstrapBlobClient } from "./BootstrapBlobClient";

const INLINE_BYTES_LIMIT = 64 * 1024;

type SnapshotPath = {
    path: string;
    isFolder: boolean;
};

type AdapterWithOptionalFileOps = App["vault"]["adapter"] & {
    mkdir?: (path: string) => Promise<void>;
    rename?: (from: string, to: string) => Promise<void>;
    remove?: (path: string) => Promise<void>;
};

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export class BootstrapUploader {
    private blobClient: BootstrapBlobClient;

    constructor(
        private readonly app: App,
        private readonly stateStore: YjsStateStore,
        settings: SyncEngineSettings,
        private readonly ensureAuthenticatedSocket: () => Promise<WebSocket>,
        private readonly log: Logger,
        private readonly onProgress: (status: BootstrapStatus) => void = () => {},
        private readonly pluginId = "obsidian-sync-engine",
    ) {
        this.blobClient = new BootstrapBlobClient(settings.backendUrl, settings.clientKey, settings.clientId);
    }

    update(settings: SyncEngineSettings): void {
        this.blobClient.update(settings.backendUrl, settings.clientKey, settings.clientId);
    }

    updateClientKey(clientKey: string): void {
        this.blobClient.updateClientKey(clientKey);
    }

    async uploadAuthoritativeSnapshot(): Promise<string> {
        const bootstrapId = `bootstrap-${Date.now()}-${crypto.randomUUID()}`;
        try {
            this.reportProgress("building", "Scanning vault", 0, 1);
            const mutations = await this.readVaultSnapshot(bootstrapId);
            const jsonl = encodeUpdateBatchJsonl(mutations);
            const manifestSha256 = await sha256Hex(new TextEncoder().encode(jsonl));
            this.reportProgress("uploading", "Writing bootstrap manifest", mutations.length, mutations.length);
            await this.writeActiveManifest(jsonl);

            await this.ensureAuthenticatedSocket();
            this.log.info("uploading bootstrap snapshot manifest", {
                bootstrapId,
                files: mutations.length,
                bytes: jsonl.length,
                manifestSha256,
            });
            this.reportProgress("uploading", "Finalizing bootstrap on server", mutations.length, mutations.length);
            const { revision } = await this.blobClient.uploadManifest(bootstrapId, jsonl, manifestSha256);
            this.log.info("bootstrap snapshot acknowledged", { bootstrapId, revision });
            await this.removeActiveManifest();
            this.reportProgress("complete", "Bootstrap complete", mutations.length, mutations.length);
            return revision;
        } catch (error) {
            this.reportProgress("failed", "Bootstrap failed", 0, 0, error instanceof Error ? error.message : String(error));
            throw error;
        }
    }

    private async readVaultSnapshot(bootstrapId: string): Promise<SyncMutation[]> {
        const created = Date.now();
        const changes: SyncMutation[] = [];
        const paths = await this.listSnapshotPaths();
        this.log.info("building bootstrap snapshot", { paths: paths.length });
        this.reportProgress("building", "Collecting folders", 0, paths.length);

        let processed = 0;
        for (const entry of paths) {
            if (entry.isFolder) {
                changes.push({
                    mutationId: crypto.randomUUID(),
                    operation: "CreateFolder",
                    path: entry.path,
                    isFolder: true,
                    created,
                });
            }
            processed++;
            this.reportProgress("building", "Collecting folders", processed, paths.length);
        }

        processed = 0;
        for (const entry of paths) {
            if (entry.isFolder) {
                processed++;
                continue;
            }
            const isYjs = shouldUseYjs(entry.path, this.app.vault.configDir);
            if (isYjs) {
                const loaded = this.app.vault.getAbstractFileByPath(entry.path);
                const content = loaded instanceof TFile
                    ? await this.app.vault.read(loaded)
                    : await this.app.vault.adapter.read(entry.path);
                const contentHash = await sha256Hex(new TextEncoder().encode(content));
                const cachedHash = await this.stateStore.getContentHash(entry.path);
                let yjsState = await this.stateStore.get(entry.path);
                if (!yjsState || cachedHash !== contentHash) {
                    yjsState = docStateFromContent(content, Y);
                    await this.stateStore.putWithContentHash(entry.path, yjsState, contentHash);
                }
                changes.push({
                    mutationId: crypto.randomUUID(),
                    operation: "UpsertFile",
                    path: entry.path,
                    content,
                    yjsState,
                    isFolder: false,
                    isYjs: true,
                    storageKind: "text",
                    created,
                });
                processed++;
                this.reportProgress("building", `Prepared ${entry.path}`, processed, paths.length);
                continue;
            }

            const contentBytes = new Uint8Array(await this.app.vault.adapter.readBinary(entry.path));
            const contentSha256 = await sha256Hex(contentBytes);
            const base: SyncMutation = {
                mutationId: crypto.randomUUID(),
                operation: "UpsertFile",
                path: entry.path,
                isFolder: false,
                isYjs: false,
                byteSize: contentBytes.byteLength,
                contentSha256,
                created,
            };
            if (contentBytes.byteLength > INLINE_BYTES_LIMIT) {
                this.reportProgress("uploading", `Uploading ${entry.path}`, processed, paths.length);
                await this.blobClient.upload(bootstrapId, entry.path, contentBytes, contentSha256);
                changes.push({
                    ...base,
                    storageKind: "lo",
                });
            } else {
                changes.push({
                    ...base,
                    storageKind: "bytea",
                    contentBytes,
                });
            }
            processed++;
            this.reportProgress("building", `Prepared ${entry.path}`, processed, paths.length);
        }

        return changes;
    }

    private async listSnapshotPaths(): Promise<SnapshotPath[]> {
        const byPath = new Map<string, SnapshotPath>();
        for (const file of this.app.vault.getAllLoadedFiles()) {
            if (!shouldSyncPath(file.path, this.app.vault.configDir, this.pluginId)) {
                continue;
            }
            byPath.set(file.path, {
                path: file.path,
                isFolder: file instanceof TFolder,
            });
        }
        await this.addAdapterPaths("", byPath);
        await this.addAdapterPaths(this.app.vault.configDir, byPath);
        return [...byPath.values()].sort((a, b) => {
            if (a.isFolder !== b.isFolder) {
                return a.isFolder ? -1 : 1;
            }
            return a.path.localeCompare(b.path);
        });
    }

    private async addAdapterPaths(dir: string, byPath: Map<string, SnapshotPath>): Promise<void> {
        if (dir && !(await this.app.vault.adapter.exists(dir))) {
            return;
        }
        const listed = await this.app.vault.adapter.list(dir);
        for (const folder of listed.folders) {
            if (shouldSyncPath(folder, this.app.vault.configDir, this.pluginId)) {
                byPath.set(folder, { path: folder, isFolder: true });
                await this.addAdapterPaths(folder, byPath);
            }
        }
        for (const file of listed.files) {
            if (shouldSyncPath(file, this.app.vault.configDir, this.pluginId)) {
                byPath.set(file, { path: file, isFolder: false });
            }
        }
    }

    private bootstrapDir(): string {
        return normalizePath(`${this.app.vault.configDir}/plugins/${this.pluginId}/bootstrap`);
    }

    private async writeActiveManifest(jsonl: string): Promise<void> {
        const adapter = this.app.vault.adapter as AdapterWithOptionalFileOps;
        const dir = this.bootstrapDir();
        const tmpPath = `${dir}/tmp.jsonl`;
        const activePath = `${dir}/active.jsonl`;
        try {
            await this.ensureDir(adapter, dir);
            await adapter.write(tmpPath, jsonl);
            if (adapter.rename) {
                if (await adapter.exists(activePath)) {
                    await adapter.remove?.(activePath);
                }
                await adapter.rename(tmpPath, activePath);
            } else {
                await adapter.write(activePath, jsonl);
                await adapter.remove?.(tmpPath);
            }
        } catch (error) {
            this.log.warn("failed to persist bootstrap manifest cache; continuing with in-memory upload", {
                ...errorContext(error),
            });
        }
    }

    private async removeActiveManifest(): Promise<void> {
        const adapter = this.app.vault.adapter as AdapterWithOptionalFileOps;
        const activePath = `${this.bootstrapDir()}/active.jsonl`;
        try {
            if (await adapter.exists(activePath)) {
                await adapter.remove?.(activePath);
            }
        } catch (error) {
            this.log.warn("failed to remove bootstrap manifest cache", errorContext(error));
        }
    }

    private async ensureDir(adapter: AdapterWithOptionalFileOps, dir: string): Promise<void> {
        const parts = dir.split("/");
        for (let index = 1; index <= parts.length; index++) {
            const path = parts.slice(0, index).join("/");
            if (path && !(await adapter.exists(path))) {
                await adapter.mkdir?.(path);
            }
        }
    }

    private reportProgress(
        status: BootstrapStatus["status"],
        phase: string,
        progressCurrent: number,
        progressTotal: number,
        message?: string,
    ): void {
        this.onProgress({
            type: opType.BootstrapStatus,
            status,
            vaultName: this.app.vault.getName(),
            phase,
            progressCurrent,
            progressTotal,
            message: message ?? `${phase} (${progressCurrent}/${progressTotal})`,
        });
    }
}
