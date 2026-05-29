import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditorState } from "@codemirror/state";
import { TFile } from "obsidian";
import { docStateFromContent, MARKDOWN_FIELD } from "../../../shared/yjsSeed";
import { YjsApplicator } from "./YjsApplicator";
import { VaultMutator } from "./VaultMutator";
import { YjsStateStore } from "../yjs/YjsStateStore";
import { DocSync } from "../yjs/DocSync";
import { OutboxStore } from "../db/db";
import { outboxData } from "../../../shared/types";

class MemoryStateStore {
    states = new Map<string, Uint8Array>();
    hashes = new Map<string, string>();

    async get(path: string): Promise<Uint8Array | null> {
        return this.states.get(path) ?? null;
    }

    async put(path: string, state: Uint8Array): Promise<void> {
        this.states.set(path, new Uint8Array(state));
    }

    async putContentHash(path: string, hash: string): Promise<void> {
        this.hashes.set(path, hash);
    }

    async delete(_path: string, _isFolder = false): Promise<void> {}
    async rename(fromPath: string, toPath: string): Promise<void> {
        const state = this.states.get(fromPath);
        if (!state) {
            return;
        }
        this.states.delete(fromPath);
        this.states.set(toPath, state);
    }
}

class MemoryOutbox implements OutboxStore {
    rows: outboxData[] = [];

    async open(): Promise<void> {}
    async close(): Promise<void> {}
    async putInOutbox(row: outboxData): Promise<number> {
        this.rows.push(row);
        return this.rows.length;
    }
    async hasPendingChanges(): Promise<boolean> { return false; }
    async claimNextSegment(): Promise<null> { return null; }
    async readSegmentJsonl(): Promise<string> { return ""; }
    async readSegment(): Promise<outboxData[]> { return []; }
    async completeSegment(): Promise<void> {}
    async releaseSegment(): Promise<void> {}
}

function readYjsContent(state: Uint8Array): string {
    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, state);
    const content = doc.getText(MARKDOWN_FIELD).toJSON();
    doc.destroy();
    return content;
}

function makeApplicator(
    files: Record<string, string>,
    stateStore = new MemoryStateStore(),
    options: {
        getDocSync?: (path: string) => DocSync | undefined;
        onOpenYjsContent?: (path: string, content: string) => Promise<boolean>;
        flushOpenYjsChanges?: (path: string) => Promise<void>;
    } = {},
) {
    const TestFile = TFile as unknown as { new(path?: string): TFile };
    const loaded = Object.keys(files).map(path => new TestFile(path));
    const app = {
        vault: {
            getAbstractFileByPath: (path: string) => loaded.find(file => file.path === path) ?? null,
            read: async (file: TFile) => files[file.path] ?? "",
            modify: async (file: TFile, content: string) => {
                files[file.path] = content;
            },
            create: async (path: string, content: string) => {
                files[path] = content;
                const file = new TestFile(path);
                loaded.push(file);
                return file;
            },
            createFolder: async () => undefined,
            adapter: {
                exists: async (path: string) => path in files,
                write: async (path: string, content: string) => {
                    files[path] = content;
                },
            },
        },
        fileManager: {
            trashFile: async (file: TFile) => {
                delete files[file.path];
            },
        },
    };
    const vaultMutator = new VaultMutator(app as never, stateStore as unknown as YjsStateStore);
    return new YjsApplicator({
        stateStore: stateStore as unknown as YjsStateStore,
        vaultMutator,
        readVaultContent: path => Promise.resolve(files[path] ?? ""),
        ...options,
    });
}

