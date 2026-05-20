import { describe, expect, it, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { VaultMutator } from "./VaultMutator";
import { YjsStateStore } from "../yjs/YjsStateStore";

class MemoryYjsStateStore {
    deleted: { path: string; isFolder: boolean }[] = [];
    renamed: { fromPath: string; toPath: string; isFolder: boolean }[] = [];

    async delete(path: string, isFolder = false): Promise<void> {
        this.deleted.push({ path, isFolder });
    }

    async rename(fromPath: string, toPath: string, isFolder: boolean): Promise<void> {
        this.renamed.push({ fromPath, toPath, isFolder });
    }
}

function makeVault(files: Record<string, string | Uint8Array> = {}) {
    const TestFile = TFile as unknown as { new(path?: string): TFile };
    const TestFolder = TFolder as unknown as { new(path?: string): TFolder };
    const loaded: Array<TFile | TFolder> = Object.keys(files).map(path => new TestFile(path));
    const folders = new Set<string>();
    const addParents = (path: string) => {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index++) {
            folders.add(parts.slice(0, index).join("/"));
        }
    };
    Object.keys(files).forEach(addParents);

    const app = {
        vault: {
            getAbstractFileByPath: (path: string) => loaded.find(file => file.path === path) ?? null,
            modify: async (file: TFile, content: string) => {
                files[file.path] = content;
            },
            create: async (path: string, content: string) => {
                files[path] = content;
                addParents(path);
                const file = new TestFile(path);
                loaded.push(file);
                return file;
            },
            createFolder: async (path: string) => {
                folders.add(path);
                const folder = new TestFolder(path);
                loaded.push(folder);
                return folder;
            },
            rename: async (file: TFile | TFolder, path: string) => {
                if (file instanceof TFile) {
                    files[path] = files[file.path] ?? "";
                    delete files[file.path];
                } else {
                    folders.delete(file.path);
                    folders.add(path);
                }
                file.path = path;
                addParents(path);
            },
            adapter: {
                exists: async (path: string) => path in files || folders.has(path),
                write: async (path: string, content: string) => {
                    files[path] = content;
                    addParents(path);
                },
                writeBinary: async (path: string, content: ArrayBuffer) => {
                    files[path] = new Uint8Array(content);
                    addParents(path);
                },
            },
        },
        fileManager: {
            trashFile: vi.fn(async (file: TFile | TFolder) => {
                if (file instanceof TFile) {
                    delete files[file.path];
                } else {
                    folders.delete(file.path);
                }
                const index = loaded.indexOf(file);
                if (index !== -1) {
                    loaded.splice(index, 1);
                }
            }),
        },
    };
    return { app, files, folders, loaded };
}

describe("VaultMutator", () => {
    it("tracks remote mutations by path while preserving the global compatibility guard", async () => {
        const { app } = makeVault();
        const stateStore = new MemoryYjsStateStore();
        const mutator = new VaultMutator(app as never, stateStore as unknown as YjsStateStore);

        await mutator.runRemoteMutation(["notes/a.md"], async () => {
            expect(mutator.isApplyingRemoteChanges()).toBe(true);
            expect(mutator.isApplyingRemoteChanges("notes/a.md")).toBe(true);
            expect(mutator.isApplyingRemoteChanges("notes/b.md")).toBe(false);
        });

        expect(mutator.isApplyingRemoteChanges()).toBe(false);
        expect(mutator.isApplyingRemoteChanges("notes/a.md")).toBe(false);
    });

    it("unwinds nested remote path tracking when the inner mutation throws", async () => {
        const { app } = makeVault();
        const stateStore = new MemoryYjsStateStore();
        const mutator = new VaultMutator(app as never, stateStore as unknown as YjsStateStore);

        await expect(mutator.runRemoteMutation(["notes/a.md"], async () => {
            expect(mutator.isApplyingRemoteChanges()).toBe(true);
            await mutator.runRemoteMutation(["notes/a.md", "notes/b.md"], async () => {
                expect(mutator.isApplyingRemoteChanges("notes/a.md")).toBe(true);
                expect(mutator.isApplyingRemoteChanges("notes/b.md")).toBe(true);
                throw new Error("remote failure");
            });
        })).rejects.toThrow("remote failure");

        expect(mutator.isApplyingRemoteChanges()).toBe(false);
        expect(mutator.isApplyingRemoteChanges("notes/a.md")).toBe(false);
        expect(mutator.isApplyingRemoteChanges("notes/b.md")).toBe(false);
    });

    it("creates missing parent folders before writing a new text file", async () => {
        const { app, files, folders } = makeVault();
        const mutator = new VaultMutator(app as never, new MemoryYjsStateStore() as unknown as YjsStateStore);

        await mutator.upsertTextFile("notes/deep/file.md", "content");

        expect(folders.has("notes")).toBe(true);
        expect(folders.has("notes/deep")).toBe(true);
        expect(files["notes/deep/file.md"]).toBe("content");
    });

    it("replaces a loaded folder collision before writing a text file at the same path", async () => {
        const { app, files, folders } = makeVault();
        const stateStore = new MemoryYjsStateStore();
        const mutator = new VaultMutator(app as never, stateStore as unknown as YjsStateStore);
        await app.vault.createFolder("notes/collision");

        await mutator.upsertTextFile("notes/collision", "now a file");

        expect(folders.has("notes/collision")).toBe(false);
        expect(files["notes/collision"]).toBe("now a file");
        expect(app.fileManager.trashFile).toHaveBeenCalledTimes(1);
    });

    it("writes only the provided Uint8Array slice for binary upserts", async () => {
        const { app, files } = makeVault();
        const mutator = new VaultMutator(app as never, new MemoryYjsStateStore() as unknown as YjsStateStore);
        const backing = new Uint8Array([9, 1, 2, 3, 9]);

        await mutator.upsertBinaryFile("assets/slice.bin", backing.subarray(1, 4));

        expect(files["assets/slice.bin"]).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("renames vault content and its persisted Yjs state together", async () => {
        const { app, files } = makeVault({ "notes/old.md": "content" });
        const stateStore = new MemoryYjsStateStore();
        const mutator = new VaultMutator(app as never, stateStore as unknown as YjsStateStore);

        await mutator.renamePath("notes/old.md", "archive/new.md");

        expect(files["notes/old.md"]).toBeUndefined();
        expect(files["archive/new.md"]).toBe("content");
        expect(stateStore.renamed).toEqual([{
            fromPath: "notes/old.md",
            toPath: "archive/new.md",
            isFolder: false,
        }]);
    });

    it("deletes vault content and its persisted Yjs state together", async () => {
        const { app, files } = makeVault({ "notes/delete.md": "content" });
        const stateStore = new MemoryYjsStateStore();
        const mutator = new VaultMutator(app as never, stateStore as unknown as YjsStateStore);

        await mutator.deletePath("notes/delete.md");

        expect(files["notes/delete.md"]).toBeUndefined();
        expect(stateStore.deleted).toEqual([{ path: "notes/delete.md", isFolder: false }]);
    });

    it("deletes loaded folders as folder-scoped persisted Yjs state", async () => {
        const { app, folders } = makeVault();
        const stateStore = new MemoryYjsStateStore();
        const mutator = new VaultMutator(app as never, stateStore as unknown as YjsStateStore);
        await app.vault.createFolder("notes/folder");

        await mutator.deletePath("notes/folder");

        expect(folders.has("notes/folder")).toBe(false);
        expect(stateStore.deleted).toEqual([{ path: "notes/folder", isFolder: true }]);
    });
});
