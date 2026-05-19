import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { TFile, TFolder } from "obsidian";
import { MARKDOWN_FIELD } from "../../../shared/yjsSeed";
import { opType, outboxData } from "../../../shared/types";
import { SyncClient } from "./SyncClient";
import { YjsStateStore } from "../yjs/YjsStateStore";
import { OutboxSegment, OutboxStore } from "../db/db";

class MemoryOutboxStore implements OutboxStore {
    async open(): Promise<void> {}
    async close(): Promise<void> {}
    async putInOutbox(_row: outboxData): Promise<number> { return 1; }
    async hasPendingChanges(): Promise<boolean> { return false; }
    async claimNextSegment(_sealActive: boolean): Promise<OutboxSegment | null> { return null; }
    async readSegmentJsonl(_segment: OutboxSegment): Promise<string> { return ""; }
    async readSegment(_segment: OutboxSegment): Promise<outboxData[]> { return []; }
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

async function makeClient(files: Record<string, string | Uint8Array>, stateStore = new MemoryYjsStateStore()): Promise<{
    client: SyncClient;
    stateStore: MemoryYjsStateStore;
}> {
    const TestFile = TFile as unknown as { new(path?: string): TFile };
    const TestFolder = TFolder as unknown as { new(path?: string): TFolder };
    const loaded = [
        new TestFolder("notes"),
        new TestFile("notes/existing.md"),
        new TestFile("assets/image.bin"),
    ];
    const textDecoder = new TextDecoder();
    const textEncoder = new TextEncoder();
    const app = {
        vault: {
            configDir: ".obsidian",
            getAllLoadedFiles: () => loaded,
            getAbstractFileByPath: (path: string) => loaded.find(file => file.path === path) ?? null,
            read: async (file: { path: string }) => {
                const value = files[file.path];
                return typeof value === "string" ? value : textDecoder.decode(value);
            },
            adapter: {
                exists: async (path: string) => path === ".obsidian" || path === ".obsidian/plugins" || path in files,
                list: async (path: string) => path === ".obsidian"
                    ? { folders: [], files: [".obsidian/workspace.json"] }
                    : { folders: [], files: [] },
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
            },
        },
    };

    const client = new SyncClient(
        app as never,
        new MemoryOutboxStore(),
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
});
