import { App, normalizePath, PluginManifest } from "obsidian";

export class YjsStateStore {
    private readonly dir: string;

    constructor(private readonly app: App, manifest: PluginManifest) {
        this.dir = normalizePath(`${app.vault.configDir}/plugins/${manifest.id}/yjs-state`);
    }

    async open(): Promise<void> {
        await this.ensureDirectory(this.dir);
    }

    statePathFor(vaultPath: string): string {
        return normalizePath(`${this.dir}/${normalizePath(vaultPath)}.state`);
    }

    async get(vaultPath: string): Promise<Uint8Array | null> {
        const path = this.statePathFor(vaultPath);
        if (!(await this.app.vault.adapter.exists(path))) {
            return null;
        }
        return new Uint8Array(await this.app.vault.adapter.readBinary(path));
    }

    async put(vaultPath: string, state: Uint8Array): Promise<void> {
        const path = this.statePathFor(vaultPath);
        await this.ensureDirectory(dirname(path));
        await this.app.vault.adapter.writeBinary(path, state.buffer.slice(
            state.byteOffset,
            state.byteOffset + state.byteLength,
        ));
    }

    async rename(fromVaultPath: string, toVaultPath: string, isFolder: boolean): Promise<void> {
        const fromPath = normalizePath(`${this.dir}/${normalizePath(fromVaultPath)}${isFolder ? "" : ".state"}`);
        const toPath = normalizePath(`${this.dir}/${normalizePath(toVaultPath)}${isFolder ? "" : ".state"}`);
        if (!(await this.app.vault.adapter.exists(fromPath))) {
            return;
        }
        await this.ensureDirectory(dirname(toPath));
        await this.delete(toVaultPath, isFolder);
        await this.app.vault.adapter.rename(fromPath, toPath);
    }

    async delete(vaultPath: string, isFolder = false): Promise<void> {
        const path = normalizePath(`${this.dir}/${normalizePath(vaultPath)}${isFolder ? "" : ".state"}`);
        if (!(await this.app.vault.adapter.exists(path))) {
            return;
        }
        if (isFolder) {
            await this.deleteTree(path);
            return;
        }
        await this.app.vault.adapter.remove(path);
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
