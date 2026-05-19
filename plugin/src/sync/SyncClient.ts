import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import * as Y from "yjs";
import { OutboxSegment, OutboxStore } from "db/db";
import { BootstrapStatus, opType, ServerChange, SyncMutation, wsPacket } from "../../../shared/types";
import { bytesToBase64, decodePacket, encodePacket, PROTOCOL_VERSION } from "../../../shared/protocol";
import { docStateFromContent, MARKDOWN_FIELD } from "../../../shared/yjsSeed";
import { buildUploadFromSyncedDoc, shouldApplyDocSyncCatchUp } from "../../../shared/yjsUpload";
import { shouldSyncPath, shouldUseYjs } from "../../../shared/pathPolicy";
import { SyncEngineSettings } from "../settings";
import { DocSync } from "../yjs/DocSync";
import { YjsStateStore } from "../yjs/YjsStateStore";
import { BlobClient } from "./BlobClient";
import { errorContext, Logger } from "../../../shared/logger";
import { log as rootLog } from "../logger";

const EMPTY_BACKOFF_MS = 1000;
const ERROR_BACKOFF_MS = 2000;
const IDLE_EMPTY_SEGMENTS = 3;
const CONNECT_BACKOFF_INITIAL_MS = 5000;
const CONNECT_BACKOFF_MAX_MS = 60000;
const WS_WAIT_TIMEOUT_MS = 60_000;
const INLINE_BYTES_LIMIT = 64 * 1024;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toWebSocketUrl(backendUrl: string): string {
    const url = new URL(backendUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/worker";
    url.search = "";
    url.hash = "";
    return url.toString();
}

function readSocketMessage(event: MessageEvent): string {
    if (typeof event.data === "string") {
        return event.data;
    }
    throw new Error("WebSocket returned a non-text packet");
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function summarizeMutations(mutations: SyncMutation[]): Record<string, number> {
    return mutations.reduce<Record<string, number>>((summary, mutation) => {
        summary[mutation.operation] = (summary[mutation.operation] ?? 0) + 1;
        return summary;
    }, {});
}

function summarizeServerChanges(changes: ServerChange[]): Record<string, number> {
    return changes.reduce<Record<string, number>>((summary, change) => {
        summary[change.operation] = (summary[change.operation] ?? 0) + 1;
        return summary;
    }, {});
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            value => {
                window.clearTimeout(timer);
                resolve(value);
            },
            error => {
                window.clearTimeout(timer);
                reject(asError(error));
            },
        );
    });
}

function dirname(path: string): string {
    const index = path.lastIndexOf("/");
    return index === -1 ? "" : path.slice(0, index);
}

