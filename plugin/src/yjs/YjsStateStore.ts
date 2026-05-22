import { App, normalizePath, PluginManifest } from "obsidian";

export class YjsStateStore {
    private readonly dir: string;
    private mutationQueue: Promise<void> = Promise.resolve();

    constructor(private readonly app: App, manifest: PluginManifest) {
        this.dir = normalizePath(`.sync-engine-state/${manifest.id}/yjs`);
    }

    async open(): Promise<void> {
        await this.ensureDirectory(this.dir);
    }

    statePathFor(vaultPath: string): string {
        return normalizePath(`${this.dir}/${normalizePath(vaultPath)}.state`);
    }

    contentHashPathFor(vaultPath: string): string {
        return normalizePath(`${this.statePathFor(vaultPath)}.sha256`);
    }

    async has(vaultPath: string): Promise<boolean> {
        return this.app.vault.adapter.exists(this.statePathFor(vaultPath));
    }

    async get(vaultPath: string): Promise<Uint8Array | null> {
        const path = this.statePathFor(vaultPath);
        if (!(await this.app.vault.adapter.exists(path))) {
            return null;
        }
        return new Uint8Array(await this.app.vault.adapter.readBinary(path));
    }

    async put(vaultPath: string, state: Uint8Array): Promise<void> {
        return this.runSerialized(async () => {
            const path = this.statePathFor(vaultPath);
            await this.ensureDirectory(dirname(path));
            await this.app.vault.adapter.writeBinary(path, state.buffer.slice(
                state.byteOffset,
                state.byteOffset + state.byteLength,
            ));
        });
    }

    async putWithContentHash(vaultPath: string, state: Uint8Array, hash: string): Promise<void> {
        return this.runSerialized(async () => {
            const statePath = this.statePathFor(vaultPath);
            await this.ensureDirectory(dirname(statePath));
            await this.app.vault.adapter.writeBinary(statePath, state.buffer.slice(
                state.byteOffset,
                state.byteOffset + state.byteLength,
            ));
            await this.app.vault.adapter.write(this.contentHashPathFor(vaultPath), hash);
        });
    }

    async getContentHash(vaultPath: string): Promise<string | null> {
        const path = this.contentHashPathFor(vaultPath);
        if (!(await this.app.vault.adapter.exists(path))) {
            return null;
        }
        return (await this.app.vault.adapter.read(path)).trim() || null;
    }

    async putContentHash(vaultPath: string, hash: string): Promise<void> {
        return this.runSerialized(async () => {
            const path = this.contentHashPathFor(vaultPath);
            await this.ensureDirectory(dirname(path));
            await this.app.vault.adapter.write(path, hash);
        });
    }

    async rename(fromVaultPath: string, toVaultPath: string, isFolder: boolean): Promise<void> {
        return this.runSerialized(async () => {
            const fromPath = normalizePath(`${this.dir}/${normalizePath(fromVaultPath)}${isFolder ? "" : ".state"}`);
            const toPath = normalizePath(`${this.dir}/${normalizePath(toVaultPath)}${isFolder ? "" : ".state"}`);
            if (fromPath === toPath) {
                return;
            }
            if (isFolder) {
                await this.renamePathIfExists(fromPath, toPath, true);
                return;
            }
            await this.renamePathIfExists(fromPath, toPath, false);
            await this.renamePathIfExists(`${fromPath}.sha256`, `${toPath}.sha256`, false);
        });
    }

    async delete(vaultPath: string, isFolder = false): Promise<void> {
        return this.runSerialized(async () => {
            const path = normalizePath(`${this.dir}/${normalizePath(vaultPath)}${isFolder ? "" : ".state"}`);
            await this.deleteAtPath(path, isFolder);
            if (!isFolder) {
                await this.deleteAtPath(`${path}.sha256`, false);
            }
        });
    }

    private async renamePathIfExists(fromPath: string, toPath: string, isFolder: boolean): Promise<void> {
        if (!(await this.app.vault.adapter.exists(fromPath))) {
            return;
        }
        await this.ensureDirectory(dirname(toPath));
        if (await this.app.vault.adapter.exists(toPath)) {
            await this.deleteAtPath(toPath, isFolder);
        }
        try {
            await this.app.vault.adapter.rename(fromPath, toPath);
        } catch (error) {
            if (isENOENT(error) && await this.app.vault.adapter.exists(toPath)) {
                return;
            }
            throw error;
        }
    }

    private async deleteAtPath(path: string, isFolder: boolean): Promise<void> {
        if (!(await this.app.vault.adapter.exists(path))) {
            return;
        }
        if (isFolder) {
            await this.deleteTree(path);
            return;
        }
        await this.app.vault.adapter.remove(path);
    }

    private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
        const run = this.mutationQueue.then(operation, operation);
        this.mutationQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    private async deleteTree(path: string): Promise<void> {
        const listed = await this.app.vault.adapter.list(path);
        for (const file of listed.files) {
            await this.app.vault.adapter.remove(file);
        }
        for (const folder of listed.folders) {
            await this.deleteTree(folder);
        }
        await this.app.vault.adapter.rmdir(path, true);
    }

    private async ensureDirectory(path: string): Promise<void> {
        if (!path) {
            return;
        }
        const parts = path.split("/");
        let current = "";
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!(await this.app.vault.adapter.exists(current))) {
                await this.app.vault.adapter.mkdir(current);
            }
        }
    }
}

function dirname(path: string): string {
    const index = path.lastIndexOf("/");
    return index === -1 ? "" : path.slice(0, index);
}

function isENOENT(error: unknown): boolean {
    if (error && typeof error === "object" && "code" in error) {
        return (error as { code?: string }).code === "ENOENT";
    }
    return error instanceof Error && error.message.includes("ENOENT");
}
