import { describe, expect, it } from "vitest";
import { App, normalizePath, PluginManifest } from "obsidian";
import { YjsStateStore } from "./YjsStateStore";

class MemoryAdapter {
    private readonly files = new Map<string, Uint8Array>();
    private readonly dirs = new Set<string>();

    async exists(path: string): Promise<boolean> {
        return this.files.has(path) || this.dirs.has(path);
    }

    async mkdir(path: string): Promise<void> {
        this.dirs.add(normalizePath(path));
    }

    async readBinary(path: string): Promise<ArrayBuffer> {
        const bytes = this.files.get(path);
        if (!bytes) {
            throw new Error(`ENOENT: ${path}`);
        }
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    }

    async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
        this.files.set(normalizePath(path), new Uint8Array(data));
    }

    async remove(path: string): Promise<void> {
        this.files.delete(normalizePath(path));
    }

    async rename(from: string, to: string): Promise<void> {
        from = normalizePath(from);
        to = normalizePath(to);
        if (this.dirs.has(from)) {
            this.dirs.delete(from);
            this.dirs.add(to);
            const prefix = `${from}/`;
            for (const file of [...this.files.keys()]) {
                if (file === from || file.startsWith(prefix)) {
                    const next = file === from ? to : `${to}/${file.slice(prefix.length)}`;
                    this.files.set(normalizePath(next), this.files.get(file)!);
                    this.files.delete(file);
                }
            }
            for (const dir of [...this.dirs]) {
                if (dir === from || dir.startsWith(prefix)) {
                    const next = dir === from ? to : `${to}/${dir.slice(prefix.length)}`;
                    this.dirs.delete(dir);
                    this.dirs.add(normalizePath(next));
                }
            }
            return;
        }
        const bytes = this.files.get(from);
        if (!bytes) {
            const error = new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`) as Error & { code: string };
            error.code = "ENOENT";
            throw error;
        }
        this.files.set(to, bytes);
        this.files.delete(from);
    }

    async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        path = normalizePath(path);
        const prefix = `${path}/`;
        const files: string[] = [];
        const folders: string[] = [];
        for (const file of this.files.keys()) {
            if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) {
                files.push(file);
            }
        }
        for (const dir of this.dirs) {
            if (dir.startsWith(prefix) && dir !== path && !dir.slice(prefix.length).includes("/")) {
                folders.push(dir);
            }
        }
        return { files, folders };
    }

    async rmdir(path: string): Promise<void> {
        this.dirs.delete(normalizePath(path));
    }
}

function makeStore(): { store: YjsStateStore; adapter: MemoryAdapter; yjsDir: string } {
    const adapter = new MemoryAdapter();
    const manifest = { id: "obsidian-sync-engine" } as PluginManifest;
    const app = {
        vault: {
            configDir: ".obsidian",
            adapter,
        },
    } as unknown as App;
    const store = new YjsStateStore(app, manifest);
    const yjsDir = normalizePath(".obsidian/plugins/obsidian-sync-engine/yjs-state");
    return { store, adapter, yjsDir };
}

describe("YjsStateStore.rename", () => {
    it("serializes folder and child renames without losing state", async () => {
        const { store, adapter, yjsDir } = makeStore();
        await store.open();

        const noteStatePath = normalizePath(`${yjsDir}/notes/test.md.state`);
        await adapter.writeBinary(noteStatePath, new Uint8Array([1, 2, 3]).buffer);

        await Promise.all([
            store.rename("notes", "notess", true),
            store.rename("notes/test.md", "notess/test.md", false),
        ]);

        const movedStatePath = normalizePath(`${yjsDir}/notess/test.md.state`);
        expect(await adapter.exists(movedStatePath)).toBe(true);
        expect(await adapter.exists(noteStatePath)).toBe(false);
        expect(await store.get("notess/test.md")).toEqual(new Uint8Array([1, 2, 3]));
    });
});