type SnapshotPath = {
    path: string;
    isFolder: boolean;
};

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export class SyncClient {
    private ws: WebSocket | null = null;
    private serverUrl: string;
    private clientId: string;
    private clientKey: string;
    private clientName: string;
    private lastPulledRevision: string;
    private draining = false;
    private stopped = false;
    private flushTimer: number | null = null;
    private pollInterval: number | null = null;
    private authenticated = false;
    private authPromise: Promise<WebSocket> | null = null;
    private startupSyncPromise: Promise<void> | null = null;
    private startupSynced = false;
    private applyingRemote = false;
    private failedConnectAttempts = 0;
    private nextConnectAt = 0;
    private blobClient: BlobClient;
    private readonly log: Logger;
    private livePushPromise: Promise<void> = Promise.resolve();

    constructor(
        private readonly app: App,
        private readonly outbox: OutboxStore,
        private readonly stateStore: YjsStateStore,
        settings: SyncEngineSettings,
        private readonly onClientKeyRotated: (clientKey: string) => Promise<void> = async () => {},
        private readonly onLastPulledRevisionChanged: (revision: string) => Promise<void> = async () => {},
        private readonly getDocSync: (path: string) => DocSync | undefined = () => undefined,
        private readonly onBootstrapStatus: (status: BootstrapStatus) => void = () => {},
    ) {
        this.serverUrl = toWebSocketUrl(settings.backendUrl);
        this.clientId = settings.clientId;
        this.clientKey = settings.clientKey;
        this.clientName = settings.clientName;
        this.lastPulledRevision = settings.lastPulledRevision;
        this.blobClient = new BlobClient(settings.backendUrl, settings.clientKey, () => this.refreshBlobAuth());
        this.log = rootLog.child({
            clientId: this.clientId.slice(0, 18),
            clientName: this.clientName,
        });
    }

    isApplyingRemoteChanges(): boolean {
        return this.applyingRemote;
    }

    start(): void {
        this.stopped = false;
        this.recordConnectionSuccess();
        this.log.info("sync client starting", {
            serverUrl: this.serverUrl,
            lastPulledRevision: this.lastPulledRevision,
        });
        this.connectSoon();
        this.pollInterval = window.setInterval(() => {
            this.connectSoon();
        }, 5000);
    }

    stop(): void {
        this.stopped = true;
        this.log.info("sync client stopping");
        if (this.flushTimer !== null) {
            window.clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.pollInterval !== null) {
            window.clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.closeSocket();
    }

    updateSettings(settings: SyncEngineSettings): void {
        const nextUrl = toWebSocketUrl(settings.backendUrl);
        const authChanged =
            settings.clientId !== this.clientId ||
            settings.clientKey !== this.clientKey ||
            settings.clientName !== this.clientName;
        this.clientId = settings.clientId;
        this.clientKey = settings.clientKey;
        this.clientName = settings.clientName;
        this.lastPulledRevision = settings.lastPulledRevision;
        this.blobClient.update(settings.backendUrl, settings.clientKey);
        if (nextUrl !== this.serverUrl || authChanged) {
            this.log.info("sync settings changed; reconnecting", {
                backendChanged: nextUrl !== this.serverUrl,
                authChanged,
                nextUrl,
            });
            this.serverUrl = nextUrl;
            this.startupSyncPromise = null;
            this.startupSynced = false;
            this.recordConnectionSuccess();
            this.closeSocket();
        }
        this.connectSoon();
    }

    async uploadBlob(path: string, bytes: Uint8Array): Promise<{ byteSize: number; contentSha256: string }> {
        await this.ensureAuthenticatedSocket();
        const contentSha256 = await sha256Hex(bytes);
        this.log.debug("uploading blob", { path, byteSize: bytes.byteLength, contentSha256 });
        await this.blobClient.upload(path, bytes, contentSha256);
        return { byteSize: bytes.byteLength, contentSha256 };
    }

    async generateBootstrapLink(vaultName: string, configDir: string, pluginId: string): Promise<void> {
        await this.ensureStartupSynced();
        const openWs = await this.ensureAuthenticatedSocket();
        const backendUrl = this.httpBackendUrl();
        this.log.info("creating bootstrap link", { vaultName, configDir, pluginId, backendUrl });
        openWs.send(encodePacket({
            type: opType.BootstrapCreate,
            vaultName,
            backendUrl,
            configDir,
            pluginId,
        }));
    }

    connectSoon(): void {
        if (this.stopped || this.startupSyncPromise || this.startupSynced) {
            return;
        }
        if (Date.now() < this.nextConnectAt) {
            return;
        }

        this.startupSyncPromise = this.runStartupSync()
            .catch(error => {
                this.recordConnectionFailure(error);
                this.closeSocket();
            })
            .finally(() => {
                this.startupSyncPromise = null;
                if (this.startupSynced) {
                    this.wakeSoon();
                }
            });
    }

    wakeSoon(): void {
        if (this.stopped || this.flushTimer !== null || this.startupSyncPromise || !this.startupSynced) {
            return;
        }

        this.flushTimer = window.setTimeout(() => {
            this.flushTimer = null;
            void this.drainOutbox();
        }, 1000);
    }

    async drainOutbox(): Promise<void> {
        if (this.draining || this.stopped || this.startupSyncPromise || !this.startupSynced) {
            return;
        }

        this.draining = true;
        this.log.debug("outbox drain starting");
        try {
            let emptyCount = 0;
            while (!this.stopped) {
                let segment: OutboxSegment | null = null;
                try {
                    segment = await this.outbox.claimNextSegment(true);
                    if (!segment) {
                        emptyCount++;
                        if (emptyCount >= IDLE_EMPTY_SEGMENTS) {
                            return;
                        }
                        await sleep(EMPTY_BACKOFF_MS);
                        continue;
                    }

                    emptyCount = 0;
                    this.log.debug("claimed outbox segment", { segmentId: segment.id, segmentPath: segment.path });
                    await this.sendSegment(segment);
                    await this.outbox.completeSegment(segment);
                    this.log.debug("completed outbox segment", { segmentId: segment.id });
                    await sleep(0);
                } catch (error) {
                    this.log.error("failed to drain outbox", {
                        segmentId: segment?.id,
                        ...errorContext(error),
                    });
                    if (segment) {
                        await this.outbox.releaseSegment(segment);
                        this.log.warn("released outbox segment after failure", { segmentId: segment.id });
                    }
                    this.closeSocket();
                    await sleep(ERROR_BACKOFF_MS);
                }
            }
        } finally {
            this.draining = false;
            this.log.debug("outbox drain stopped");
        }
    }

    private async ensureStartupSynced(): Promise<void> {
        if (this.startupSynced) {
            return;
        }
        if (this.startupSyncPromise) {
            await this.startupSyncPromise;
            if (this.startupSynced) {
                return;
            }
        }
        await this.runStartupSync();
    }

    private async runStartupSync(): Promise<void> {
        this.log.info("startup sync beginning", { lastPulledRevision: this.lastPulledRevision });
        const openWs = await this.ensureAuthenticatedSocket();
        const pullResponse = await this.pullSince(openWs, this.lastPulledRevision);

        if (pullResponse.type === opType.InitRequired) {
            this.log.info("server requires initial vault upload", { serverRevision: pullResponse.serverRevision });
            await this.uploadInitialSnapshot(openWs);
        } else if (pullResponse.type === opType.ChangeBatch) {
            this.log.info("startup pull returned change batch", {
                fromRevision: pullResponse.fromRevision,
                serverRevision: pullResponse.serverRevision,
                changes: pullResponse.changes.length,
                operations: summarizeServerChanges(pullResponse.changes),
            });
            await this.applyChangeBatch(pullResponse);
        } else if (pullResponse.type === opType.SnapshotReset) {
            this.log.warn("startup pull returned snapshot reset", {
                targetRevision: pullResponse.targetRevision,
                files: pullResponse.files.length,
            });
            await this.applySnapshotReset(pullResponse);
        } else {
            throw new Error(`Unexpected pull response: ${pullResponse.type}`);
        }
        this.startupSynced = true;
        this.recordConnectionSuccess();
        this.log.info("startup sync complete", { lastPulledRevision: this.lastPulledRevision });
    }

    private recordConnectionFailure(error: unknown): void {
        this.failedConnectAttempts++;
        const exponent = Math.min(this.failedConnectAttempts - 1, 6);
        const delay = Math.min(CONNECT_BACKOFF_INITIAL_MS * (2 ** exponent), CONNECT_BACKOFF_MAX_MS);
        this.nextConnectAt = Date.now() + delay;
        this.log.warn("sync client connection failed; retrying", {
            retryInMs: delay,
            failedConnectAttempts: this.failedConnectAttempts,
            ...errorContext(error),
        });
    }

    private recordConnectionSuccess(): void {
        this.failedConnectAttempts = 0;
        this.nextConnectAt = 0;
    }

    private async sendSegment(segment: OutboxSegment): Promise<void> {
        let openWs = await this.ensureAuthenticatedSocket();
        const jsonl = await this.prepareSegmentJsonl(openWs, segment);
        openWs = await this.ensureAuthenticatedSocket();
        const packet: wsPacket = {
            type: opType.UpdateBatch,
            segmentId: segment.id,
            jsonl,
        };
        const ack = withTimeout(
            this.waitForBatchAck(openWs, segment.id),
            WS_WAIT_TIMEOUT_MS,
            `Timed out waiting for batch ack (${segment.id})`,
        );
        this.log.debug("sending outbox segment", {
            segmentId: segment.id,
            bytes: jsonl.length,
        });
        openWs.send(encodePacket(packet));
        const revision = await ack;
        await this.persistLastPulledRevision(revision);
        this.log.info("outbox segment acknowledged", { segmentId: segment.id, revision });
    }

    private async uploadInitialSnapshot(ws: WebSocket): Promise<void> {
        const packet: wsPacket = {
            type: opType.InitUploadBatch,
            segmentId: `init-${Date.now()}`,
            changes: await this.readVaultSnapshot(),
        };
        this.log.info("uploading initial snapshot", {
            segmentId: packet.segmentId,
            changes: packet.changes.length,
            operations: summarizeMutations(packet.changes),
        });
        ws = await this.ensureAuthenticatedSocket();
        const ack = withTimeout(
            this.waitForBatchAck(ws, packet.segmentId),
            WS_WAIT_TIMEOUT_MS,
            `Timed out waiting for init upload ack (${packet.segmentId})`,
        );
        ws.send(encodePacket(packet));
        const revision = await ack;
        await this.persistLastPulledRevision(revision);
        this.log.info("initial snapshot acknowledged", { segmentId: packet.segmentId, revision });
    }

    private async readVaultSnapshot(): Promise<SyncMutation[]> {
        const created = Date.now();
        const changes: SyncMutation[] = [];
        const paths = await this.listSnapshotPaths();
        this.log.debug("reading vault snapshot", { paths: paths.length });

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
        }

        for (const entry of paths) {
            if (!entry.isFolder) {
                const isYjs = shouldUseYjs(entry.path, this.app.vault.configDir);
                if (isYjs) {
                    const loaded = this.app.vault.getAbstractFileByPath(entry.path);
                    const content = loaded instanceof TFile
                        ? await this.app.vault.read(loaded)
                        : await this.app.vault.adapter.read(entry.path);
                    let yjsState = await this.stateStore.get(entry.path);
                    if (!yjsState) {
                        yjsState = docStateFromContent(content, Y);
                        await this.stateStore.put(entry.path, yjsState);
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
                    continue;
                }

                const contentBytes = new Uint8Array(await this.app.vault.adapter.readBinary(entry.path));
                const base: SyncMutation = {
                    mutationId: crypto.randomUUID(),
                    operation: "UpsertFile",
                    path: entry.path,
                    isFolder: false,
                    isYjs: false,
                    byteSize: contentBytes.byteLength,
                    contentSha256: await sha256Hex(contentBytes),
                    created,
                };
                if (contentBytes.byteLength > INLINE_BYTES_LIMIT) {
                    await this.blobClient.upload(entry.path, contentBytes, base.contentSha256!);
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
            }
        }

        return changes;
    }

    private async listSnapshotPaths(): Promise<SnapshotPath[]> {
        const byPath = new Map<string, SnapshotPath>();
        for (const file of this.app.vault.getAllLoadedFiles()) {
            if (!shouldSyncPath(file.path, this.app.vault.configDir)) {
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
            if (shouldSyncPath(folder, this.app.vault.configDir)) {
                byPath.set(folder, { path: folder, isFolder: true });
                await this.addAdapterPaths(folder, byPath);
            }
        }
        for (const file of listed.files) {
            if (shouldSyncPath(file, this.app.vault.configDir)) {
                byPath.set(file, { path: file, isFolder: false });
            }
        }
    }

    private async applyChangeBatch(packet: Extract<wsPacket, { type: opType.ChangeBatch }>): Promise<void> {
        this.log.info("applying change batch", {
            fromRevision: packet.fromRevision,
            serverRevision: packet.serverRevision,
            changes: packet.changes.length,
            operations: summarizeServerChanges(packet.changes),
        });
        await this.applyServerChanges(packet.changes);
        await this.persistLastPulledRevision(packet.serverRevision);
    }

    private async applySnapshotReset(packet: Extract<wsPacket, { type: opType.SnapshotReset }>): Promise<void> {
        const snapshotPaths = new Set(packet.files.map(file => normalizePath(file.path)));
        const toDelete = [...this.app.vault.getFiles()]
            .filter(file => shouldSyncPath(file.path, this.app.vault.configDir) && !snapshotPaths.has(normalizePath(file.path)));
        const hasPendingChanges = await this.outbox.hasPendingChanges();
        this.log.warn("applying snapshot reset", {
            targetRevision: packet.targetRevision,
            files: packet.files.length,
            localFilesMissingFromSnapshot: toDelete.length,
            hasPendingChanges,
        });
        if (toDelete.length > 0 && hasPendingChanges) {
            new Notice(`Sync snapshot reset: preserving ${toDelete.length} local file(s) while pending changes upload`);
        } else if (toDelete.length > 0) {
            new Notice(`Sync snapshot reset: removing ${toDelete.length} local file(s) not on server`);
            await this.deletePathsMissingFromSnapshot(snapshotPaths);
        }
        await this.applyServerChanges(packet.files);
        await this.persistLastPulledRevision(packet.targetRevision);
    }

    private async applyServerChanges(changes: ServerChange[]): Promise<void> {
        this.applyingRemote = true;
        try {
            for (const change of changes) {
                if (
                    !shouldSyncPath(change.path, this.app.vault.configDir) ||
                    (change.toPath && !shouldSyncPath(change.toPath, this.app.vault.configDir))
                ) {
                    this.log.warn("skipping ignored remote change", {
                        revision: change.revision,
                        operation: change.operation,
                        path: change.path,
                        toPath: change.toPath,
                    });
                    continue;
                }
                this.log.debug("applying remote change", {
                    revision: change.revision,
                    operation: change.operation,
                    path: change.path,
                    toPath: change.toPath,
                    clientId: change.clientId,
                    storageKind: change.storageKind,
                    byteSize: change.byteSize,
                });
                if (change.operation === "CreateFolder") {
                    await this.ensureFolder(change.path);
                } else if (change.operation === "UpsertFile") {
                    if (change.storageKind === "lo") {
                        await this.upsertBinaryFile(change.path, await this.blobClient.download(change.path));
                    } else if (change.contentBytes) {
                        await this.upsertBinaryFile(change.path, change.contentBytes);
                    } else {
                        await this.upsertTextFile(change.path, change.content ?? "");
                        await this.refreshYjsState(change.path, change.content ?? "", change.yjsState);
                    }
                } else if (change.operation === "Delete") {
                    await this.deletePath(change.path);
                } else if (change.operation === "Rename" && change.toPath) {
                    await this.renamePath(change.path, change.toPath);
                } else if (change.operation === "YjsUpdate" && change.data) {
                    await this.applyYjsUpdate(change.path, change.data);
                }
            }
        } finally {
            this.applyingRemote = false;
        }
    }

    private async deletePathsMissingFromSnapshot(paths: Set<string>): Promise<void> {
        this.applyingRemote = true;
        try {
            const files = [...this.app.vault.getFiles()]
                .filter(file => shouldSyncPath(file.path, this.app.vault.configDir) && !paths.has(normalizePath(file.path)))
                .sort((a, b) => b.path.length - a.path.length);
            for (const file of files) {
                await this.app.fileManager.trashFile(file);
                await this.stateStore.delete(file.path);
            }
        } finally {
            this.applyingRemote = false;
        }
    }

    private async ensureFolder(path: string): Promise<void> {
        const normalized = normalizePath(path);
        if (!normalized || await this.app.vault.adapter.exists(normalized)) {
            return;
        }
        const parent = dirname(normalized);
        if (parent) {
            await this.ensureFolder(parent);
        }
        try {
            await this.app.vault.createFolder(normalized);
        } catch (error) {
            if (!(await this.app.vault.adapter.exists(normalized))) {
                throw error;
            }
        }
    }

    private async upsertTextFile(path: string, content: string): Promise<void> {
        const normalized = normalizePath(path);
        const parent = dirname(normalized);
        if (parent) {
            await this.ensureFolder(parent);
        }
        const existing = this.app.vault.getAbstractFileByPath(normalized);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, content);
            return;
        }
        if (existing) {
            await this.app.fileManager.trashFile(existing);
        }
        await this.app.vault.create(normalized, content);
    }

    private async upsertBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
        const normalized = normalizePath(path);
        const parent = dirname(normalized);
        if (parent) {
            await this.ensureFolder(parent);
        }
        const existing = this.app.vault.getAbstractFileByPath(normalized);
        if (existing instanceof TFile) {
            await this.app.vault.adapter.writeBinary(normalized, exactArrayBuffer(bytes));
            return;
        }
        if (existing) {
            await this.app.fileManager.trashFile(existing);
        }
        await this.app.vault.adapter.writeBinary(normalized, exactArrayBuffer(bytes));
    }

    private async deletePath(path: string): Promise<void> {
        const existing = this.app.vault.getAbstractFileByPath(normalizePath(path));
        if (existing) {
            await this.app.fileManager.trashFile(existing);
        }
        await this.stateStore.delete(path, existing instanceof TFolder);
    }

    private async renamePath(fromPath: string, toPath: string): Promise<void> {
        const existing = this.app.vault.getAbstractFileByPath(normalizePath(fromPath));
        if (!existing) {
            return;
        }
        const parent = dirname(toPath);
        if (parent) {
            await this.ensureFolder(parent);
        }
        await this.app.vault.rename(existing, normalizePath(toPath));
        await this.stateStore.rename(fromPath, toPath, existing instanceof TFolder);
    }

    private async applyYjsUpdate(path: string, update: Uint8Array): Promise<void> {
        const normalized = normalizePath(path);
        const openDoc = this.getDocSync(normalized);
        let content: string;
        let state: Uint8Array;
        if (openDoc) {
            content = openDoc.applyRemoteUpdate(update);
            state = Y.encodeStateAsUpdateV2(openDoc.getYdoc());
        } else {
            const doc = new Y.Doc();
            Y.applyUpdateV2(doc, await this.getOrSeedState(normalized));
            Y.applyUpdateV2(doc, update);
            content = doc.getText(MARKDOWN_FIELD).toJSON();
            state = Y.encodeStateAsUpdateV2(doc);
            doc.destroy();
        }
        await this.upsertTextFile(normalized, content);
        await this.stateStore.put(normalized, state);
    }

    private async readVaultContent(path: string): Promise<string> {
        const existing = this.app.vault.getAbstractFileByPath(path);
        return existing instanceof TFile ? this.app.vault.read(existing) : "";
    }

    private async refreshYjsState(path: string, content: string, yjsState?: Uint8Array): Promise<void> {
        if (!shouldUseYjs(path, this.app.vault.configDir)) {
            return;
        }
        const state = yjsState ?? docStateFromContent(content, Y);
        await this.stateStore.put(path, state);
        const openDoc = this.getDocSync(normalizePath(path));
        if (openDoc) {
            await openDoc.replaceState(state);
        }
    }

    private async getOrSeedState(path: string): Promise<Uint8Array> {
        const existing = await this.stateStore.get(path);
        if (existing) {
            return existing;
        }
        const state = docStateFromContent(await this.readVaultContent(path), Y);
        await this.stateStore.put(path, state);
        return state;
    }

    private async resolveYdoc(path: string): Promise<{ doc: Y.Doc; destroy: () => void }> {
        const normalized = normalizePath(path);
        const openDoc = this.getDocSync(normalized);
        if (openDoc) {
            return {
                doc: openDoc.getYdoc(),
                destroy: () => {},
            };
        }
        const doc = new Y.Doc();
        const loadedState = await this.getOrSeedState(normalized);
        Y.applyUpdateV2(doc, loadedState);
        return { doc, destroy: () => doc.destroy() };
    }

    private encodeMutationsJsonl(mutations: SyncMutation[]): string {
        if (mutations.length === 0) {
            return "";
        }
        return mutations.map((row, index) => JSON.stringify({
            ...row,
            id: index + 1,
            data: row.data ? bytesToBase64(row.data) : undefined,
            contentBytes: row.contentBytes ? bytesToBase64(row.contentBytes) : undefined,
        })).join("\n") + "\n";
    }

    private async prepareSegmentJsonl(ws: WebSocket, segment: OutboxSegment): Promise<string> {
        const inputRows = await this.outbox.readSegment(segment);
        const rows = inputRows.filter(row => {
            const shouldKeep = shouldSyncPath(row.path, this.app.vault.configDir) &&
                (!row.toPath || shouldSyncPath(row.toPath, this.app.vault.configDir));
            if (!shouldKeep) {
                this.log.warn("dropping ignored outbox row", {
                    segmentId: segment.id,
                    operation: row.operation,
                    path: row.path,
                    toPath: row.toPath,
                });
            }
            return shouldKeep;
        });
        this.log.debug("preparing outbox segment", {
            segmentId: segment.id,
            rows: inputRows.length,
            filteredRows: rows.length,
            operations: summarizeMutations(rows),
        });
        const yjsPaths = [...new Set(
            rows
                .filter(row => row.operation === "YjsUpdate")
                .map(row => row.path),
        )];

        const coalesced = new Map<string, SyncMutation>();
        if (yjsPaths.length > 0) {
            this.log.debug("coalescing Yjs updates before upload", {
                segmentId: segment.id,
                paths: yjsPaths,
            });
            const resolved: {
                path: string;
                doc: Y.Doc;
                destroy: () => void;
                stateVector: Uint8Array;
                created: number;
            }[] = [];

            for (const path of yjsPaths) {
                const pathRows = rows.filter(row => row.operation === "YjsUpdate" && row.path === path);
                const { doc, destroy } = await this.resolveYdoc(path);
                resolved.push({
                    path,
                    doc,
                    destroy,
                    stateVector: Y.encodeStateVector(doc),
                    created: Math.max(...pathRows.map(row => row.created)),
                });
            }

            try {
                const ack = await this.requestDocSync(
                    ws,
                    resolved.map(entry => ({
                        path: entry.path,
                        stateVector: entry.stateVector,
                        content: entry.doc.getText(MARKDOWN_FIELD).toJSON(),
                    })),
                );
                this.log.debug("received DocSync ack", {
                    segmentId: segment.id,
                    paths: ack.paths.map(path => path.path),
                });
                for (const entry of resolved) {
                    const syncResult = ack.paths.find(result => result.path === entry.path);
                    if (!syncResult) {
                        throw new Error(`DocSyncAck missing path ${entry.path}`);
                    }
                    let target = entry.doc.getText(MARKDOWN_FIELD).toJSON();
                    if (shouldApplyDocSyncCatchUp(target, syncResult.yjsState, syncResult.data)) {
                        Y.applyUpdateV2(entry.doc, syncResult.data);
                        target = entry.doc.getText(MARKDOWN_FIELD).toJSON();
                    }
                    const { upload, state } = buildUploadFromSyncedDoc(
                        entry.doc,
                        syncResult.stateVector,
                        syncResult.yjsState,
                        target,
                    );
                    await this.stateStore.put(entry.path, state);
                    const openDoc = this.getDocSync(entry.path);
                    if (openDoc) {
                        await openDoc.replaceState(state);
                    }
                    coalesced.set(entry.path, {
                        mutationId: crypto.randomUUID(),
                        operation: "YjsUpdate",
                        path: entry.path,
                        data: upload,
                        created: entry.created,
                    });
                }
            } finally {
                for (const entry of resolved) {
                    entry.destroy();
                }
            }
        }

        const pathsUploaded = new Set<string>();
        const output: SyncMutation[] = [];
        for (const row of rows) {
            if (row.operation !== "YjsUpdate") {
                let contentBytes = row.contentBytes;
                let storageKind = row.storageKind;
                let contentSha256 = row.contentSha256;
                let byteSize = row.byteSize;
                if (row.operation === "UpsertFile" && contentBytes && contentBytes.byteLength > INLINE_BYTES_LIMIT) {
                    contentSha256 = contentSha256 ?? await sha256Hex(contentBytes);
                    await this.blobClient.upload(row.path, contentBytes, contentSha256);
                    byteSize = contentBytes.byteLength;
                    contentBytes = undefined;
                    storageKind = "lo";
                }
                output.push({
                    mutationId: row.mutationId,
                    operation: row.operation,
                    path: row.path,
                    toPath: row.toPath,
                    content: row.content,
                    contentBytes,
                    data: row.data,
                    isFolder: row.isFolder,
                    isYjs: row.isYjs,
                    storageKind,
                    byteSize,
                    contentSha256,
                    created: row.created,
                });
                continue;
            }
            if (pathsUploaded.has(row.path)) {
                continue;
            }
            pathsUploaded.add(row.path);
            const merged = coalesced.get(row.path);
            if (merged) {
                output.push(merged);
            }
        }

        this.log.debug("prepared outbox segment payload", {
            segmentId: segment.id,
            inputRows: rows.length,
            outputRows: output.length,
            operations: summarizeMutations(output),
        });
        return this.encodeMutationsJsonl(output);
    }

    private requestDocSync(
        ws: WebSocket,
        paths: { path: string; stateVector: Uint8Array; content?: string }[],
    ): Promise<Extract<wsPacket, { type: opType.DocSyncAck }>> {
        const response = withTimeout(
            new Promise<Extract<wsPacket, { type: opType.DocSyncAck }>>((resolve, reject) => {
                const onMessage = (event: MessageEvent) => {
                    let msg: wsPacket;
                    try {
                        msg = decodePacket(readSocketMessage(event));
                    } catch (error) {
                        cleanup();
                        reject(asError(error));
                        return;
                    }

                    if (msg.type === opType.DocSyncAck) {
                        cleanup();
                        resolve(msg);
                        return;
                    }
                    if (msg.type === opType.Deny) {
                        cleanup();
                        reject(new Error(msg.message));
                    }
                };
                const onClose = () => {
                    cleanup();
                    reject(new Error("WebSocket closed before DocSync ack"));
                };
                const onError = () => {
                    cleanup();
                    reject(new Error("WebSocket errored before DocSync ack"));
                };
                const cleanup = () => {
                    ws.removeEventListener("message", onMessage);
                    ws.removeEventListener("close", onClose);
                    ws.removeEventListener("error", onError);
                };

                ws.addEventListener("message", onMessage);
                ws.addEventListener("close", onClose, { once: true });
                ws.addEventListener("error", onError, { once: true });
            }),
            WS_WAIT_TIMEOUT_MS,
            "Timed out waiting for DocSync ack",
        );
        this.log.debug("requesting DocSync", { paths: paths.map(path => path.path) });
        ws.send(encodePacket({ type: opType.DocSync, paths }));
        return response;
    }

    private async persistLastPulledRevision(revision: string): Promise<void> {
        if (BigInt(revision) <= BigInt(this.lastPulledRevision)) {
            this.log.debug("skipping stale revision persist", {
                revision,
                lastPulledRevision: this.lastPulledRevision,
            });
            return;
        }
        this.lastPulledRevision = revision;
        await this.onLastPulledRevisionChanged(revision);
    }

    private async ensureAuthenticatedSocket(): Promise<WebSocket> {
        if (this.authPromise) {
            return this.authPromise;
        }

        this.authPromise = this.authenticateSocket();
        try {
            return await this.authPromise;
        } finally {
            this.authPromise = null;
        }
    }

    private async authenticateSocket(): Promise<WebSocket> {
        const openWs = await this.ensureSocket();
        if (this.authenticated) {
            return openWs;
        }

        this.log.debug("authenticating websocket", { lastPulledRevision: this.lastPulledRevision });
        const authPacket: wsPacket = {
            type: opType.Auth,
            clientId: this.clientId,
            clientKey: this.clientKey,
            clientName: this.clientName,
            protocolVersion: PROTOCOL_VERSION,
            lastPulledRevision: this.lastPulledRevision,
        };
        const ack = withTimeout(
            this.waitForAuthAck(openWs),
            WS_WAIT_TIMEOUT_MS,
            "Timed out waiting for auth ack",
        );
        openWs.send(encodePacket(authPacket));
        const packet = await ack;
        if (!packet || packet.type !== opType.AuthAck) {
            throw new Error("Backend did not acknowledge authentication");
        }

        if (!packet.newClientKey.startsWith("obs_sync_")) {
            throw new Error("Backend returned an invalid client key");
        }
        if (packet.newClientKey !== this.clientKey) {
            await this.onClientKeyRotated(packet.newClientKey);
            this.clientKey = packet.newClientKey;
            this.blobClient.update(this.httpBackendUrl(), this.clientKey);
            this.log.info("client key rotated");
        }

        this.authenticated = true;
        this.log.info("websocket authenticated", { serverRevision: packet.serverRevision });
        return openWs;
    }

    private async refreshBlobAuth(): Promise<string> {
        const wasStartupSynced = this.startupSynced;
        this.log.warn("refreshing blob auth after unauthorized response");
        this.closeSocket();
        await this.ensureAuthenticatedSocket();
        this.startupSynced = wasStartupSynced;
        return this.clientKey;
    }

    private httpBackendUrl(): string {
        const url = new URL(this.serverUrl);
        url.protocol = url.protocol === "wss:" ? "https:" : "http:";
        url.pathname = "";
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/$/, "");
    }

    private async pullSince(ws: WebSocket, revision: string): Promise<wsPacket> {
        const response = withTimeout(
            this.waitForPullResponse(ws),
            WS_WAIT_TIMEOUT_MS,
            "Timed out waiting for pull response",
        );
        ws.send(encodePacket({ type: opType.PullSince, revision }));
        return response;
    }

    private async ensureSocket(): Promise<WebSocket> {
        if (this.ws?.readyState === WebSocket.OPEN) {
            return this.ws;
        }

        if (this.ws?.readyState === WebSocket.CONNECTING) {
            await this.waitForOpen(this.ws);
            return this.ws;
        }

        this.closeSocket();
        this.log.debug("opening websocket", { serverUrl: this.serverUrl });
        const nextWs = new WebSocket(this.serverUrl);
        this.ws = nextWs;
        nextWs.addEventListener("close", () => {
            if (this.ws === nextWs) {
                this.ws = null;
                this.authenticated = false;
                this.startupSynced = false;
            }
            this.log.debug("websocket closed");
        });
        nextWs.addEventListener("message", event => {
            try {
                const msg = decodePacket(readSocketMessage(event));
                if (msg.type === opType.BootstrapStatus) {
                    this.onBootstrapStatus(msg);
                    return;
                }
                if (msg.type === opType.ChangeBatch || msg.type === opType.SnapshotReset) {
                    this.handleLivePush(msg);
                }
            } catch {
                // Request-specific listeners surface protocol errors.
            }
        });

        await this.waitForOpen(nextWs);
        this.log.debug("websocket opened");
        return nextWs;
    }

    private handleLivePush(packet: Extract<wsPacket, { type: opType.ChangeBatch | opType.SnapshotReset }>): void {
        if (!this.startupSynced || this.stopped) {
            return;
        }

        this.livePushPromise = this.livePushPromise
            .catch(() => {})
            .then(async () => {
                if (!this.startupSynced || this.stopped) {
                    return;
                }
                if (packet.type === opType.ChangeBatch) {
                    if (BigInt(packet.serverRevision) <= BigInt(this.lastPulledRevision)) {
                        return;
                    }
                    await this.applyChangeBatch(packet);
                    this.log.info("applied live change batch", {
                        fromRevision: packet.fromRevision,
                        serverRevision: packet.serverRevision,
                        changes: packet.changes.length,
                    });
                    return;
                }

                if (BigInt(packet.targetRevision) <= BigInt(this.lastPulledRevision)) {
                    return;
                }
                await this.applySnapshotReset(packet);
                this.log.info("applied live snapshot reset", {
                    targetRevision: packet.targetRevision,
                    files: packet.files.length,
                });
            })
            .catch(error => {
                this.log.error("failed to apply live server push", errorContext(error));
                this.closeSocket();
                this.connectSoon();
            });
    }

    private waitForOpen(ws: WebSocket): Promise<void> {
        if (ws.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }

        return new Promise((resolve, reject) => {
            const onOpen = () => {
                cleanup();
                resolve();
            };
            const onError = () => {
                cleanup();
                reject(new Error("WebSocket failed to connect"));
            };
            const onClose = () => {
                cleanup();
                reject(new Error("WebSocket closed before opening"));
            };
            const cleanup = () => {
                ws.removeEventListener("open", onOpen);
                ws.removeEventListener("error", onError);
                ws.removeEventListener("close", onClose);
            };

            ws.addEventListener("open", onOpen, { once: true });
            ws.addEventListener("error", onError, { once: true });
            ws.addEventListener("close", onClose, { once: true });
        });
    }

    private waitForBatchAck(ws: WebSocket, segmentId: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const onMessage = (event: MessageEvent) => {
                let msg: wsPacket;
                try {
                    msg = decodePacket(readSocketMessage(event));
                } catch (error) {
                    cleanup();
                    reject(asError(error));
                    return;
                }

                if (msg.type === opType.BatchAck && msg.segmentId === segmentId) {
                    cleanup();
                    resolve(msg.revision);
                    return;
                }
                if (msg.type === opType.Deny) {
                    cleanup();
                    reject(new Error(msg.message));
                }
            };
            const onClose = () => {
                cleanup();
                reject(new Error("WebSocket closed before batch ack"));
            };
            const onError = () => {
                cleanup();
                reject(new Error("WebSocket errored before batch ack"));
            };
            const cleanup = () => {
                ws.removeEventListener("message", onMessage);
                ws.removeEventListener("close", onClose);
                ws.removeEventListener("error", onError);
            };

            ws.addEventListener("message", onMessage);
            ws.addEventListener("close", onClose, { once: true });
            ws.addEventListener("error", onError, { once: true });
        });
    }

    private waitForPullResponse(ws: WebSocket): Promise<wsPacket> {
        return new Promise((resolve, reject) => {
            const onMessage = (event: MessageEvent) => {
                let msg: wsPacket;
                try {
                    msg = decodePacket(readSocketMessage(event));
                } catch (error) {
                    cleanup();
                    reject(asError(error));
                    return;
                }

                if (
                    msg.type === opType.InitRequired ||
                    msg.type === opType.ChangeBatch ||
                    msg.type === opType.SnapshotReset
                ) {
                    cleanup();
                    resolve(msg);
                    return;
                }
                if (msg.type === opType.Deny) {
                    cleanup();
                    reject(new Error(msg.message));
                }
            };
            const onClose = () => {
                cleanup();
                reject(new Error("WebSocket closed before pull response"));
            };
            const onError = () => {
                cleanup();
                reject(new Error("WebSocket errored before pull response"));
            };
            const cleanup = () => {
                ws.removeEventListener("message", onMessage);
                ws.removeEventListener("close", onClose);
                ws.removeEventListener("error", onError);
            };

            ws.addEventListener("message", onMessage);
            ws.addEventListener("close", onClose, { once: true });
            ws.addEventListener("error", onError, { once: true });
        });
    }

    private waitForAuthAck(ws: WebSocket): Promise<wsPacket | null> {
        return new Promise((resolve, reject) => {
            const onMessage = (event: MessageEvent) => {
                let msg: wsPacket;
                try {
                    msg = decodePacket(readSocketMessage(event));
                } catch (error) {
                    cleanup();
                    reject(asError(error));
                    return;
                }

                cleanup();
                if (msg.type === opType.AuthAck) {
                    resolve(msg);
                    return;
                }
                if (msg.type === opType.Deny) {
                    new Notice(msg.message);
                    resolve(null);
                    return;
                }
                resolve(null);
            };
            const onClose = () => {
                cleanup();
                reject(new Error("WebSocket closed before auth ack"));
            };
            const onError = () => {
                cleanup();
                reject(new Error("WebSocket errored before auth ack"));
            };
            const cleanup = () => {
                ws.removeEventListener("message", onMessage);
                ws.removeEventListener("close", onClose);
                ws.removeEventListener("error", onError);
            };

            ws.addEventListener("message", onMessage);
            ws.addEventListener("close", onClose, { once: true });
            ws.addEventListener("error", onError, { once: true });
        });
    }

    private closeSocket(): void {
        this.authenticated = false;
        this.authPromise = null;
        this.startupSynced = false;
        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
            this.log.debug("closing websocket", { readyState: this.ws.readyState });
            this.ws.close();
        }
        this.ws = null;
    }
}
