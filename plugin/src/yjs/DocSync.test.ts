import { EditorState, ChangeSpec, ChangeSet } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { OutboxSegment, OutboxStore } from "../db/db";
import { outboxData } from "../../../shared/types";
import { docStateFromContent, MARKDOWN_FIELD } from "../../../shared/yjsSeed";
import { DocSync } from "./DocSync";
import { YjsStateStore } from "./YjsStateStore";

const PATH = "notes/typing.md";

class MemoryOutboxStore implements OutboxStore {
    rows: outboxData[] = [];

    async open(): Promise<void> {}
    async close(): Promise<void> {}

    async putInOutbox(row: outboxData): Promise<number> {
        const id = this.rows.length + 1;
        this.rows.push({ ...row, id, data: row.data ? new Uint8Array(row.data) : undefined });
        return id;
    }

    async hasPendingChanges(): Promise<boolean> {
        return this.rows.length > 0;
    }

    async claimNextSegment(_sealActive: boolean): Promise<OutboxSegment | null> {
        return null;
    }

    async readSegmentJsonl(_segment: OutboxSegment): Promise<string> {
        return "";
    }

    async readSegment(_segment: OutboxSegment): Promise<outboxData[]> {
        return [];
    }

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

function decodeContent(update: Uint8Array): string {
    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, update);
    const text = doc.getText(MARKDOWN_FIELD).toString();
    doc.destroy();
    return text;
}

function applyChanges(doc: DocSync, changes: ChangeSet): outboxData {
    const row: outboxData = {
        mutationId: crypto.randomUUID(),
        operation: "YjsUpdate",
        path: PATH,
        data: new Uint8Array(),
        created: Date.now(),
    };
    doc.applyChanges(changes, row);
    return row;
}

function editorChange(doc: string, changes: ChangeSpec | readonly ChangeSpec[]): {
    changes: ChangeSet;
    nextDoc: string;
} {
    const transaction = EditorState.create({ doc }).update({ changes });
    return {
        changes: transaction.changes,
        nextDoc: transaction.state.doc.toString(),
    };
}

