import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { TFile } from "obsidian";
import { docStateFromContent, MARKDOWN_FIELD } from "../../../shared/yjsSeed";
import { VaultYjsIndexer } from "./VaultYjsIndexer";
import { YjsStateStore } from "./YjsStateStore";

class MemoryYjsStateStore {
    states = new Map<string, Uint8Array>();
    hashes = new Map<string, string>();

    async getContentHash(path: string): Promise<string | null> {
        return this.hashes.get(path) ?? null;
    }

    async has(path: string): Promise<boolean> {
        return this.states.has(path);
    }

    async putWithContentHash(path: string, state: Uint8Array, hash: string): Promise<void> {
        this.states.set(path, new Uint8Array(state));
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

function makeFile(path: string): TFile {
    const file = new TFile();
    (file as TFile & { path: string; extension: string }).path = path;
    (file as TFile & { path: string; extension: string }).extension = path.split(".").pop() ?? "";
    return file;
}

function readYjsContent(state: Uint8Array): string {
    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, state);
    const content = doc.getText(MARKDOWN_FIELD).toString();
    doc.destroy();
    return content;
}

async function sha256Hex(content: string): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function makeIndexer(
    files: Record<string, string>,
    store = new MemoryYjsStateStore(),
    onIndexedChange = vi.fn(),
): { indexer: VaultYjsIndexer; store: MemoryYjsStateStore; onIndexedChange: ReturnType<typeof vi.fn> } {
    const markdownFiles = Object.keys(files).map(makeFile);
    const app = {
        vault: {
            read: async (file: TFile) => files[file.path] ?? "",
            getMarkdownFiles: () => markdownFiles,
        },
    };
    return {
        indexer: new VaultYjsIndexer(
            app as never,
            store as unknown as YjsStateStore,
            () => false,
            onIndexedChange,
        ),
        store,
        onIndexedChange,
    };
}

describe("VaultYjsIndexer", () => {
    it("baselines missing Yjs state during startup scan without reporting local changes", async () => {
        const { indexer, store, onIndexedChange } = makeIndexer({
            "Notes/a.md": "from bootstrap zip",
        });

        indexer.start();
        await indexer.waitForInitialScan();

        expect(onIndexedChange).not.toHaveBeenCalled();
        expect(readYjsContent(store.states.get("Notes/a.md")!)).toBe("from bootstrap zip");
        expect(store.hashes.get("Notes/a.md")).toBe(await sha256Hex("from bootstrap zip"));
    });

    it("reports markdown files whose cached content hash changed", async () => {
        const { indexer, store, onIndexedChange } = makeIndexer({
            "Notes/a.md": "current",
        });
        store.states.set("Notes/a.md", docStateFromContent("old", Y));
        store.hashes.set("Notes/a.md", "old-hash");

        await indexer.ensureFile(makeFile("Notes/a.md"));

        expect(onIndexedChange).toHaveBeenCalledTimes(1);
        expect(onIndexedChange.mock.calls[0]?.[0]).toMatchObject({
            path: "Notes/a.md",
            content: "current",
        });
        expect(readYjsContent(store.states.get("Notes/a.md")!)).toBe("current");
    });

    it("does not report markdown files whose cached content hash still matches", async () => {
        const content = "unchanged";
        const store = new MemoryYjsStateStore();
        store.states.set("Notes/a.md", docStateFromContent(content, Y));
        store.hashes.set("Notes/a.md", await sha256Hex(content));
        const { indexer, onIndexedChange } = makeIndexer({ "Notes/a.md": content }, store);

        await indexer.ensureFile(makeFile("Notes/a.md"));

        expect(onIndexedChange).not.toHaveBeenCalled();
    });
});
