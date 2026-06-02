import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import * as Y from "yjs";
import { OutboxSegment, OutboxStore } from "db/db";
import { BootstrapStatus, EditorPresence, EditorPresencePosition, opType, ServerChange, SyncMutation, wsPacket } from "../../../shared/types";
import { decodePacket, encodePacket, encodeUpdateBatchJsonl, PROTOCOL_VERSION } from "../../../shared/protocol";
import { docStateFromContent, MARKDOWN_FIELD } from "../../../shared/yjsSeed";
import { buildUploadFromSyncedDoc, shouldApplyDocSyncCatchUp } from "../../../shared/yjsUpload";
import { shouldSyncPath, shouldUseYjs } from "../../../shared/pathPolicy";
import { SyncEngineSettings } from "../settings";
import { DocSync } from "../yjs/DocSync";
import { YjsStateStore } from "../yjs/YjsStateStore";
import { BlobClient } from "./BlobClient";
import { BootstrapUploader } from "./BootstrapUploader";
import { exactArrayBuffer, VaultMutator } from "./VaultMutator";
import { YjsApplicator } from "./YjsApplicator";
import { errorContext, Logger } from "../../../shared/logger";
import { log as rootLog } from "../logger";
import { readSocketMessage, waitForPacket, withTimeout } from "./SocketRequest";

