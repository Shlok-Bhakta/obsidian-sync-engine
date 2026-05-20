import { App, normalizePath, TFile, TFolder } from "obsidian";
import { YjsStateStore } from "../yjs/YjsStateStore";

export type RemoteMutationScope = {
    paths?: string[];
    operation: () => Promise<void>;
};

export class VaultMutator {
    private readonly remotePaths = new Map<string, number>();
    private remoteDepth = 0;

    constructor(
        private readonly app: App,
        private readonly stateStore: YjsStateStore,
    ) {}

    isApplyingRemoteChanges(path?: string): boolean {
        if (!path) {
            return this.remoteDepth > 0;
        }
        return (this.remotePaths.get(normalizePath(path)) ?? 0) > 0;
    }

    async runRemoteMutation<T>(paths: string[], operation: () => Promise<T>): Promise<T> {
        this.beginRemote(paths);
        try {
            return await operation();
        } finally {
            this.endRemote(paths);
        }
    }

    async ensureFolder(path: string): Promise<void> {
        const normalized = normalizePath(path);
        if (!normalized || await this.app.vault.adapter.exists(normalized)) {
            return;
        }
        const parent = dirname(normalized);
        if (parent) {
            await this.ensureFolder(parent);
        }
        try {
            await this.app.vault.createFolder(normalized);
        } catch (error) {
            if (!(await this.app.vault.adapter.exists(normalized))) {
                throw error;
            }
        }
    }

    async upsertTextFile(path: string, content: string): Promise<void> {
        const normalized = normalizePath(path);
        const parent = dirname(normalized);
        if (parent) {
            await this.ensureFolder(parent);
        }
        const existing = this.app.vault.getAbstractFileByPath(normalized);
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, content);
            return;
        }
        if (existing) {
            await this.app.fileManager.trashFile(existing);
        }
        if (await this.app.vault.adapter.exists(normalized)) {
            await this.app.vault.adapter.write(normalized, content);
            return;
        }
        try {
            await this.app.vault.create(normalized, content);
        } catch (error) {
            if (await this.app.vault.adapter.exists(normalized)) {
                await this.app.vault.adapter.write(normalized, content);
                return;
            }
            throw error;
        }
    }

    async upsertBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
        const normalized = normalizePath(path);
        const parent = dirname(normalized);
        if (parent) {
            await this.ensureFolder(parent);
        }
        const existing = this.app.vault.getAbstractFileByPath(normalized);
        if (existing instanceof TFile) {
            await this.app.vault.adapter.writeBinary(normalized, exactArrayBuffer(bytes));
            return;
        }
        if (existing) {
            await this.app.fileManager.trashFile(existing);
        }
        await this.app.vault.adapter.writeBinary(normalized, exactArrayBuffer(bytes));
    }

    async deletePath(path: string): Promise<void> {
        const normalized = normalizePath(path);
        const existing = this.app.vault.getAbstractFileByPath(normalized);
        if (existing) {
            await this.app.fileManager.trashFile(existing);
        }
        await this.stateStore.delete(normalized, existing instanceof TFolder);
    }

    async renamePath(fromPath: string, toPath: string): Promise<void> {
        const normalizedFrom = normalizePath(fromPath);
        const normalizedTo = normalizePath(toPath);
        const existing = this.app.vault.getAbstractFileByPath(normalizedFrom);
        if (!existing) {
            return;
        }
        const parent = dirname(normalizedTo);
        if (parent) {
            await this.ensureFolder(parent);
        }
        await this.app.vault.rename(existing, normalizedTo);
        await this.stateStore.rename(normalizedFrom, normalizedTo, existing instanceof TFolder);
    }

    private beginRemote(paths: string[]): void {
        this.remoteDepth++;
        for (const path of paths) {
            const normalized = normalizePath(path);
            this.remotePaths.set(normalized, (this.remotePaths.get(normalized) ?? 0) + 1);
        }
    }

    private endRemote(paths: string[]): void {
        for (const path of paths) {
            const normalized = normalizePath(path);
            const current = this.remotePaths.get(normalized) ?? 0;
            if (current <= 1) {
                this.remotePaths.delete(normalized);
            } else {
                this.remotePaths.set(normalized, current - 1);
            }
        }
        this.remoteDepth = Math.max(0, this.remoteDepth - 1);
    }
}

export function dirname(path: string): string {
    const index = path.lastIndexOf("/");
    return index === -1 ? "" : path.slice(0, index);
}

export function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
