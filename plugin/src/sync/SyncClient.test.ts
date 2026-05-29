import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { TFile, TFolder } from "obsidian";
import { docStateFromContent, MARKDOWN_FIELD } from "../../../shared/yjsSeed";
import { opType, outboxData } from "../../../shared/types";
import { decodeUpdateBatchJsonl, encodePacket } from "../../../shared/protocol";
import { SyncClient } from "./SyncClient";
import { DocSync } from "../yjs/DocSync";
import { YjsStateStore } from "../yjs/YjsStateStore";
import { OutboxSegment, OutboxStore } from "../db/db";

class MemoryOutboxStore implements OutboxStore {
    constructor(private readonly rows: outboxData[] = []) {}

    async open(): Promise<void> {}
    async close(): Promise<void> {}
    async putInOutbox(_row: outboxData): Promise<number> { return 1; }
    async hasPendingChanges(): Promise<boolean> { return false; }
    async claimNextSegment(_sealActive: boolean): Promise<OutboxSegment | null> { return null; }
    async readSegmentJsonl(_segment: OutboxSegment): Promise<string> { return ""; }
    async readSegment(_segment: OutboxSegment): Promise<outboxData[]> { return this.rows; }
    async completeSegment(_segment: OutboxSegment): Promise<void> {}
    async releaseSegment(_segment: OutboxSegment): Promise<void> {}
}

class QueueOutboxStore extends MemoryOutboxStore {
    claimed = 0;
    completed = 0;
    released = 0;
    private readonly claimedRows = new Map<string, outboxData[]>();

    constructor(private readonly segments: { segment: OutboxSegment; rows: outboxData[] }[]) {
        super();
    }

    async claimNextSegment(_sealActive: boolean): Promise<OutboxSegment | null> {
        const next = this.segments.shift();
        if (!next) {
            return null;
        }
        this.claimed++;
        this.claimedRows.set(next.segment.id, next.rows);
        return next.segment;
    }

    async hasPendingChanges(): Promise<boolean> {
        return this.segments.length > 0;
    }

    async readSegment(segment: OutboxSegment): Promise<outboxData[]> {
        return this.claimedRows.get(segment.id) ?? [];
    }

    async completeSegment(_segment: OutboxSegment): Promise<void> {
        this.completed++;
    }

    async releaseSegment(_segment: OutboxSegment): Promise<void> {
        this.released++;
    }
}

class MemoryYjsStateStore {
    states = new Map<string, Uint8Array>();
    hashes = new Map<string, string>();

    async get(path: string): Promise<Uint8Array | null> {
        return this.states.get(path) ?? null;
    }

    async put(path: string, state: Uint8Array): Promise<void> {
        this.states.set(path, new Uint8Array(state));
    }

    async putWithContentHash(path: string, state: Uint8Array, hash: string): Promise<void> {
        this.states.set(path, new Uint8Array(state));
        this.hashes.set(path, hash);
    }

    async has(path: string): Promise<boolean> {
        return this.states.has(path);
    }

    async getContentHash(path: string): Promise<string | null> {
        return this.hashes.get(path) ?? null;
    }

    async putContentHash(path: string, hash: string): Promise<void> {
        this.hashes.set(path, hash);
    }

    async delete(path: string): Promise<void> {
        this.states.delete(path);
        this.hashes.delete(path);
    }

    async rename(fromPath: string, toPath: string): Promise<void> {
        const state = this.states.get(fromPath);
        if (state) {
            this.states.set(toPath, state);
            this.states.delete(fromPath);
        }
        const hash = this.hashes.get(fromPath);
        if (hash) {
            this.hashes.set(toPath, hash);
            this.hashes.delete(fromPath);
        }
    }
}

class FakeWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    sent: string[] = [];
    readyState = 1;

    send(packet: string): void {
        this.sent.push(packet);
    }

    close(): void {
        this.readyState = 3;
        this.dispatchEvent(new Event("close"));
    }

    emitPacket(packet: Parameters<typeof encodePacket>[0]): void {
        this.dispatchEvent(new MessageEvent("message", { data: encodePacket(packet) }));
    }
}

function readYjsContent(state: Uint8Array): string {
    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, state);
    const content = doc.getText(MARKDOWN_FIELD).toString();
    doc.destroy();
    return content;
}

async function applyEditorInsert(doc: DocSync, path: string, before: string, from: number, insert: string): Promise<void> {
    const transaction = EditorState.create({ doc: before }).update({ changes: { from, insert } });
    await doc.applyChanges(transaction.changes, {
        mutationId: crypto.randomUUID(),
        operation: "YjsUpdate",
        path,
        data: new Uint8Array(),
        created: Date.now(),
    });
}

async function makeClient(
    files: Record<string, string | Uint8Array>,
    stateStore = new MemoryYjsStateStore(),
    outbox = new MemoryOutboxStore(),
    options: {
        getDocSync?: (path: string) => DocSync | undefined;
        onOpenYjsContent?: (path: string, content: string) => Promise<boolean>;
        flushOpenYjsChanges?: (path: string) => Promise<void>;
        onRemotePluginFilesChanged?: () => void;
    } = {},
): Promise<{
    client: SyncClient;
    stateStore: MemoryYjsStateStore;
}> {
    const TestFile = TFile as unknown as { new(path?: string): TFile };
    const TestFolder = TFolder as unknown as { new(path?: string): TFolder };
    const textDecoder = new TextDecoder();
    const textEncoder = new TextEncoder();
    const listAdapterDir = (path: string) => {
        const dir = path.replace(/^\/+|\/+$/g, "");
        const folders = new Set<string>();
        const listedFiles: string[] = [];
        for (const filePath of Object.keys(files)) {
            const parts = filePath.split("/");
            for (let index = 1; index < parts.length; index++) {
                const folder = parts.slice(0, index).join("/");
                const parent = parts.slice(0, index - 1).join("/");
                if (parent === dir) {
                    folders.add(folder);
                }
            }
            const parent = parts.slice(0, -1).join("/");
            if (parent === dir) {
                listedFiles.push(filePath);
            }
        }
        return {
            folders: [...folders].sort(),
            files: listedFiles.sort(),
        };
    };
    const adapterDirExists = (path: string) => {
        const normalized = path.replace(/^\/+|\/+$/g, "");
        return !normalized || listAdapterDir(normalized).folders.length > 0 || listAdapterDir(normalized).files.length > 0;
    };
    const loaded = [
        adapterDirExists("notes") ? new TestFolder("notes") : null,
        "notes/existing.md" in files ? new TestFile("notes/existing.md") : null,
        "assets/image.bin" in files ? new TestFile("assets/image.bin") : null,
    ].filter((entry): entry is TFile | TFolder => entry !== null);
    const app = {
        vault: {
            configDir: ".obsidian",
            getAllLoadedFiles: () => loaded,
            getFiles: () => loaded.filter(file => file instanceof TFile),
            getAbstractFileByPath: (path: string) => loaded.find(file => file.path === path) ?? null,
            read: async (file: { path: string }) => {
                const value = files[file.path];
                return typeof value === "string" ? value : textDecoder.decode(value);
            },
            modify: async (file: { path: string }, content: string) => {
                files[file.path] = content;
            },
            create: async (path: string, content: string) => {
                files[path] = content;
                const file = new TestFile(path);
                loaded.push(file);
                return file;
            },
            createFolder: async (path: string) => {
                const folder = new TestFolder(path);
                loaded.push(folder);
                return folder;
            },
            rename: async (file: { path: string }, path: string) => {
                files[path] = files[file.path] ?? "";
                delete files[file.path];
                file.path = path;
            },
            adapter: {
                exists: async (path: string) => path in files || adapterDirExists(path),
                list: async (path: string) => listAdapterDir(path),
                read: async (path: string) => {
                    const value = files[path];
                    if (value === undefined) {
                        throw new Error(`Missing test file: ${path}`);
                    }
                    return typeof value === "string" ? value : textDecoder.decode(value);
                },
                write: async (path: string, content: string) => {
                    files[path] = content;
                },
                readBinary: async (path: string) => {
                    const value = files[path];
                    if (value === undefined) {
                        throw new Error(`Missing test file: ${path}`);
                    }
                    return typeof value === "string" ? textEncoder.encode(value).buffer : value.buffer.slice(
                        value.byteOffset,
                        value.byteOffset + value.byteLength,
                    );
                },
                writeBinary: async (path: string, content: ArrayBuffer) => {
                    files[path] = new Uint8Array(content);
                },
            },
        },
        fileManager: {
            trashFile: async (file: { path: string }) => {
                delete files[file.path];
                const index = loaded.findIndex(entry => entry.path === file.path);
                if (index !== -1) {
                    loaded.splice(index, 1);
                }
            },
        },
    };

    const client = new SyncClient(
        app as never,
        outbox,
        stateStore as unknown as YjsStateStore,
        {
            backendUrl: "https://sync.example.test",
            clientId: "client",
            clientKey: "obs_sync_test",
            clientName: "Client",
            lastPulledRevision: "0",
        },
        undefined,
        undefined,
        options.getDocSync,
        undefined,
        undefined,
        undefined,
        options.onRemotePluginFilesChanged,
        options.onOpenYjsContent,
        options.flushOpenYjsChanges,
    );
    return { client, stateStore };
}