describe("YjsApplicator", () => {
    it("applies a remote update to a closed document and persists the merged state", async () => {
        const files = { "notes/a.md": "base" };
        const stateStore = new MemoryStateStore();
        const initialState = docStateFromContent("base", Y);
        await stateStore.put("notes/a.md", initialState);
        const applicator = makeApplicator(files, stateStore);

        const baseDoc = new Y.Doc();
        Y.applyUpdateV2(baseDoc, initialState);
        const baseVector = Y.encodeStateVector(baseDoc);
        baseDoc.destroy();
        const remote = new Y.Doc();
        Y.applyUpdateV2(remote, initialState);
        remote.getText(MARKDOWN_FIELD).insert(4, " remote");
        const update = Y.encodeStateAsUpdateV2(remote, baseVector);
        remote.destroy();

        await applicator.applyUpdate("notes/a.md", update);

        expect(files["notes/a.md"]).toBe("base remote");
        expect(readYjsContent(stateStore.states.get("notes/a.md")!)).toBe("base remote");
    });

    it("flushes open-editor changes before merging a full remote state", async () => {
        const files = { "notes/a.md": "base" };
        const stateStore = new MemoryStateStore();
        const initialState = docStateFromContent("base", Y);
        await stateStore.put("notes/a.md", initialState);
        const openDoc = new DocSync(
            new MemoryOutbox(),
            stateStore as unknown as YjsStateStore,
            "notes/a.md",
            initialState,
        );
        const applied: string[] = [];
        const applicator = makeApplicator(files, stateStore, {
            getDocSync: path => path === "notes/a.md" ? openDoc : undefined,
            onOpenYjsContent: async (_path, content) => {
                applied.push(content);
                return true;
            },
            flushOpenYjsChanges: async () => {
                const transaction = EditorState.create({ doc: "base" }).update({
                    changes: { from: 4, insert: " local" },
                });
                await openDoc.applyChanges(transaction.changes, {
                    mutationId: crypto.randomUUID(),
                    operation: "YjsUpdate",
                    path: "notes/a.md",
                    data: new Uint8Array(),
                    created: Date.now(),
                });
            },
        });

        const remote = new Y.Doc();
        Y.applyUpdateV2(remote, initialState);
        remote.getText(MARKDOWN_FIELD).insert(4, " remote");
        const remoteState = Y.encodeStateAsUpdateV2(remote);
        remote.destroy();

        await applicator.applyState("notes/a.md", remoteState);

        const merged = openDoc.getYdoc().getText(MARKDOWN_FIELD).toJSON();
        expect(merged).toContain("base");
        expect(merged).toContain("local");
        expect(merged).toContain("remote");
        expect(applied).toEqual([merged]);
        expect(readYjsContent(stateStore.states.get("notes/a.md")!)).toBe(merged);
    });

    it("rebases stale open-document edits onto an independent remote full state", async () => {
        const files = { "notes/a.md": "base" };
        const stateStore = new MemoryStateStore();
        const localSeed = docStateFromContent("base", Y);
        await stateStore.put("notes/a.md", localSeed);
        const openDoc = new DocSync(
            new MemoryOutbox(),
            stateStore as unknown as YjsStateStore,
            "notes/a.md",
            localSeed,
        );
        const localEdit = EditorState.create({ doc: "base" }).update({
            changes: { from: 4, insert: " local" },
        });
        await openDoc.applyChanges(localEdit.changes, {
            mutationId: crypto.randomUUID(),
            operation: "YjsUpdate",
            path: "notes/a.md",
            data: new Uint8Array(),
            created: Date.now(),
        });

        const applied: string[] = [];
        const applicator = makeApplicator(files, stateStore, {
            getDocSync: path => path === "notes/a.md" ? openDoc : undefined,
            onOpenYjsContent: async (_path, content) => {
                applied.push(content);
                return true;
            },
        });
        const remoteState = docStateFromContent("base remote", Y);

        await applicator.applyState("notes/a.md", remoteState);

        expect(applied).toEqual(["base remote local"]);
        expect(openDoc.getYdoc().getText(MARKDOWN_FIELD).toString()).toBe("base remote local");
        expect(readYjsContent(stateStore.states.get("notes/a.md")!)).toBe("base remote local");
        expect(openDoc.hasServerSyncedState()).toBe(false);
    });
});