async function tick(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function setup(initialContent: string): {
    docSync: DocSync;
    outbox: MemoryOutboxStore;
    stateStore: MemoryYjsStateStore;
    initialState: Uint8Array;
} {
    const outbox = new MemoryOutboxStore();
    const stateStore = new MemoryYjsStateStore();
    const initialState = docStateFromContent(initialContent, Y);
    const docSync = new DocSync(
        outbox,
        stateStore as unknown as YjsStateStore,
        PATH,
        initialState,
    );

    return { docSync, outbox, stateStore, initialState };
}

describe("DocSync editor typing", () => {
    it("records each typed character as an outbox YjsUpdate and checkpoints on explicit persist", async () => {
        const { docSync, outbox, stateStore } = setup("");
        let editorDoc = "";

        for (const char of ["h", "e", "l", "l", "o"]) {
            const update = editorChange(editorDoc, { from: editorDoc.length, insert: char });
            editorDoc = update.nextDoc;
            applyChanges(docSync, update.changes);
        }

        await tick();

        expect(editorDoc).toBe("hello");
        expect(outbox.rows).toHaveLength(5);
        expect(outbox.rows.every(row => row.operation === "YjsUpdate" && row.path === PATH)).toBe(true);
        expect(outbox.rows.every(row => row.data && row.data.length > 0)).toBe(true);
        expect(stateStore.states.get(PATH)).toBeUndefined();
        await docSync.persistState();
        expect(decodeContent(stateStore.states.get(PATH)!)).toBe("hello");
    });

    it("keeps up with a fast 1000 character input burst", async () => {
        const { docSync, outbox, stateStore } = setup("");
        let editorDoc = "";
        const input = "asdf".repeat(250);

        for (const char of input) {
            const update = editorChange(editorDoc, { from: editorDoc.length, insert: char });
            const before = editorDoc;
            editorDoc = update.nextDoc;
            await docSync.applyChanges(update.changes, {
                mutationId: crypto.randomUUID(),
                operation: "YjsUpdate",
                path: PATH,
                data: new Uint8Array(),
                created: Date.now(),
            }, undefined, before, editorDoc);
        }

        expect(editorDoc).toHaveLength(1000);
        expect(outbox.rows).toHaveLength(1000);
        expect(docSync.getYdoc().getText(MARKDOWN_FIELD).toString()).toBe(input);
        await docSync.persistState();
        expect(decodeContent(stateStore.states.get(PATH)!)).toBe(input);
    });

    it("repairs stale local Yjs text before applying an editor changeset", async () => {
        const { docSync, stateStore } = setup("asdf");
        const update = editorChange("asdfasdf", { from: 8, insert: "asdf" });

        await docSync.applyChanges(update.changes, {
            mutationId: crypto.randomUUID(),
            operation: "YjsUpdate",
            path: PATH,
            data: new Uint8Array(),
            created: Date.now(),
        }, undefined, "asdfasdf", update.nextDoc);

        expect(update.nextDoc).toBe("asdfasdfasdf");
        expect(docSync.getYdoc().getText(MARKDOWN_FIELD).toString()).toBe(update.nextDoc);
        await docSync.persistState();
        expect(decodeContent(stateStore.states.get(PATH)!)).toBe(update.nextDoc);
    });

    it("applies a paste transaction as one coalesced update", async () => {
        const { docSync, outbox, stateStore } = setup("title");
        const update = editorChange("title", { from: 5, insert: "\n\nbody line 1\nbody line 2" });

        const row = applyChanges(docSync, update.changes);
        await tick();

        expect(update.nextDoc).toBe("title\n\nbody line 1\nbody line 2");
        expect(outbox.rows).toHaveLength(1);
        expect(outbox.rows[0]?.data).toEqual(row.data);
        await docSync.persistState();
        expect(decodeContent(stateStore.states.get(PATH)!)).toBe(update.nextDoc);
    });

    it("handles backspace-style deletion", async () => {
        const { docSync, outbox, stateStore } = setup("hello!");
        const update = editorChange("hello!", { from: 5, to: 6 });

        applyChanges(docSync, update.changes);
        await tick();

        expect(update.nextDoc).toBe("hello");
        expect(outbox.rows).toHaveLength(1);
        await docSync.persistState();
        expect(decodeContent(stateStore.states.get(PATH)!)).toBe("hello");
    });

    it("handles selected text replacement", async () => {
        const { docSync, stateStore } = setup("hello old world");
        const update = editorChange("hello old world", { from: 6, to: 9, insert: "new" });

        applyChanges(docSync, update.changes);
        await tick();

        expect(update.nextDoc).toBe("hello new world");
        await docSync.persistState();
        expect(decodeContent(stateStore.states.get(PATH)!)).toBe("hello new world");
    });

    it("handles one transaction with multiple disjoint edits", async () => {
        const { docSync, outbox, stateStore } = setup("hello world");
        const update = editorChange("hello world", [
            { from: 0, to: 1, insert: "H" },
            { from: 11, insert: "!" },
        ]);

        applyChanges(docSync, update.changes);
        await tick();

        expect(update.nextDoc).toBe("Hello world!");
        expect(outbox.rows).toHaveLength(1);
        await docSync.persistState();
        expect(decodeContent(stateStore.states.get(PATH)!)).toBe("Hello world!");
    });

    it("handles one transaction with multiple edits that change document length", async () => {
        const { docSync, stateStore } = setup("hello world again");
        const update = editorChange("hello world again", [
            { from: 0, insert: "Say " },
            { from: 6, to: 11, insert: "there" },
            { from: 17, insert: "!" },
        ]);

        applyChanges(docSync, update.changes);
        await tick();

        expect(update.nextDoc).toBe("Say hello there again!");
        await docSync.persistState();
        expect(decodeContent(stateStore.states.get(PATH)!)).toBe(update.nextDoc);
    });

    it("remote updates merge into the open document and persist", async () => {
        const { docSync, stateStore, initialState } = setup("hello");
        const remote = new Y.Doc();
        Y.applyUpdateV2(remote, initialState);
        remote.getText(MARKDOWN_FIELD).insert(5, " from another device");
        const content = docSync.applyRemoteUpdate(Y.encodeStateAsUpdateV2(remote));
        remote.destroy();

        await tick();

        expect(content).toBe("hello from another device");
        await docSync.persistState();
        expect(decodeContent(stateStore.states.get(PATH)!)).toBe("hello from another device");
    });

    it("refuses to replace state when local edits advanced the open document", async () => {
        const { docSync, stateStore } = setup("qwertyuiop");
        const expectedRevision = docSync.getLocalRevision();
        const update = editorChange("qwertyuiop", { from: 9, to: 10 });

        applyChanges(docSync, update.changes);
        const replaced = await docSync.replaceStateIfRevision(docStateFromContent("stale", Y), expectedRevision);
        await tick();

        expect(replaced).toBe(false);
        expect(docSync.getYdoc().getText(MARKDOWN_FIELD).toString()).toBe("qwertyuio");
        await docSync.persistState();
        expect(decodeContent(stateStore.states.get(PATH)!)).toBe("qwertyuio");
    });
});
