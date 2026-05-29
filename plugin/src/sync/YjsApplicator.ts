import { normalizePath } from "obsidian";
import * as Y from "yjs";
import { MARKDOWN_FIELD, docStateFromContent } from "../../../shared/yjsSeed";
import { YjsStateStore } from "../yjs/YjsStateStore";
import { DocSync } from "../yjs/DocSync";
import { VaultMutator } from "./VaultMutator";

export type YjsApplicatorOptions = {
    stateStore: YjsStateStore;
    vaultMutator: VaultMutator;
    readVaultContent: (path: string) => Promise<string>;
    getDocSync?: (path: string) => DocSync | undefined;
    onOpenYjsContent?: (path: string, content: string) => Promise<boolean>;
    flushOpenYjsChanges?: (path: string) => Promise<void>;
};

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export class YjsApplicator {
    private readonly getDocSync: (path: string) => DocSync | undefined;
    private readonly onOpenYjsContent: (path: string, content: string) => Promise<boolean>;
    private readonly flushOpenYjsChanges: (path: string) => Promise<void>;

    constructor(private readonly options: YjsApplicatorOptions) {
        this.getDocSync = options.getDocSync ?? (() => undefined);
        this.onOpenYjsContent = options.onOpenYjsContent ?? (async () => false);
        this.flushOpenYjsChanges = options.flushOpenYjsChanges ?? (async () => {});
    }

    async applyUpdate(path: string, update: Uint8Array, serverRevision = "0"): Promise<void> {
        const normalized = normalizePath(path);
        await this.flushOpenYjsChanges(normalized);
        const openDoc = this.getDocSync(normalized);
        let content: string;
        let state: Uint8Array;
        if (openDoc) {
            content = openDoc.applyRemoteUpdate(update);
            state = Y.encodeStateAsUpdateV2(openDoc.getYdoc());
        } else {
            const doc = new Y.Doc();
            Y.applyUpdateV2(doc, await this.getOrSeedState(normalized));
            Y.applyUpdateV2(doc, update);
            content = doc.getText(MARKDOWN_FIELD).toJSON();
            state = Y.encodeStateAsUpdateV2(doc);
            doc.destroy();
        }
        await this.upsertYjsTextFile(normalized, content);
        await this.persistServerState(normalized, state, content, serverRevision);
    }

    async applyState(path: string, state: Uint8Array, serverRevision = "0"): Promise<void> {
        const normalized = normalizePath(path);
        await this.flushOpenYjsChanges(normalized);
        const openDoc = this.getDocSync(normalized);
        if (openDoc) {
            if (openDoc.hasLocalEdits()) {
                const content = openDoc.hasServerSyncedState()
                    ? openDoc.applyRemoteUpdate(state)
                    : await openDoc.rebaseLocalChangesOntoRemoteState(state);
                await this.upsertYjsTextFile(normalized, content);
                await this.persistServerState(normalized, Y.encodeStateAsUpdateV2(openDoc.getYdoc()), content, serverRevision);
                return;
            }

            const content = yjsContentFromState(state);
            await this.upsertYjsTextFile(normalized, content);
            await this.persistServerState(normalized, state, content, serverRevision);
            await openDoc.replaceState(state, serverRevision);
            return;
        }

        const content = yjsContentFromState(state);
        await this.upsertYjsTextFile(normalized, content);
        await this.persistServerState(normalized, state, content, serverRevision);
    }

    async refreshState(path: string, content: string, yjsState?: Uint8Array, serverRevision = "0"): Promise<void> {
        const state = yjsState ?? docStateFromContent(content, Y);
        const normalized = normalizePath(path);
        await this.persistServerState(normalized, state, content, serverRevision);
        const openDoc = this.getDocSync(normalized);
        if (openDoc) {
            await openDoc.replaceState(state, serverRevision);
        }
    }

    async resolveYdoc(path: string): Promise<{ doc: Y.Doc; destroy: () => void }> {
        const normalized = normalizePath(path);
        const openDoc = this.getDocSync(normalized);
        if (openDoc) {
            return {
                doc: openDoc.getYdoc(),
                destroy: () => {},
            };
        }
        const doc = new Y.Doc();
        const loadedState = await this.getOrSeedState(normalized);
        Y.applyUpdateV2(doc, loadedState);
        return { doc, destroy: () => doc.destroy() };
    }

    private async upsertYjsTextFile(path: string, content: string): Promise<void> {
        const normalized = normalizePath(path);
        if (await this.onOpenYjsContent(normalized, content)) {
            return;
        }
        await this.options.vaultMutator.upsertTextFile(normalized, content);
    }

    private async persistServerState(path: string, state: Uint8Array, content: string, serverRevision: string): Promise<void> {
        const contentHash = await sha256Hex(new TextEncoder().encode(content));
        if ("putServerSyncedState" in this.options.stateStore && typeof this.options.stateStore.putServerSyncedState === "function") {
            await this.options.stateStore.putServerSyncedState(path, state, contentHash, serverRevision);
            return;
        }
        await this.options.stateStore.put(path, state);
        await this.options.stateStore.putContentHash(path, contentHash);
    }

    private async getOrSeedState(path: string): Promise<Uint8Array> {
        const existing = await this.options.stateStore.get(path);
        if (existing) {
            return existing;
        }
        const content = await this.options.readVaultContent(path);
        const state = docStateFromContent(content, Y);
        await this.options.stateStore.put(path, state);
        await this.options.stateStore.putContentHash(path, await sha256Hex(new TextEncoder().encode(content)));
        return state;
    }
}

export function yjsContentFromState(state: Uint8Array): string {
    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, state);
    const content = doc.getText(MARKDOWN_FIELD).toJSON();
    doc.destroy();
    return content;
}
