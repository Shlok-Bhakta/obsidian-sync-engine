import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { TFile, TFolder } from "obsidian";
import { MARKDOWN_FIELD } from "../../../shared/yjsSeed";
import { opType, outboxData } from "../../../shared/types";
import { SyncClient } from "./SyncClient";
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

class MemoryYjsStateStore {
    states = new Map<string, Uint8Array>();

    async get(path: string): Promise<Uint8Array | null> {
        return this.states.get(path) ?? null;
    }

    async put(path: string, state: Uint8Array): Promise<void> {
        this.states.set(path, new Uint8Array(state));
    }
}

function readYjsContent(state: Uint8Array): string {
    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, state);
    const content = doc.getText(MARKDOWN_FIELD).toString();
    doc.destroy();
    return content;
}

async function makeClient(
    files: Record<string, string | Uint8Array>,
    stateStore = new MemoryYjsStateStore(),
    outbox = new MemoryOutboxStore(),
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

    it("drops stale ignored rows while preparing an outbox segment", async () => {
        const outbox = new MemoryOutboxStore([
            {
                mutationId: "ignored",
                operation: "UpsertFile",
                path: ".obsidian/plugins/obsidian-sync-engine/.hotreload",
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
        expect(jsonl).not.toContain(".hotreload");
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

    it("does not regress lastPulledRevision when a stale live push finishes after a batch ack", async () => {
        const persisted: string[] = [];
        const { client } = await makeClient({ "notes/existing.md": "before" });
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
        expect(persisted).toEqual(["3"]);
    });
});