describe("SyncClient initial snapshot", () => {
    it("uploads every existing vault file and includes markdown yjsState", async () => {
        const { client, stateStore } = await makeClient({
            "notes/existing.md": "existing note",
            "assets/image.bin": new Uint8Array([0, 1, 2]),
            ".obsidian/workspace.json": "{\"pane\":\"left\"}",
        });

        const changes = await (client as unknown as { readVaultSnapshot: () => Promise<outboxData[]> }).readVaultSnapshot();

        expect(changes.map(change => [change.operation, change.path])).toEqual([
            ["CreateFolder", ".obsidian"],
            ["CreateFolder", "assets"],
            ["CreateFolder", "notes"],
            ["UpsertFile", ".obsidian/workspace.json"],
            ["UpsertFile", "assets/image.bin"],
            ["UpsertFile", "notes/existing.md"],
        ]);
        const note = changes.find(change => change.path === "notes/existing.md");
        expect(note).toMatchObject({
            operation: "UpsertFile",
            content: "existing note",
            isYjs: true,
            storageKind: "text",
        });
        expect(note?.yjsState).toBeInstanceOf(Uint8Array);
        expect(readYjsContent(note!.yjsState!)).toBe("existing note");
        expect(stateStore.states.get("notes/existing.md")).toEqual(note?.yjsState);
    });

    it("rebuilds stale markdown yjsState while building an initial snapshot", async () => {
        const staleState = docStateFromContent("old note", Y);
        const stateStore = new MemoryYjsStateStore();
        stateStore.states.set("notes/existing.md", staleState);
        stateStore.hashes.set("notes/existing.md", "old-hash");
        const { client } = await makeClient({
            "notes/existing.md": "new note",
        }, stateStore);

        const changes = await (client as unknown as { readVaultSnapshot: () => Promise<outboxData[]> }).readVaultSnapshot();
        const note = changes.find(change => change.path === "notes/existing.md");

        expect(readYjsContent(note!.yjsState!)).toBe("new note");
        expect(readYjsContent(stateStore.states.get("notes/existing.md")!)).toBe("new note");
        expect(stateStore.hashes.get("notes/existing.md")).not.toBe("old-hash");
    });

    it("includes staged blob upload ids for large files in an initial snapshot", async () => {
        const bytes = new Uint8Array((64 * 1024) + 1);
        const { client } = await makeClient({
            "assets/large.pdf": bytes,
        });
        const upload = vi.fn(async () => ({
            uploadId: "blob_initial",
            path: "assets/large.pdf",
            byteSize: bytes.byteLength,
            contentSha256: "sha-large",
        }));
        (client as unknown as { blobClient: { upload: typeof upload } }).blobClient.upload = upload;

        const changes = await (client as unknown as { readVaultSnapshot: () => Promise<outboxData[]> }).readVaultSnapshot();
        const large = changes.find(change => change.path === "assets/large.pdf");

        expect(upload).toHaveBeenCalledWith("assets/large.pdf", bytes, expect.any(String), "client");
        expect(large).toMatchObject({
            operation: "UpsertFile",
            storageKind: "lo",
            blobUploadId: "blob_initial",
            byteSize: bytes.byteLength,
        });
        expect(large?.contentBytes).toBeUndefined();
    });

    it("discovers initial vault files from the adapter when they are not loaded yet", async () => {
        const { client, stateStore } = await makeClient({
            "notes/existing.md": "existing note",
            "notes/unloaded.md": "unloaded note",
            ".obsidian/workspace.json": "{}",
        });

        const changes = await (client as unknown as { readVaultSnapshot: () => Promise<outboxData[]> }).readVaultSnapshot();
        const paths = changes.map(change => change.path);

        expect(paths).toContain("notes/unloaded.md");
        const note = changes.find(change => change.path === "notes/unloaded.md");
        expect(note).toMatchObject({
            operation: "UpsertFile",
            content: "unloaded note",
            isYjs: true,
            storageKind: "text",
        });
        expect(readYjsContent(note!.yjsState!)).toBe("unloaded note");
        expect(stateStore.states.get("notes/unloaded.md")).toEqual(note?.yjsState);
    });

    it("skips large files that fail blob upload while still building the initial snapshot", async () => {
        const { client } = await makeClient({
            "notes/existing.md": "existing note",
            "assets/too-large.pdf": new Uint8Array((64 * 1024) + 1),
            ".obsidian/workspace.json": "{}",
        });
        (client as unknown as {
            blobClient: { upload: () => Promise<void> };
        }).blobClient.upload = vi.fn(async () => {
            throw new Error("413");
        });

        const changes = await (client as unknown as { readVaultSnapshot: () => Promise<outboxData[]> }).readVaultSnapshot();
        const paths = changes.map(change => change.path);

        expect(paths).toContain("notes/existing.md");
        expect(paths).toContain(".obsidian/workspace.json");
        expect(paths).not.toContain("assets/too-large.pdf");
    });

    it("does not keep retrying first-sync upload only because a large blob was skipped", async () => {
        const { client } = await makeClient({
            "notes/existing.md": "existing note",
            "assets/too-large.pdf": new Uint8Array((64 * 1024) + 1),
            ".obsidian/workspace.json": "{}",
        });
        (client as unknown as {
            blobClient: { upload: () => Promise<void> };
        }).blobClient.upload = vi.fn(async () => {
            throw new Error("413");
        });
        const testClient = client as unknown as {
            readVaultSnapshot: () => Promise<outboxData[]>;
            shouldUploadFirstSyncOverSnapshot: (packet: unknown) => Promise<boolean>;
        };
        const uploaded = await testClient.readVaultSnapshot();

        await expect(testClient.shouldUploadFirstSyncOverSnapshot({
            type: opType.SnapshotReset,
            targetRevision: "10",
            files: uploaded.map((change, index) => ({
                ...change,
                revision: String(index + 1),
                clientId: "server",
            })),
        })).resolves.toBe(false);
    });

    it("drops stale ignored rows while preparing an outbox segment", async () => {
        const outbox = new MemoryOutboxStore([
            {
                mutationId: "ignored",
                operation: "UpsertFile",
                path: ".obsidian/plugins/obsidian-sync-engine/data.json",
                contentBytes: new Uint8Array([1]),
                created: 1,
            },
            {
                mutationId: "kept",
                operation: "UpsertFile",
                path: ".obsidian/workspace.json",
                contentBytes: new TextEncoder().encode("{}"),
                storageKind: "bytea",
                created: 2,
            },
        ]);
        const { client } = await makeClient({
            ".obsidian/workspace.json": "{}",
        }, new MemoryYjsStateStore(), outbox);

        const jsonl = await (client as unknown as {
            prepareSegmentJsonl: (ws: WebSocket, segment: OutboxSegment) => Promise<string>;
        }).prepareSegmentJsonl({} as WebSocket, { id: "segment", path: "pending.jsonl" });

        expect(jsonl).toContain(".obsidian/workspace.json");
        expect(jsonl).not.toContain("data.json");
    });

    it("uploads open-document Yjs updates without a pre-upload DocSync round trip", async () => {
        const path = "notes/existing.md";
        const baseState = docStateFromContent("hello", Y);
        const doc = new Y.Doc();
        Y.applyUpdateV2(doc, baseState);
        const beforeFirst = Y.encodeStateVector(doc);
        doc.getText(MARKDOWN_FIELD).insert(5, " world");
        const first = Y.encodeStateAsUpdateV2(doc, beforeFirst);
        const beforeSecond = Y.encodeStateVector(doc);
        doc.getText(MARKDOWN_FIELD).insert(11, "!");
        const second = Y.encodeStateAsUpdateV2(doc, beforeSecond);
        const finalState = Y.encodeStateAsUpdateV2(doc);
        doc.destroy();

        const openDoc = new DocSync(
            new MemoryOutboxStore(),
            new MemoryYjsStateStore() as unknown as YjsStateStore,
            path,
            finalState,
            true,
        );
        const outbox = new MemoryOutboxStore([
            {
                mutationId: "first",
                operation: "YjsUpdate",
                path,
                data: first,
                created: 1,
            },
            {
                mutationId: "second",
                operation: "YjsUpdate",
                path,
                data: second,
                created: 2,
            },
        ]);
        const { client } = await makeClient({ [path]: "hello world!" }, new MemoryYjsStateStore(), outbox, {
            getDocSync: requested => requested === path ? openDoc : undefined,
        });
        const ws = { send: vi.fn() } as unknown as WebSocket;

        const jsonl = await (client as unknown as {
            prepareSegmentJsonl: (socket: WebSocket, segment: OutboxSegment) => Promise<string>;
        }).prepareSegmentJsonl(ws, { id: "segment", path: "pending.jsonl" });

        expect(ws.send).not.toHaveBeenCalled();
        const rows = decodeUpdateBatchJsonl(jsonl);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.operation).toBe("YjsUpdate");
        const materialized = new Y.Doc();
        Y.applyUpdateV2(materialized, baseState);
        Y.applyUpdateV2(materialized, rows[0]!.data!);
        expect(materialized.getText(MARKDOWN_FIELD).toString()).toBe("hello world!");
        materialized.destroy();
        openDoc.destroy();
    });

    it("rebases empty closed-document resync markers through DocSync before upload", async () => {
        const path = "notes/existing.md";
        const stateStore = new MemoryYjsStateStore();
        await stateStore.put(path, docStateFromContent("base local", Y));
        const outbox = new MemoryOutboxStore([{
            mutationId: "closed-resync",
            operation: "YjsUpdate",
            path,
            data: new Uint8Array(),
            created: 1,
        }]);
        const { client } = await makeClient({ [path]: "base local" }, stateStore, outbox);
        const remoteState = docStateFromContent("base remote", Y);
        const requestDocSync = vi.fn(async () => ({
            type: opType.DocSyncAck,
            paths: [{
                path,
                data: new Uint8Array(),
                stateVector: Y.encodeStateVectorFromUpdateV2(remoteState),
                yjsState: remoteState,
            }],
        }));
        (client as unknown as {
            requestDocSync: typeof requestDocSync;
        }).requestDocSync = requestDocSync;

        const jsonl = await (client as unknown as {
            prepareSegmentJsonl: (socket: WebSocket, segment: OutboxSegment) => Promise<string>;
        }).prepareSegmentJsonl({ send: vi.fn() } as unknown as WebSocket, { id: "segment", path: "pending.jsonl" });

        expect(requestDocSync).toHaveBeenCalledTimes(1);
        const rows = decodeUpdateBatchJsonl(jsonl);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.operation).toBe("YjsUpdate");
        const materialized = new Y.Doc();
        Y.applyUpdateV2(materialized, remoteState);
        Y.applyUpdateV2(materialized, rows[0]!.data!);
        expect(materialized.getText(MARKDOWN_FIELD).toString()).toBe("base local");
        materialized.destroy();
    });

    it("waits for startup sync before requesting a bootstrap link", async () => {
        const { client } = await makeClient({
            "notes/existing.md": "existing note",
            "assets/image.bin": new Uint8Array([0, 1, 2]),
            ".obsidian/workspace.json": "{}",
        });
        const sent: string[] = [];
        const socket = { send: vi.fn((packet: string) => sent.push(packet)) };
        const runStartupSync = vi.fn(async () => {});
        const ensureSocket = vi.fn(async () => socket);
        (client as unknown as { runStartupSync: () => Promise<void> }).runStartupSync = runStartupSync;
        (client as unknown as { ensureAuthenticatedSocket: () => Promise<typeof socket> }).ensureAuthenticatedSocket = ensureSocket;

        await client.generateBootstrapLink("Vault", ".obsidian", "obsidian-sync-engine");

        expect(runStartupSync).toHaveBeenCalledTimes(1);
        expect(ensureSocket).toHaveBeenCalledTimes(1);
        expect(sent).toHaveLength(1);
        expect(JSON.parse(sent[0]!)).toMatchObject({
            type: opType.BootstrapCreate,
            vaultName: "Vault",
            configDir: ".obsidian",
            pluginId: "obsidian-sync-engine",
        });
    });

    it("uploads local first-sync snapshot over a server snapshot that is missing local files", async () => {
        const { client } = await makeClient({
            "notes/existing.md": "local note",
            ".obsidian/workspace.json": "{}",
        });
        const ws = new FakeWebSocket();
        const testClient = client as unknown as {
            runStartupSync: () => Promise<void>;
            ensureAuthenticatedSocket: () => Promise<FakeWebSocket>;
            flushPendingOutboxForStartup: () => Promise<void>;
            pullSince: (_ws: FakeWebSocket, _revision: string) => Promise<unknown>;
            bootstrapUploader: { uploadAuthoritativeSnapshot: () => Promise<string> };
            catchUpToServer: (_ws?: FakeWebSocket) => Promise<void>;
            livePushPromise: Promise<void>;
            startupSynced: boolean;
            lastPulledRevision: string;
        };
        const persisted: string[] = [];
        (client as unknown as {
            onLastPulledRevisionChanged: (revision: string) => Promise<void>;
        }).onLastPulledRevisionChanged = async revision => {
            persisted.push(revision);
        };
        testClient.ensureAuthenticatedSocket = async () => ws;
        testClient.flushPendingOutboxForStartup = async () => {};
        testClient.pullSince = async () => ({
            type: opType.SnapshotReset,
            targetRevision: "170",
            files: [{
                mutationId: "snapshot:assets/blob.pdf:170",
                operation: "UpsertFile",
                path: "assets/blob.pdf",
                contentBytes: new Uint8Array([1]),
                storageKind: "bytea",
                isFolder: false,
                isYjs: false,
                created: Date.now(),
                revision: "170",
                clientId: "server",
            }],
        });
        testClient.bootstrapUploader.uploadAuthoritativeSnapshot = vi.fn(async () => "171");
        testClient.catchUpToServer = async () => {};
        testClient.livePushPromise = Promise.resolve();

        await testClient.runStartupSync();

        expect(testClient.bootstrapUploader.uploadAuthoritativeSnapshot).toHaveBeenCalledTimes(1);
        expect(testClient.lastPulledRevision).toBe("171");
        expect(persisted).toEqual(["171"]);
        expect(testClient.startupSynced).toBe(true);
    });

    it("uses authoritative bootstrap upload when the server requires init", async () => {
        const { client } = await makeClient({
            "notes/existing.md": "local note",
        });
        const ws = new FakeWebSocket();
        const testClient = client as unknown as {
            runStartupSync: () => Promise<void>;
            ensureAuthenticatedSocket: () => Promise<FakeWebSocket>;
            flushPendingOutboxForStartup: () => Promise<void>;
            pullSince: (_ws: FakeWebSocket, _revision: string) => Promise<unknown>;
            bootstrapUploader: { uploadAuthoritativeSnapshot: () => Promise<string> };
            catchUpToServer: (_ws?: FakeWebSocket) => Promise<void>;
            livePushPromise: Promise<void>;
            startupSynced: boolean;
            lastPulledRevision: string;
        };
        const persisted: string[] = [];
        (client as unknown as {
            onLastPulledRevisionChanged: (revision: string) => Promise<void>;
        }).onLastPulledRevisionChanged = async revision => {
            persisted.push(revision);
        };
        testClient.ensureAuthenticatedSocket = async () => ws;
        testClient.flushPendingOutboxForStartup = async () => {};
        testClient.pullSince = async () => ({
            type: opType.InitRequired,
            serverRevision: "0",
        });
        testClient.bootstrapUploader.uploadAuthoritativeSnapshot = vi.fn(async () => "42");
        testClient.catchUpToServer = async () => {};
        testClient.livePushPromise = Promise.resolve();

        await testClient.runStartupSync();

        expect(testClient.bootstrapUploader.uploadAuthoritativeSnapshot).toHaveBeenCalledTimes(1);
        expect(testClient.lastPulledRevision).toBe("42");
        expect(persisted).toEqual(["42"]);
        expect(testClient.startupSynced).toBe(true);
    });

    it("applies live change batches pushed over the authenticated socket", async () => {
        const files = {
            "notes/existing.md": "before",
            "assets/image.bin": new Uint8Array([0, 1, 2]),
            ".obsidian/workspace.json": "{}",
        };
        const { client } = await makeClient(files);
        const liveClient = client as unknown as {
            startupSynced: boolean;
            lastPulledRevision: string;
            livePushPromise: Promise<void>;
            handleLivePush: (packet: unknown) => void;
        };
        liveClient.startupSynced = true;
        liveClient.lastPulledRevision = "1";

        liveClient.handleLivePush({
            type: opType.ChangeBatch,
            fromRevision: "1",
            serverRevision: "2",
            changes: [{
                mutationId: "remote-1",
                operation: "UpsertFile",
                path: "notes/existing.md",
                content: "after",
                storageKind: "text",
                isFolder: false,
                isYjs: false,
                created: Date.now(),
                revision: "2",
                clientId: "other-client",
            }],
        });
        await liveClient.livePushPromise;

        expect(files["notes/existing.md"]).toBe("after");
        expect(liveClient.lastPulledRevision).toBe("2");
    });

    it("applies a remote live batch even when a local upload ack has a newer revision", async () => {
        const files = { "notes/existing.md": "before" };
        const { client } = await makeClient(files);
        const liveClient = client as unknown as {
            startupSynced: boolean;
            lastPulledRevision: string;
            lastUploadedRevisionHint: string;
            livePushPromise: Promise<void>;
            handleLivePush: (packet: unknown) => void;
            recordUploadAckRevision: (revision: string) => void;
        };
        liveClient.startupSynced = true;
        liveClient.lastPulledRevision = "1";

        liveClient.recordUploadAckRevision("3");
        expect(liveClient.lastPulledRevision).toBe("1");
        expect(liveClient.lastUploadedRevisionHint).toBe("3");

        liveClient.handleLivePush({
            type: opType.ChangeBatch,
            fromRevision: "1",
            serverRevision: "2",
            changes: [{
                mutationId: "remote-2",
                operation: "UpsertFile",
                path: "notes/existing.md",
                content: "remote revision 2",
                storageKind: "text",
                isFolder: false,
                isYjs: false,
                created: Date.now(),
                revision: "2",
                clientId: "other-client",
            }],
        });
        await liveClient.livePushPromise;

        expect(files["notes/existing.md"]).toBe("remote revision 2");
        expect(liveClient.lastPulledRevision).toBe("2");
    });

    it("replaces stale local markdown and state from a YjsUpdate full server state", async () => {
        const files = { "notes/existing.md": "stale local" };
        const stateStore = new MemoryYjsStateStore();
        await stateStore.put("notes/existing.md", docStateFromContent("stale local", Y));
        const { client } = await makeClient(files, stateStore);
        const yjsState = docStateFromContent("server materialized", Y);
        const testClient = client as unknown as {
            lastPulledRevision: string;
            applyChangeBatch: (packet: unknown) => Promise<void>;
        };
        testClient.lastPulledRevision = "1";

        await testClient.applyChangeBatch({
            type: opType.ChangeBatch,
            fromRevision: "1",
            serverRevision: "2",
            changes: [{
                mutationId: "remote-yjs",
                operation: "YjsUpdate",
                path: "notes/existing.md",
                data: new Uint8Array([0, 1, 2]),
                yjsState,
                created: Date.now(),
                revision: "2",
                clientId: "other-client",
            }],
        });

        expect(files["notes/existing.md"]).toBe("server materialized");
        expect(readYjsContent(stateStore.states.get("notes/existing.md")!)).toBe("server materialized");
        expect(testClient.lastPulledRevision).toBe("2");
    });

    it("applies remote Yjs content through the open editor callback instead of rewriting the active file", async () => {
        const files = { "notes/existing.md": "stale local" };
        const stateStore = new MemoryYjsStateStore();
        const initialState = docStateFromContent("stale local", Y);
        await stateStore.put("notes/existing.md", initialState);
        const openDoc = new DocSync(
            new MemoryOutboxStore(),
            stateStore as unknown as YjsStateStore,
            "notes/existing.md",
            initialState,
        );
        const applied: string[] = [];
        const { client } = await makeClient(files, stateStore, new MemoryOutboxStore(), {
            getDocSync: path => path === "notes/existing.md" ? openDoc : undefined,
            onOpenYjsContent: async (_path, content) => {
                applied.push(content);
                return true;
            },
        });
        const yjsState = docStateFromContent("server materialized", Y);
        const testClient = client as unknown as {
            lastPulledRevision: string;
            applyChangeBatch: (packet: unknown) => Promise<void>;
        };
        testClient.lastPulledRevision = "1";

        await testClient.applyChangeBatch({
            type: opType.ChangeBatch,
            fromRevision: "1",
            serverRevision: "2",
            changes: [{
                mutationId: "remote-yjs",
                operation: "YjsUpdate",
                path: "notes/existing.md",
                yjsState,
                created: Date.now(),
                revision: "2",
                clientId: "other-client",
            }],
        });

        expect(applied).toEqual(["server materialized"]);
        expect(files["notes/existing.md"]).toBe("stale local");
        expect(openDoc.getYdoc().getText(MARKDOWN_FIELD).toString()).toBe("server materialized");
        expect(readYjsContent(stateStore.states.get("notes/existing.md")!)).toBe("server materialized");
    });

    it("notifies once when remote plugin files change", async () => {
        const files: Record<string, string | Uint8Array> = {};
        const onRemotePluginFilesChanged = vi.fn();
        const { client } = await makeClient(files, new MemoryYjsStateStore(), new MemoryOutboxStore(), {
            onRemotePluginFilesChanged,
        });
        const testClient = client as unknown as {
            lastPulledRevision: string;
            applyChangeBatch: (packet: unknown) => Promise<void>;
        };
        testClient.lastPulledRevision = "1";

        await testClient.applyChangeBatch({
            type: opType.ChangeBatch,
            fromRevision: "1",
            serverRevision: "3",
            changes: [
                {
                    mutationId: "remote-plugin-main",
                    operation: "UpsertFile",
                    path: ".obsidian/plugins/example/main.js",
                    contentBytes: new TextEncoder().encode("module.exports = {};"),
                    isFolder: false,
                    isYjs: false,
                    storageKind: "bytea",
                    created: Date.now(),
                    revision: "2",
                    clientId: "other-client",
                },
                {
                    mutationId: "remote-plugin-manifest",
                    operation: "UpsertFile",
                    path: ".obsidian/plugins/example/manifest.json",
                    contentBytes: new TextEncoder().encode("{}"),
                    isFolder: false,
                    isYjs: false,
                    storageKind: "bytea",
                    created: Date.now(),
                    revision: "3",
                    clientId: "other-client",
                },
            ],
        });

        expect(files[".obsidian/plugins/example/main.js"]).toEqual(new TextEncoder().encode("module.exports = {};"));
        expect(onRemotePluginFilesChanged).toHaveBeenCalledTimes(1);
    });

    it("does not notify for echoed local plugin file changes", async () => {
        const onRemotePluginFilesChanged = vi.fn();
        const { client } = await makeClient({}, new MemoryYjsStateStore(), new MemoryOutboxStore(), {
            onRemotePluginFilesChanged,
        });
        const testClient = client as unknown as {
            lastPulledRevision: string;
            applyChangeBatch: (packet: unknown) => Promise<void>;
        };
        testClient.lastPulledRevision = "1";

        await testClient.applyChangeBatch({
            type: opType.ChangeBatch,
            fromRevision: "1",
            serverRevision: "2",
            changes: [{
                mutationId: "local-plugin-main",
                operation: "UpsertFile",
                path: ".obsidian/plugins/example/main.js",
                contentBytes: new TextEncoder().encode("local"),
                isFolder: false,
                isYjs: false,
                storageKind: "bytea",
                created: Date.now(),
                revision: "2",
                clientId: "client",
            }],
        });

        expect(onRemotePluginFilesChanged).not.toHaveBeenCalled();
    });

    it("merges a full remote Yjs state into an open document with pending local edits", async () => {
        const files = { "notes/existing.md": "base" };
        const stateStore = new MemoryYjsStateStore();
        const initialState = docStateFromContent("base", Y);
        await stateStore.put("notes/existing.md", initialState);
        const openDoc = new DocSync(
            new MemoryOutboxStore(),
            stateStore as unknown as YjsStateStore,
            "notes/existing.md",
            initialState,
        );
        await applyEditorInsert(openDoc, "notes/existing.md", "base", 4, " local");

        const serverDoc = new Y.Doc();
        Y.applyUpdateV2(serverDoc, initialState);
        serverDoc.getText(MARKDOWN_FIELD).insert(4, " remote");
        const yjsState = Y.encodeStateAsUpdateV2(serverDoc);
        serverDoc.destroy();

        const applied: string[] = [];
        const { client } = await makeClient(files, stateStore, new MemoryOutboxStore(), {
            getDocSync: path => path === "notes/existing.md" ? openDoc : undefined,
            onOpenYjsContent: async (_path, content) => {
                applied.push(content);
                return true;
            },
        });
        const testClient = client as unknown as {
            lastPulledRevision: string;
            applyChangeBatch: (packet: unknown) => Promise<void>;
        };
        testClient.lastPulledRevision = "1";

        await testClient.applyChangeBatch({
            type: opType.ChangeBatch,
            fromRevision: "1",
            serverRevision: "2",
            changes: [{
                mutationId: "remote-yjs",
                operation: "YjsUpdate",
                path: "notes/existing.md",
                yjsState,
                created: Date.now(),
                revision: "2",
                clientId: "other-client",
            }],
        });

        const merged = openDoc.getYdoc().getText(MARKDOWN_FIELD).toString();
        expect(merged).toContain("base");
        expect(merged).toContain("local");
        expect(merged).toContain("remote");
        expect(applied).toEqual([merged]);
        expect(readYjsContent(stateStore.states.get("notes/existing.md")!)).toBe(merged);
    });

    it("flushes queued editor changes before applying a full remote Yjs state to an open document", async () => {
        const files = { "notes/existing.md": "base" };
        const stateStore = new MemoryYjsStateStore();
        const initialState = docStateFromContent("base", Y);
        await stateStore.put("notes/existing.md", initialState);
        const openDoc = new DocSync(
            new MemoryOutboxStore(),
            stateStore as unknown as YjsStateStore,
            "notes/existing.md",
            initialState,
        );

        const serverDoc = new Y.Doc();
        Y.applyUpdateV2(serverDoc, initialState);
        serverDoc.getText(MARKDOWN_FIELD).insert(4, " remote");
        const yjsState = Y.encodeStateAsUpdateV2(serverDoc);
        serverDoc.destroy();

        const applied: string[] = [];
        let flushed = false;
        const { client } = await makeClient(files, stateStore, new MemoryOutboxStore(), {
            getDocSync: path => path === "notes/existing.md" ? openDoc : undefined,
            onOpenYjsContent: async (_path, content) => {
                applied.push(content);
                return true;
            },
            flushOpenYjsChanges: async path => {
                expect(path).toBe("notes/existing.md");
                flushed = true;
                await applyEditorInsert(openDoc, path, "base", 4, " local");
            },
        });
        const testClient = client as unknown as {
            lastPulledRevision: string;
            applyChangeBatch: (packet: unknown) => Promise<void>;
        };
        testClient.lastPulledRevision = "1";

        await testClient.applyChangeBatch({
            type: opType.ChangeBatch,
            fromRevision: "1",
            serverRevision: "2",
            changes: [{
                mutationId: "remote-yjs",
                operation: "YjsUpdate",
                path: "notes/existing.md",
                yjsState,
                created: Date.now(),
                revision: "2",
                clientId: "other-client",
            }],
        });

        const merged = openDoc.getYdoc().getText(MARKDOWN_FIELD).toString();
        expect(flushed).toBe(true);
        expect(merged).toContain("base");
        expect(merged).toContain("local");
        expect(merged).toContain("remote");
        expect(applied).toEqual([merged]);
        expect(readYjsContent(stateStore.states.get("notes/existing.md")!)).toBe(merged);
    });

    it("snapshot upsert overwrites an adapter-existing text file that is not loaded", async () => {
        const files = { "notes/unloaded.md": "local" };
        const { client } = await makeClient(files);
        const testClient = client as unknown as {
            lastPulledRevision: string;
            applySnapshotReset: (packet: unknown) => Promise<void>;
        };
        testClient.lastPulledRevision = "0";

        await testClient.applySnapshotReset({
            type: opType.SnapshotReset,
            targetRevision: "5",
            files: [{
                mutationId: "snapshot:notes/unloaded.md:5",
                operation: "UpsertFile",
                path: "notes/unloaded.md",
                content: "server",
                storageKind: "text",
                isFolder: false,
                isYjs: true,
                created: Date.now(),
                revision: "5",
                clientId: "server",
            }],
        });

        expect(files["notes/unloaded.md"]).toBe("server");
        expect(testClient.lastPulledRevision).toBe("5");
    });

    it("skips echoed local change rows while still advancing through them", async () => {
        const files = { "notes/existing.md": "local" };
        const { client } = await makeClient(files);
        const testClient = client as unknown as {
            lastPulledRevision: string;
            applyChangeBatch: (packet: unknown) => Promise<void>;
        };
        testClient.lastPulledRevision = "0";

        await testClient.applyChangeBatch({
            type: opType.ChangeBatch,
            fromRevision: "0",
            serverRevision: "1",
            changes: [{
                mutationId: "local-echo",
                operation: "UpsertFile",
                path: "notes/existing.md",
                content: "server echo",
                storageKind: "text",
                isFolder: false,
                isYjs: true,
                created: Date.now(),
                revision: "1",
                clientId: "client",
            }],
        });

        expect(files["notes/existing.md"]).toBe("local");
        expect(testClient.lastPulledRevision).toBe("1");
    });

    it("does not regress lastPulledRevision when a stale live push finishes after a batch ack", async () => {
        vi.useFakeTimers();
        const { client } = await makeClient({ "notes/existing.md": "before" });
        try {
            const persisted: string[] = [];
            const liveClient = client as unknown as {
                startupSynced: boolean;
                lastPulledRevision: string;
                livePushPromise: Promise<void>;
                handleLivePush: (packet: unknown) => void;
                persistLastPulledRevision: (revision: string) => Promise<void>;
                applyServerChanges: (changes: unknown[]) => Promise<void>;
            };
            const originalApply = liveClient.applyServerChanges.bind(liveClient);
            let releaseApply!: () => void;
            const applyBlocked = new Promise<void>(resolve => {
                releaseApply = () => resolve();
            });
            let applyEntered = false;
            liveClient.applyServerChanges = vi.fn(async changes => {
                applyEntered = true;
                await applyBlocked;
                return originalApply(changes);
            });
            const onRevisionChanged = vi.fn(async (revision: string) => {
                persisted.push(revision);
            });
            (client as unknown as { onLastPulledRevisionChanged: typeof onRevisionChanged }).onLastPulledRevisionChanged = onRevisionChanged;

            liveClient.startupSynced = true;
            liveClient.lastPulledRevision = "1";

            liveClient.handleLivePush({
                type: opType.ChangeBatch,
                fromRevision: "1",
                serverRevision: "2",
                changes: [{
                    mutationId: "remote-1",
                    operation: "UpsertFile",
                    path: "notes/existing.md",
                    content: "after",
                    storageKind: "text",
                    isFolder: false,
                    isYjs: false,
                    created: Date.now(),
                    revision: "2",
                    clientId: "other-client",
                }],
            });
            await vi.waitFor(() => expect(applyEntered).toBe(true));

            await liveClient.persistLastPulledRevision("3");
            releaseApply();
            await liveClient.livePushPromise;

            expect(liveClient.lastPulledRevision).toBe("3");
            expect(persisted).toEqual([]);
            await vi.advanceTimersByTimeAsync(1000);
            expect(persisted).toEqual(["3"]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("waitForAuthAck ignores bootstrap status packets before AuthAck", async () => {
        const { client } = await makeClient({ "notes/existing.md": "before" });
        const ws = new FakeWebSocket();
        const waiter = (client as unknown as {
            waitForAuthAck: (socket: WebSocket) => Promise<unknown>;
        }).waitForAuthAck(ws as unknown as WebSocket);

        ws.emitPacket({
            type: opType.BootstrapStatus,
            status: "building",
            vaultName: "Vault",
            message: "Building",
        });
        ws.emitPacket({
            type: opType.AuthAck,
            newClientKey: "obs_sync_rotated",
            serverRevision: "9",
        });

        await expect(waiter).resolves.toMatchObject({
            type: opType.AuthAck,
            serverRevision: "9",
        });
    });

    it("restarts startup sync when the live websocket closes after startup", async () => {
        const originalWebSocket = globalThis.WebSocket;
        const createdSockets: FakeWebSocket[] = [];
        class TestWebSocket extends FakeWebSocket {
            constructor(_url: string) {
                super();
                createdSockets.push(this);
            }
        }
        globalThis.WebSocket = TestWebSocket as unknown as typeof WebSocket;
        try {
            const { client } = await makeClient({ "notes/existing.md": "before" });
            const testClient = client as unknown as {
                ensureSocket: () => Promise<FakeWebSocket>;
                runStartupSync: () => Promise<void>;
                startupSyncPromise: Promise<void> | null;
                startupSynced: boolean;
            };
            let finishStartupSync!: () => void;
            testClient.runStartupSync = vi.fn(() => new Promise<void>(resolve => {
                finishStartupSync = resolve;
            }));

            const ws = await testClient.ensureSocket();
            expect(createdSockets).toEqual([ws]);
            testClient.startupSynced = true;

            ws.close();

            expect(testClient.startupSynced).toBe(false);
            expect(testClient.runStartupSync).toHaveBeenCalledTimes(1);
            expect(testClient.startupSyncPromise).not.toBeNull();

            finishStartupSync();
            await testClient.startupSyncPromise;
        } finally {
            globalThis.WebSocket = originalWebSocket;
        }
    });

    it("marks startup sync stale when closing a socket directly", async () => {
        const { client } = await makeClient({ "notes/existing.md": "before" });
        const testClient = client as unknown as {
            closeSocket: () => void;
            startupSynced: boolean;
        };
        testClient.startupSynced = true;

        testClient.closeSocket();

        expect(testClient.startupSynced).toBe(false);
    });

    it("uses a flat two-second reconnect delay after repeated startup failures", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-05-28T12:00:00Z"));
        try {
            const { client } = await makeClient({ "notes/existing.md": "before" });
            const testClient = client as unknown as {
                recordConnectionFailure: (error: unknown) => void;
                nextConnectAt: number;
                failedConnectAttempts: number;
            };

            testClient.recordConnectionFailure(new Error("offline"));
            expect(testClient.failedConnectAttempts).toBe(1);
            expect(testClient.nextConnectAt - Date.now()).toBe(2000);

            vi.advanceTimersByTime(2000);
            testClient.recordConnectionFailure(new Error("still offline"));
            expect(testClient.failedConnectAttempts).toBe(2);
            expect(testClient.nextConnectAt - Date.now()).toBe(2000);

            vi.advanceTimersByTime(2000);
            testClient.recordConnectionFailure(new Error("still offline"));
            expect(testClient.failedConnectAttempts).toBe(3);
            expect(testClient.nextConnectAt - Date.now()).toBe(2000);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not close the websocket when refreshing blob auth during startup sync", async () => {
        const { client } = await makeClient({ "assets/image.bin": new Uint8Array([1, 2, 3]) });
        const testClient = client as unknown as {
            startupSyncPromise: Promise<void> | null;
            closeSocket: () => void;
            refreshBlobAuth: () => Promise<string>;
            reauthenticateOpenSocket: () => Promise<void>;
        };
        testClient.startupSyncPromise = Promise.resolve();
        vi.spyOn(testClient, "reauthenticateOpenSocket").mockResolvedValue(undefined);
        const closeSpy = vi.spyOn(testClient, "closeSocket");

        await expect(testClient.refreshBlobAuth()).resolves.toBe("obs_sync_test");
        expect(closeSpy).not.toHaveBeenCalled();
    });

    it("skips snapshot reset when the target revision is already current", async () => {
        const persisted: string[] = [];
        const files = { "notes/existing.md": "before" };
        const { client } = await makeClient(files);
        const testClient = client as unknown as {
            lastPulledRevision: string;
            applySnapshotReset: (packet: unknown) => Promise<void>;
        };
        (client as unknown as {
            onLastPulledRevisionChanged: (revision: string) => Promise<void>;
        }).onLastPulledRevisionChanged = async revision => {
            persisted.push(revision);
        };
        testClient.lastPulledRevision = "104";

        await testClient.applySnapshotReset({
            type: opType.SnapshotReset,
            targetRevision: "104",
            files: [{
                mutationId: "snapshot:notes/existing.md:104",
                operation: "UpsertFile",
                path: "notes/existing.md",
                content: "after",
                storageKind: "text",
                isFolder: false,
                isYjs: true,
                created: Date.now(),
                revision: "104",
                clientId: "server",
            }],
        });

        expect(files["notes/existing.md"]).toBe("before");
        expect(persisted).toEqual([]);
    });

    it("preserves local files missing from a first-sync snapshot reset", async () => {
        const files = {
            "notes/existing.md": "local note",
            "assets/blob.pdf": new Uint8Array([1, 2, 3]),
        };
        const { client } = await makeClient(files);
        const testClient = client as unknown as {
            lastPulledRevision: string;
            applySnapshotReset: (packet: unknown) => Promise<void>;
        };
        testClient.lastPulledRevision = "0";

        await testClient.applySnapshotReset({
            type: opType.SnapshotReset,
            targetRevision: "58",
            files: [{
                mutationId: "snapshot:assets/blob.pdf:58",
                operation: "UpsertFile",
                path: "assets/blob.pdf",
                contentBytes: new Uint8Array([4, 5, 6]),
                storageKind: "bytea",
                isFolder: false,
                isYjs: false,
                created: Date.now(),
                revision: "58",
                clientId: "server",
            }],
        });

        expect(files["notes/existing.md"]).toBe("local note");
        expect(files["assets/blob.pdf"]).toEqual(new Uint8Array([4, 5, 6]));
    });

    it("queues live pushes during startup and drains them after startup sync", async () => {
        const files = { "notes/existing.md": "before" };
        const { client } = await makeClient(files);
        const liveClient = client as unknown as {
            startupSynced: boolean;
            lastPulledRevision: string;
            livePushPromise: Promise<void>;
            livePushBacklog: unknown[];
            drainLivePushBacklog: () => void;
            handleLivePush: (packet: unknown) => void;
        };
        liveClient.startupSynced = false;
        liveClient.lastPulledRevision = "1";

        liveClient.handleLivePush({
            type: opType.ChangeBatch,
            fromRevision: "1",
            serverRevision: "2",
            changes: [{
                mutationId: "remote-queued",
                operation: "UpsertFile",
                path: "notes/existing.md",
                content: "after",
                storageKind: "text",
                isFolder: false,
                isYjs: false,
                created: Date.now(),
                revision: "2",
                clientId: "other-client",
            }],
        });

        expect(files["notes/existing.md"]).toBe("before");
        expect(liveClient.livePushBacklog).toHaveLength(1);

        liveClient.startupSynced = true;
        liveClient.drainLivePushBacklog();
        await liveClient.livePushPromise;

        expect(files["notes/existing.md"]).toBe("after");
        expect(liveClient.lastPulledRevision).toBe("2");
        expect(liveClient.livePushBacklog).toHaveLength(0);
    });

    it("does not advance revision on an empty change batch with a higher server cursor", async () => {
        const persisted: string[] = [];
        const { client } = await makeClient({ "notes/existing.md": "before" });
        const testClient = client as unknown as {
            lastPulledRevision: string;
            applyChangeBatch: (packet: unknown) => Promise<void>;
        };
        (client as unknown as {
            onLastPulledRevisionChanged: (revision: string) => Promise<void>;
        }).onLastPulledRevisionChanged = async revision => {
            persisted.push(revision);
        };
        testClient.lastPulledRevision = "5";

        await testClient.applyChangeBatch({
            type: opType.ChangeBatch,
            fromRevision: "5",
            serverRevision: "9",
            changes: [],
        });

        expect(testClient.lastPulledRevision).toBe("5");
        expect(persisted).toEqual([]);
    });

    it("flushes pending local outbox before startup pull can snapshot reset", async () => {
        const order: string[] = [];
        const { client } = await makeClient({ "notes/existing.md": "local" });
        const ws = new FakeWebSocket();
        const testClient = client as unknown as {
            runStartupSync: () => Promise<void>;
            ensureAuthenticatedSocket: () => Promise<FakeWebSocket>;
            flushPendingOutboxForStartup: () => Promise<void>;
            pullSince: (_ws: FakeWebSocket, _revision: string) => Promise<unknown>;
            catchUpToServer: (_ws?: FakeWebSocket) => Promise<void>;
            livePushPromise: Promise<void>;
            startupSynced: boolean;
        };
        testClient.ensureAuthenticatedSocket = async () => ws;
        testClient.flushPendingOutboxForStartup = async () => {
            order.push("flush");
        };
        testClient.pullSince = async () => {
            order.push("pull");
            return {
                type: opType.ChangeBatch,
                fromRevision: "0",
                serverRevision: "0",
                changes: [],
            };
        };
        testClient.catchUpToServer = async () => {};
        testClient.livePushPromise = Promise.resolve();

        await testClient.runStartupSync();

        expect(order).toEqual(["flush", "pull"]);
        expect(testClient.startupSynced).toBe(true);
    });

    it("drainOutbox waits for in-flight live push before claiming a segment", async () => {
        vi.useFakeTimers();
        try {
            const outbox = new QueueOutboxStore([{ segment: { id: "segment", path: "pending.jsonl" }, rows: [] }]);
            const { client } = await makeClient({ ".obsidian/workspace.json": "{}" }, new MemoryYjsStateStore(), outbox);
            let releaseLive!: () => void;
            const liveBlocked = new Promise<void>(resolve => {
                releaseLive = resolve;
            });
            const testClient = client as unknown as {
                startupSynced: boolean;
                livePushPromise: Promise<void>;
                drainOutbox: () => Promise<void>;
                sendSegment: (_segment: OutboxSegment) => Promise<void>;
                catchUpToServer: () => Promise<void>;
            };
            testClient.startupSynced = true;
            testClient.livePushPromise = liveBlocked;
            testClient.sendSegment = vi.fn(async () => {});
            testClient.catchUpToServer = vi.fn(async () => {});

            const drain = testClient.drainOutbox();
            await Promise.resolve();
            expect(outbox.claimed).toBe(0);

            releaseLive();
            await Promise.resolve();
            await vi.advanceTimersByTimeAsync(3000);
            await drain;

            expect(outbox.claimed).toBe(1);
            expect(outbox.completed).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("catches up missed remote Yjs edits immediately after uploading an offline open-document edit", async () => {
        const path = "notes/existing.md";
        const files = { [path]: "" };
        const stateStore = new MemoryYjsStateStore();
        const initialState = docStateFromContent("", Y);
        await stateStore.put(path, initialState);
        const openDoc = new DocSync(
            new MemoryOutboxStore(),
            stateStore as unknown as YjsStateStore,
            path,
            initialState,
            true,
        );
        const localRow: outboxData = {
            mutationId: "offline-local",
            operation: "YjsUpdate",
            path,
            data: new Uint8Array(),
            created: 1,
        };
        await openDoc.applyChanges(
            EditorState.create({ doc: "" }).update({ changes: { from: 0, insert: "hello" } }).changes,
            localRow,
        );

        const remoteDoc = new Y.Doc();
        Y.applyUpdateV2(remoteDoc, initialState);
        const beforeRemote = Y.encodeStateVector(remoteDoc);
        remoteDoc.getText(MARKDOWN_FIELD).insert(0, "world");
        const remoteUpdate = Y.encodeStateAsUpdateV2(remoteDoc, beforeRemote);
        remoteDoc.destroy();

        const outbox = new QueueOutboxStore([{
            segment: { id: "segment", path: "pending.jsonl" },
            rows: [localRow],
        }]);
        const applied: string[] = [];
        const { client } = await makeClient(files, stateStore, outbox, {
            getDocSync: requested => requested === path ? openDoc : undefined,
            onOpenYjsContent: async (_path, content) => {
                applied.push(content);
                return true;
            },
        });
        const testClient = client as unknown as {
            startupSynced: boolean;
            lastPulledRevision: string;
            drainOutbox: () => Promise<void>;
            sendSegment: (_segment: OutboxSegment) => Promise<void>;
            catchUpToServer: () => Promise<void>;
            applyChangeBatch: (packet: unknown) => Promise<void>;
        };
        testClient.startupSynced = true;
        testClient.lastPulledRevision = "1";
        testClient.sendSegment = vi.fn(async () => {});
        const catchUp = vi.fn(async () => {
            await testClient.applyChangeBatch({
                type: opType.ChangeBatch,
                fromRevision: "1",
                serverRevision: "2",
                changes: [{
                    mutationId: "remote-while-offline",
                    operation: "YjsUpdate",
                    path,
                    data: remoteUpdate,
                    created: Date.now(),
                    revision: "2",
                    clientId: "desktop-client",
                }],
            });
        });
        testClient.catchUpToServer = catchUp;

        await testClient.drainOutbox();

        const merged = openDoc.getYdoc().getText(MARKDOWN_FIELD).toString();
        expect(catchUp).toHaveBeenCalledTimes(1);
        expect(merged).toContain("hello");
        expect(merged).toContain("world");
        expect(applied).toEqual([merged]);
        expect(testClient.lastPulledRevision).toBe("2");
        expect(outbox.completed).toBe(1);
        openDoc.destroy();
    });
});