const FLUSH_DELAY_MS = 0;
const ERROR_BACKOFF_MS = 2000;
const CONNECT_RETRY_DELAY_MS = 2000;
const WS_WAIT_TIMEOUT_MS = 60_000;
const INLINE_BYTES_LIMIT = 16 * 1024;
const FAILURE_NOTICE_THROTTLE_MS = 60_000;
const REVISION_SAVE_DEBOUNCE_MS = 1000;

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

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function shortErrorMessage(error: unknown): string {
    return asError(error).message;
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

function remoteChangePaths(change: ServerChange): string[] {
    return change.toPath ? [change.path, change.toPath] : [change.path];
}

function copyEditorPresencePosition(position: EditorPresencePosition): EditorPresencePosition {
    return {
        line: position.line,
        ch: position.ch,
    };
}

type SnapshotPath = {
    path: string;
    isFolder: boolean;
};

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
    private lastUploadedRevisionHint: string;
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
    private livePushBacklog: Extract<wsPacket, { type: opType.ChangeBatch | opType.SnapshotReset }>[] = [];
    private refreshAuthPromise: Promise<string> | null = null;
    private catchUpPromise: Promise<void> | null = null;
    private pendingPullResponses = 0;
    private lastFailureNoticeAt = 0;
    private pendingLastPulledRevision: string | null = null;
    private revisionFlushTimer: number | null = null;
	private startupDocSyncPaths = new Set<string>();
    private readonly vaultMutator: VaultMutator;
    private readonly yjsApplicator: YjsApplicator;
    private readonly bootstrapUploader: BootstrapUploader;

    constructor(
        private readonly app: App,
        private readonly outbox: OutboxStore,
        private readonly stateStore: YjsStateStore,
        settings: SyncEngineSettings,
        private readonly onClientKeyRotated: (clientKey: string) => Promise<void> = async () => {},
        private readonly onLastPulledRevisionChanged: (revision: string) => Promise<void> = async () => {},
        private readonly getDocSync: (path: string) => DocSync | undefined = () => undefined,
        private readonly onBootstrapStatus: (status: BootstrapStatus) => void = () => {},
        private readonly onStartupSynced: () => void = () => {},
        private readonly onRemoteConfigApplied: (path: string, bytes: Uint8Array) => void = () => {},
        private readonly onRemotePluginFilesChanged: () => void = () => {},
        private readonly onOpenYjsContent: (path: string, content: string) => Promise<boolean> = async () => false,
        private readonly flushOpenYjsChanges: (path: string) => Promise<void> = async () => {},
        private readonly onEditorPresence: (presence: EditorPresence) => void = () => {},
        private readonly onEditorPresenceDisconnect: (clientId: string) => void = () => {},
        private readonly onEditorPresenceReset: () => void = () => {},
        private readonly pluginId = "obsidian-sync-engine",
    ) {
        this.serverUrl = toWebSocketUrl(settings.backendUrl);
        this.clientId = settings.clientId;
        this.clientKey = settings.clientKey;
        this.clientName = settings.clientName;
        this.lastPulledRevision = settings.lastPulledRevision;
        this.lastUploadedRevisionHint = settings.lastPulledRevision;
        this.blobClient = new BlobClient(settings.backendUrl, settings.clientKey, () => this.refreshBlobAuth());
        this.vaultMutator = new VaultMutator(app, stateStore);
        this.yjsApplicator = new YjsApplicator({
            stateStore,
            vaultMutator: this.vaultMutator,
            readVaultContent: path => this.readVaultContent(path),
            getDocSync,
            onOpenYjsContent,
            flushOpenYjsChanges,
        });
        this.log = rootLog.child({
            clientId: this.clientId.slice(0, 18),
            clientName: this.clientName,
        });
        this.bootstrapUploader = new BootstrapUploader(
            app,
            stateStore,
            settings,
            () => this.ensureAuthenticatedSocket(),
            this.log,
            this.onBootstrapStatus,
            pluginId,
        );
    }

    isApplyingRemoteChanges(path?: string): boolean {
        if (path) {
            return this.vaultMutator.isApplyingRemoteChanges(path);
        }
        return this.applyingRemote || this.vaultMutator.isApplyingRemoteChanges();
    }

    private isSyncableConfigPath(path: string): boolean {
        const configDir = this.app.vault.configDir.replace(/^\/+|\/+$/g, "");
        const normalized = normalizePath(path);
        return (
            (normalized === configDir || normalized.startsWith(`${configDir}/`))
            && shouldSyncPath(normalized, this.app.vault.configDir, this.pluginId)
            && !shouldUseYjs(normalized, this.app.vault.configDir)
        );
    }

    private shouldSyncLocalPath(path: string): boolean {
        const normalized = normalizePath(path);
        return shouldSyncPath(normalized, this.app.vault.configDir, this.pluginId);
    }

    private isPluginConfigPath(path: string): boolean {
        const configDir = this.app.vault.configDir.replace(/^\/+|\/+$/g, "");
        const normalized = normalizePath(path);
        return normalized === `${configDir}/plugins` || normalized.startsWith(`${configDir}/plugins/`);
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
            if (this.startupSynced) {
                void this.catchUpToServer().catch(error => {
                    this.log.warn("periodic sync catch-up failed", errorContext(error));
                    this.closeSocket();
                    this.connectSoon();
                });
                return;
            }
            this.connectSoon();
        }, CONNECT_RETRY_DELAY_MS);
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
        if (this.revisionFlushTimer !== null) {
            globalThis.clearTimeout(this.revisionFlushTimer);
            this.revisionFlushTimer = null;
        }
        void this.flushPendingLastPulledRevision().catch(error => {
            this.log.error("failed to flush last pulled revision on stop", errorContext(error));
        });
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
        this.lastUploadedRevisionHint = settings.lastPulledRevision;
        this.blobClient.update(settings.backendUrl, settings.clientKey);
        this.bootstrapUploader.update(settings);
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

    async uploadBlob(path: string, bytes: Uint8Array): Promise<{ blobUploadId: string; byteSize: number; contentSha256: string }> {
        await this.ensureAuthenticatedSocket();
        const contentSha256 = await sha256Hex(bytes);
        this.log.debug("uploading blob", { path, byteSize: bytes.byteLength, contentSha256 });
        const upload = await this.blobClient.upload(path, bytes, contentSha256, this.clientId);
        return { blobUploadId: upload.uploadId, byteSize: bytes.byteLength, contentSha256 };
    }

    sendEditorPresence(
        path: string,
        positions: Pick<EditorPresence, "from" | "to" | "head" | "anchor">,
        color: string,
    ): void {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN || !this.authenticated) {
            return;
        }
        try {
            ws.send(encodePacket({
                type: opType.EditorPresenceUpdate,
                clientId: this.clientId,
                clientName: this.clientName,
                path,
                from: copyEditorPresencePosition(positions.from),
                to: copyEditorPresencePosition(positions.to),
                head: copyEditorPresencePosition(positions.head),
                anchor: copyEditorPresencePosition(positions.anchor),
                color,
            }));
        } catch (error) {
            this.log.warn("failed to send editor presence", { path, ...errorContext(error) });
        }
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
        if (this.stopped || this.startupSyncPromise || !this.startupSynced) {
            return;
        }
        if (this.flushTimer !== null) {
            window.clearTimeout(this.flushTimer);
        }

        this.flushTimer = window.setTimeout(() => {
            this.flushTimer = null;
            void this.drainOutbox();
        }, FLUSH_DELAY_MS);
    }

    async drainOutbox(): Promise<void> {
        if (this.draining || this.stopped || this.startupSyncPromise || !this.startupSynced) {
            return;
        }

        this.draining = true;
        this.log.debug("outbox drain starting");
        try {
            while (!this.stopped && this.startupSynced) {
                let segment: OutboxSegment | null = null;
                try {
                    await this.livePushPromise.catch(() => {});
                    if (this.stopped || !this.startupSynced) {
                        return;
                    }
                    segment = await this.outbox.claimNextSegment(true);
                    if (!segment) {
                        return;
                    }

                    this.log.debug("claimed outbox segment", { segmentId: segment.id, segmentPath: segment.path });
                    await this.sendSegment(segment);
                    await this.outbox.completeSegment(segment);
                    this.log.debug("completed outbox segment", { segmentId: segment.id });
                    await this.livePushPromise.catch(() => {});
                    if (this.stopped || !this.startupSynced) {
                        return;
                    }
                    await this.catchUpToServer();
                    await sleep(0);
                } catch (error) {
                    this.log.error("failed to drain outbox", {
                        segmentId: segment?.id,
                        ...errorContext(error),
                    });
                    this.showFailureNotice(`Sync upload failed; retrying: ${shortErrorMessage(error)}`);
                    if (segment) {
                        await this.outbox.releaseSegment(segment);
                        this.log.warn("released outbox segment after failure", { segmentId: segment.id });
                    }
                    this.closeSocket();
                    await sleep(ERROR_BACKOFF_MS);
                    if (!this.startupSynced) {
                        return;
                    }
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
		this.startupDocSyncPaths.clear();
        const openWs = await this.ensureAuthenticatedSocket();
        const pullResponse = await this.pullSince(openWs, this.lastPulledRevision);

        if (pullResponse.type === opType.InitRequired) {
            this.log.info("server requires bootstrap upload", { serverRevision: pullResponse.serverRevision });
            const revision = await this.bootstrapUploader.uploadAuthoritativeSnapshot();
            await this.persistLastPulledRevision(revision);
        } else if (pullResponse.type === opType.ChangeBatch) {
            this.log.info("startup pull returned change batch", {
                fromRevision: pullResponse.fromRevision,
                serverRevision: pullResponse.serverRevision,
                changes: pullResponse.changes.length,
                operations: summarizeServerChanges(pullResponse.changes),
            });
            await this.applyChangeBatch(pullResponse);
        } else if (pullResponse.type === opType.SnapshotReset) {
            if (BigInt(pullResponse.targetRevision) <= BigInt(this.lastPulledRevision)) {
                this.log.info("startup pull snapshot already applied", {
                    targetRevision: pullResponse.targetRevision,
                    lastPulledRevision: this.lastPulledRevision,
                });
            } else {
                this.log.warn("startup pull returned snapshot reset", {
                    targetRevision: pullResponse.targetRevision,
                    files: pullResponse.files.length,
                });
                await this.applySnapshotReset(pullResponse);
            }
        } else {
            throw new Error(`Unexpected pull response: ${pullResponse.type}`);
        }
        await this.catchUpToServer(openWs);
        await this.flushPendingOutboxForStartup();
        await this.catchUpToServer(openWs);
        this.startupSynced = true;
        this.recordConnectionSuccess();
        this.drainLivePushBacklog();
        await this.livePushPromise.catch(() => {});
        await this.catchUpToServer(openWs);
        await this.flushPendingLastPulledRevision();
		this.startupDocSyncPaths.clear();
        this.log.info("startup sync complete", { lastPulledRevision: this.lastPulledRevision });
        this.onStartupSynced();
    }

    private async flushPendingOutboxForStartup(): Promise<void> {
        if (!(await this.outbox.hasPendingChanges())) {
            return;
        }
        this.log.info("flushing pending outbox after startup pull");
        while (!this.stopped && await this.outbox.hasPendingChanges()) {
            const segment = await this.outbox.claimNextSegment(true);
            if (!segment) {
                return;
            }
            try {
                await this.sendSegment(segment);
                await this.outbox.completeSegment(segment);
            } catch (error) {
                await this.outbox.releaseSegment(segment);
                throw error;
            }
        }
    }

    private async catchUpToServer(openWs?: WebSocket): Promise<void> {
        if (!openWs && this.catchUpPromise) {
            return this.catchUpPromise;
        }
        const work = this.runCatchUpToServer(openWs);
        if (!openWs) {
            this.catchUpPromise = work.finally(() => {
                this.catchUpPromise = null;
            });
            return this.catchUpPromise;
        }
        return work;
    }

    private async runCatchUpToServer(openWs?: WebSocket): Promise<void> {
        if (this.stopped) {
            return;
        }
        let ws = openWs ?? await this.ensureAuthenticatedSocket();
        for (let attempt = 0; attempt < 20; attempt++) {
            const before = this.lastPulledRevision;
            const packet = await this.pullSince(ws, before);
            if (packet.type === opType.InitRequired) {
                await this.uploadInitialSnapshot(ws);
            } else if (packet.type === opType.ChangeBatch) {
                if (packet.changes.length === 0) {
                    return;
                }
                await this.applyChangeBatch(packet);
            } else if (packet.type === opType.SnapshotReset) {
                if (BigInt(packet.targetRevision) <= BigInt(this.lastPulledRevision)) {
                    return;
                }
                await this.applySnapshotReset(packet);
            } else {
                throw new Error(`Unexpected pull response: ${packet.type}`);
            }
            if (this.lastPulledRevision === before) {
                return;
            }
            ws = await this.ensureAuthenticatedSocket();
        }
        throw new Error("Sync catch-up did not converge");
    }

    private recordConnectionFailure(error: unknown): void {
        this.failedConnectAttempts++;
        const delay = CONNECT_RETRY_DELAY_MS;
        this.nextConnectAt = Date.now() + delay;
        this.log.warn("sync client connection failed; retrying", {
            retryInMs: delay,
            failedConnectAttempts: this.failedConnectAttempts,
            ...errorContext(error),
        });
        this.showFailureNotice(
            `Sync startup failed; retrying in ${Math.ceil(delay / 1000)}s: ${shortErrorMessage(error)}`,
        );
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
        this.recordUploadAckRevision(revision);
        this.log.info("outbox segment acknowledged", { segmentId: segment.id, revision });
    }

    private async uploadInitialSnapshot(ws: WebSocket): Promise<string> {
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
        this.recordUploadAckRevision(revision);
        this.log.info("initial snapshot acknowledged", { segmentId: packet.segmentId, revision });
        return revision;
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
                    const { yjsState } = await this.localMarkdownState(entry.path, content);
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
                    try {
                        const upload = await this.blobClient.upload(
                            entry.path,
                            contentBytes,
                            base.contentSha256!,
                            this.clientId,
                        );
                        changes.push({
                            ...base,
                            storageKind: "lo",
                            blobUploadId: upload.uploadId,
                        });
                    } catch (error) {
                        this.log.error("skipping large file during initial snapshot after blob upload failure", {
                            path: entry.path,
                            byteSize: contentBytes.byteLength,
                            ...errorContext(error),
                        });
                        this.showFailureNotice(
                            `Sync skipped a large file during initial upload: ${entry.path} (${shortErrorMessage(error)})`,
                        );
                        continue;
                    }
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

    private async localMarkdownState(path: string, content: string): Promise<{ yjsState: Uint8Array; contentHash: string }> {
        const contentHash = await sha256Hex(new TextEncoder().encode(content));
        const cachedHash = await this.stateStore.getContentHash(path);
        let yjsState = await this.stateStore.get(path);
        if (!yjsState || cachedHash !== contentHash) {
            yjsState = docStateFromContent(content, Y);
            await this.stateStore.putWithContentHash(path, yjsState, contentHash);
        }
        return { yjsState, contentHash };
    }

    private async listSnapshotPaths(): Promise<SnapshotPath[]> {
        const byPath = new Map<string, SnapshotPath>();
        for (const file of this.app.vault.getAllLoadedFiles()) {
            if (!this.shouldSyncLocalPath(file.path)) {
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
            if (this.shouldSyncLocalPath(folder)) {
                byPath.set(folder, { path: folder, isFolder: true });
                await this.addAdapterPaths(folder, byPath);
            }
        }
        for (const file of listed.files) {
            if (this.shouldSyncLocalPath(file)) {
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
        const unappliedChanges = packet.changes.filter(change => BigInt(change.revision) > BigInt(this.lastPulledRevision));
        if (unappliedChanges.length === 0) {
            this.log.debug("change batch contained no unapplied changes", {
                fromRevision: packet.fromRevision,
                serverRevision: packet.serverRevision,
                lastPulledRevision: this.lastPulledRevision,
            });
            return;
        }
        await this.applyServerChanges(unappliedChanges);
        const appliedRevision = unappliedChanges.reduce((max, change) => {
            return BigInt(change.revision) > BigInt(max) ? change.revision : max;
        }, packet.fromRevision);
        await this.persistLastPulledRevision(appliedRevision);
    }

    private async applySnapshotReset(packet: Extract<wsPacket, { type: opType.SnapshotReset }>): Promise<void> {
        if (BigInt(packet.targetRevision) <= BigInt(this.lastPulledRevision)) {
            this.log.debug("skipping snapshot reset; revision already current", {
                targetRevision: packet.targetRevision,
                lastPulledRevision: this.lastPulledRevision,
            });
            return;
        }
        const snapshotPaths = new Set(packet.files.map(file => normalizePath(file.path)));
        const toDelete = await this.localPathsMissingFromSnapshot(snapshotPaths);
        const hasPendingChanges = await this.outbox.hasPendingChanges();
        this.log.warn("applying snapshot reset", {
            targetRevision: packet.targetRevision,
            files: packet.files.length,
            localFilesMissingFromSnapshot: toDelete.length,
            hasPendingChanges,
        });
        const isFirstSync = this.lastPulledRevision === "0";
        let removedPluginFiles = false;
        if (toDelete.length > 0 && (hasPendingChanges || isFirstSync)) {
            const reason = isFirstSync ? "during first sync" : "while pending changes upload";
            new Notice(`Sync snapshot reset: preserving ${toDelete.length} local file(s) ${reason}`);
            this.log.warn("preserved local files missing from snapshot", {
                targetRevision: packet.targetRevision,
                files: toDelete.length,
                reason,
            });
        } else if (toDelete.length > 0) {
            removedPluginFiles = toDelete.some(entry => this.isPluginConfigPath(entry.path));
            new Notice(`Sync snapshot reset: removing ${toDelete.length} local file(s) not on server`);
            await this.deletePathsMissingFromSnapshot(snapshotPaths);
        }
        const appliedPluginFiles = await this.applyServerChanges(packet.files);
        if (removedPluginFiles && !appliedPluginFiles) {
            this.onRemotePluginFilesChanged();
        }
        await this.persistLastPulledRevision(packet.targetRevision);
    }

    private async applyServerChanges(changes: ServerChange[]): Promise<boolean> {
        this.applyingRemote = true;
        let remotePluginFilesChanged = false;
        try {
            for (const change of changes) {
                if (
                    !this.shouldSyncLocalPath(change.path) ||
                    (change.toPath && !this.shouldSyncLocalPath(change.toPath))
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
                if (change.clientId === this.clientId) {
                    this.log.debug("skipping echoed local change", {
                        revision: change.revision,
                        operation: change.operation,
                        path: change.path,
                    });
                    continue;
                }
                const changePaths = remoteChangePaths(change);
				if (!this.startupSynced) {
					for (const path of changePaths) {
						this.startupDocSyncPaths.add(path);
					}
				}
                await this.vaultMutator.runRemoteMutation(remoteChangePaths(change), async () => {
                    if (change.operation === "CreateFolder") {
                        await this.vaultMutator.ensureFolder(change.path);
                    } else if (change.operation === "UpsertFile") {
                        let appliedBytes: Uint8Array | null = null;
                        if (change.storageKind === "lo") {
                            appliedBytes = await this.blobClient.download(change.path);
                            await this.vaultMutator.upsertBinaryFile(change.path, appliedBytes);
                        } else if (change.contentBytes) {
                            appliedBytes = change.contentBytes;
                            await this.vaultMutator.upsertBinaryFile(change.path, change.contentBytes);
                        } else if (change.isYjs) {
                            const content = change.content ?? "";
                            await this.yjsApplicator.applyState(change.path, change.yjsState ?? docStateFromContent(content, Y), change.revision);
                        } else {
                            const content = change.content ?? "";
                            appliedBytes = new TextEncoder().encode(content);
                            await this.vaultMutator.upsertTextFile(change.path, content);
                        }
                        if (appliedBytes && this.isSyncableConfigPath(change.path)) {
                            this.onRemoteConfigApplied(change.path, appliedBytes);
                        }
                    } else if (change.operation === "Delete") {
                        await this.vaultMutator.deletePath(change.path);
                    } else if (change.operation === "Rename" && change.toPath) {
                        await this.vaultMutator.renamePath(change.path, change.toPath);
                    } else if (change.operation === "YjsUpdate") {
                        if (change.yjsState) {
                            await this.yjsApplicator.applyState(change.path, change.yjsState, change.revision);
                        } else if (change.data) {
                            await this.yjsApplicator.applyUpdate(change.path, change.data, change.revision);
                        }
                    }
                });
                if (changePaths.some(path => this.isPluginConfigPath(path))) {
                    remotePluginFilesChanged = true;
                }
            }
        } finally {
            this.applyingRemote = false;
        }
        if (remotePluginFilesChanged) {
            this.onRemotePluginFilesChanged();
        }
        return remotePluginFilesChanged;
    }

    private async deletePathsMissingFromSnapshot(paths: Set<string>): Promise<void> {
        const entries = await this.localPathsMissingFromSnapshot(paths);
        await this.vaultMutator.runRemoteMutation(entries.map(entry => entry.path), async () => {
            for (const entry of entries) {
                await this.vaultMutator.deletePath(entry.path);
            }
        });
    }

    private async localPathsMissingFromSnapshot(paths: Set<string>): Promise<SnapshotPath[]> {
        return (await this.listSnapshotPaths())
            .filter(entry => this.shouldSyncLocalPath(entry.path) && !paths.has(normalizePath(entry.path)))
            .sort((a, b) => {
                if (a.path.length !== b.path.length) {
                    return b.path.length - a.path.length;
                }
                if (a.isFolder !== b.isFolder) {
                    return a.isFolder ? 1 : -1;
                }
                return b.path.localeCompare(a.path);
            });
    }

    private async readVaultContent(path: string): Promise<string> {
        const existing = this.app.vault.getAbstractFileByPath(path);
        return existing instanceof TFile ? this.app.vault.read(existing) : "";
    }

    private async prepareSegmentJsonl(ws: WebSocket, segment: OutboxSegment): Promise<string> {
        const inputRows = await this.outbox.readSegment(segment);
        const rows = inputRows.filter(row => {
            const shouldKeep = this.shouldSyncLocalPath(row.path) &&
                (!row.toPath || this.shouldSyncLocalPath(row.toPath));
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
        const docSyncPaths: string[] = [];
		for (const path of yjsPaths) {
			const pathRows = rows.filter(row => row.operation === "YjsUpdate" && row.path === path);
			const updates = pathRows.map(row => row.data).filter((data): data is Uint8Array => data instanceof Uint8Array);
			const openDoc = this.getDocSync(path);
			if (
				!this.startupDocSyncPaths.has(path) &&
				openDoc?.hasServerSyncedState() &&
				!openDoc.requiresDocSyncBeforeUpload() &&
				updates.length === pathRows.length &&
				updates.length > 0 &&
				updates.every(update => update.byteLength > 0)
			) {
				coalesced.set(path, {
					mutationId: crypto.randomUUID(),
					operation: "YjsUpdate",
					path,
					data: updates.length === 1 ? updates[0] : Y.mergeUpdatesV2(updates),
					created: Math.max(...pathRows.map(row => row.created)),
				});
			} else {
				docSyncPaths.push(path);
			}
		}

        if (docSyncPaths.length > 0) {
            this.log.debug("coalescing Yjs updates before upload", {
                segmentId: segment.id,
                paths: docSyncPaths,
            });
            const resolved: {
                path: string;
                doc: Y.Doc;
                destroy: () => void;
                stateVector: Uint8Array;
                created: number;
                openDoc?: DocSync;
            }[] = [];

            for (const path of docSyncPaths) {
                const pathRows = rows.filter(row => row.operation === "YjsUpdate" && row.path === path);
                const updates = pathRows
                    .map(row => row.data)
                    .filter((data): data is Uint8Array => data instanceof Uint8Array && data.byteLength > 0);
                const { doc, destroy } = await this.yjsApplicator.resolveYdoc(path);
                for (const update of updates) {
                    Y.applyUpdateV2(doc, update);
                }
                resolved.push({
                    path,
                    doc,
                    destroy,
                    stateVector: Y.encodeStateVector(doc),
                    created: Math.max(...pathRows.map(row => row.created)),
                    openDoc: this.getDocSync(path),
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
                    if (entry.openDoc) {
                        const replaceRevision = entry.openDoc.getLocalRevision();
                        if (!(await entry.openDoc.replaceStateIfRevision(state, replaceRevision, this.lastPulledRevision))) {
                            this.log.debug("skipped stale open-doc state replacement after DocSync", {
                                segmentId: segment.id,
                                path: entry.path,
                            });
                        }
                    } else {
                        const contentHash = await sha256Hex(new TextEncoder().encode(target));
                        if ("putServerSyncedState" in this.stateStore && typeof this.stateStore.putServerSyncedState === "function") {
                            await this.stateStore.putServerSyncedState(entry.path, state, contentHash, this.lastPulledRevision);
                        } else {
                            await this.stateStore.put(entry.path, state);
                        }
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
                let blobUploadId = row.blobUploadId;
                if (row.operation === "UpsertFile" && contentBytes && contentBytes.byteLength > INLINE_BYTES_LIMIT) {
                    contentSha256 = contentSha256 ?? await sha256Hex(contentBytes);
                    const upload = await this.blobClient.upload(row.path, contentBytes, contentSha256, this.clientId);
                    blobUploadId = upload.uploadId;
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
                    blobUploadId,
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
        return encodeUpdateBatchJsonl(output);
    }

    private requestDocSync(
        ws: WebSocket,
        paths: { path: string; stateVector: Uint8Array; content?: string }[],
    ): Promise<Extract<wsPacket, { type: opType.DocSyncAck }>> {
        const response = withTimeout(
            waitForPacket(ws, {
                accept: packet => packet.type === opType.DocSyncAck ? packet : undefined,
                closeMessage: "WebSocket closed before DocSync ack",
                errorMessage: "WebSocket errored before DocSync ack",
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
        this.pendingLastPulledRevision = revision;
        if (this.revisionFlushTimer !== null) {
            return;
        }
        this.revisionFlushTimer = globalThis.setTimeout(() => {
            this.revisionFlushTimer = null;
            void this.flushPendingLastPulledRevision().catch(error => {
                this.log.error("failed to persist last pulled revision", errorContext(error));
            });
        }, REVISION_SAVE_DEBOUNCE_MS) as unknown as number;
    }

    private async flushPendingLastPulledRevision(): Promise<void> {
        if (this.revisionFlushTimer !== null) {
            globalThis.clearTimeout(this.revisionFlushTimer);
            this.revisionFlushTimer = null;
        }
        const revision = this.pendingLastPulledRevision;
        if (!revision) {
            return;
        }
        this.pendingLastPulledRevision = null;
        await this.onLastPulledRevisionChanged(revision);
    }

    private recordUploadAckRevision(revision: string): void {
        if (BigInt(revision) <= BigInt(this.lastUploadedRevisionHint)) {
            return;
        }
        this.lastUploadedRevisionHint = revision;
    }

    private showFailureNotice(message: string): void {
        const now = Date.now();
        if (now - this.lastFailureNoticeAt < FAILURE_NOTICE_THROTTLE_MS) {
            return;
        }
        this.lastFailureNoticeAt = now;
        new Notice(message);
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
            this.bootstrapUploader.updateClientKey(this.clientKey);
            this.log.info("client key rotated");
        }

        this.authenticated = true;
        this.log.info("websocket authenticated", { serverRevision: packet.serverRevision });
        return openWs;
    }

    private async refreshBlobAuth(): Promise<string> {
        if (this.refreshAuthPromise) {
            return this.refreshAuthPromise;
        }
        this.refreshAuthPromise = (async () => {
            this.log.warn("refreshing blob auth after unauthorized response");
            const wasStartupSynced = this.startupSynced;
            const inStartupSync = this.startupSyncPromise !== null;
            if (inStartupSync) {
                if (this.authenticated) {
                    return this.clientKey;
                }
                await this.reauthenticateOpenSocket();
            } else {
                this.closeSocket();
                await this.ensureAuthenticatedSocket();
                await this.catchUpToServer();
            }
            this.startupSynced = wasStartupSynced;
            return this.clientKey;
        })().finally(() => {
            this.refreshAuthPromise = null;
        });
        return this.refreshAuthPromise;
    }

    private async reauthenticateOpenSocket(): Promise<void> {
        const openWs = this.ws;
        if (!openWs || openWs.readyState !== WebSocket.OPEN) {
            await this.ensureAuthenticatedSocket();
            return;
        }
        this.authenticated = false;
        await this.authenticateSocket();
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
        const requestId = crypto.randomUUID();
        this.pendingPullResponses++;
        try {
            const response = withTimeout(
                this.waitForPullResponse(ws, requestId),
                WS_WAIT_TIMEOUT_MS,
                "Timed out waiting for pull response",
            );
            ws.send(encodePacket({ type: opType.PullSince, revision, requestId }));
            return await response;
        } finally {
            this.pendingPullResponses--;
        }
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
                this.connectSoon();
            }
            this.onEditorPresenceReset();
            this.log.debug("websocket closed");
        });
        nextWs.addEventListener("message", event => {
            try {
                const msg = decodePacket(readSocketMessage(event));
                if (msg.type === opType.BootstrapStatus) {
                    this.onBootstrapStatus(msg);
                    return;
                }
                if (msg.type === opType.EditorPresenceUpdate) {
                    if (msg.clientId !== this.clientId) {
                        this.onEditorPresence(msg);
                    }
                    return;
                }
                if (msg.type === opType.EditorPresenceDisconnect) {
                    this.onEditorPresenceDisconnect(msg.clientId);
                    return;
                }
                if ((msg.type === opType.ChangeBatch || msg.type === opType.SnapshotReset) && !msg.requestId) {
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
        if (this.stopped) {
            return;
        }
        if (!this.startupSynced) {
            this.livePushBacklog.push(packet);
            if (this.livePushBacklog.length > 100) {
                this.livePushBacklog.shift();
            }
            return;
        }

        this.livePushPromise = this.livePushPromise
            .catch(() => {})
            .then(async () => {
                if (!this.startupSynced || this.stopped) {
                    return;
                }
                if (packet.type === opType.ChangeBatch) {
                    if (packet.changes.length === 0) {
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

    private drainLivePushBacklog(): void {
        const backlog = this.livePushBacklog;
        this.livePushBacklog = [];
        for (const packet of backlog) {
            this.handleLivePush(packet);
        }
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
        return waitForPacket(ws, {
            accept: packet => packet.type === opType.BatchAck && packet.segmentId === segmentId
                ? packet.revision
                : undefined,
            closeMessage: "WebSocket closed before batch ack",
            errorMessage: "WebSocket errored before batch ack",
        });
    }

    private waitForPullResponse(ws: WebSocket, requestId: string): Promise<wsPacket> {
        return waitForPacket(ws, {
            accept: packet => (
                (packet.type === opType.InitRequired ||
                    packet.type === opType.ChangeBatch ||
                    packet.type === opType.SnapshotReset) &&
                packet.requestId === requestId
            ) ? packet : undefined,
            closeMessage: "WebSocket closed before pull response",
            errorMessage: "WebSocket errored before pull response",
        });
    }

    private waitForAuthAck(ws: WebSocket): Promise<wsPacket | null> {
        return waitForPacket(ws, {
            accept: packet => packet.type === opType.AuthAck ? packet : undefined,
            closeMessage: "WebSocket closed before auth ack",
            errorMessage: "WebSocket errored before auth ack",
            denyReturnsNull: true,
        });
    }

    private closeSocket(): void {
        const ws = this.ws;
        this.ws = null;
        this.startupSynced = false;
        this.authenticated = false;
        this.authPromise = null;
        if (ws && ws.readyState !== WebSocket.CLOSED) {
            this.log.debug("closing websocket", { readyState: ws.readyState });
            ws.close();
        }
    }
}
