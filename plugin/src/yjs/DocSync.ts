import { OutboxStore } from "db/db";
import * as Y from 'yjs';
import { ChangeSet } from "@codemirror/state";
import { outboxData } from "../../../shared/types";
import { MARKDOWN_FIELD } from "../../../shared/yjsSeed";
import { YjsStateStore } from "./YjsStateStore";
import { errorContext } from "../../../shared/logger";
import { log } from "../logger";

// one stop shop for all the document syncing needs

const CHECKPOINT_DEBOUNCE_MS = 2000;
const CHECKPOINT_MAX_LOCAL_EDITS = 100;

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function contentFromState(state: Uint8Array): string {
    const doc = new Y.Doc();
    if (state.byteLength > 0) {
        Y.applyUpdateV2(doc, state);
    }
    const content = doc.getText(MARKDOWN_FIELD).toJSON();
    doc.destroy();
    return content;
}

function changedRange(before: string, after: string): { from: number; to: number; insert: string } | null {
    if (before === after) {
        return null;
    }
    let prefix = 0;
    while (prefix < before.length && prefix < after.length && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
        prefix++;
    }
    let beforeSuffix = before.length;
    let afterSuffix = after.length;
    while (
        beforeSuffix > prefix &&
        afterSuffix > prefix &&
        before.charCodeAt(beforeSuffix - 1) === after.charCodeAt(afterSuffix - 1)
    ) {
        beforeSuffix--;
        afterSuffix--;
    }
    return {
        from: prefix,
        to: beforeSuffix,
        insert: after.slice(prefix, afterSuffix),
    };
}

export function rebaseLocalTextChange(base: string, local: string, remote: string): string {
    if (local === base) {
        return remote;
    }
    if (remote === base) {
        return local;
    }

    const change = changedRange(base, local);
    if (!change) {
        return remote;
    }

    if (change.from === base.length && change.to === base.length) {
        return `${remote}${change.insert}`;
    }
    if (change.from === 0 && change.to === 0) {
        return `${change.insert}${remote}`;
    }

    const prefix = base.slice(0, change.from);
    const suffix = base.slice(change.to);
    if (remote.startsWith(prefix) && remote.endsWith(suffix) && remote.length >= prefix.length + suffix.length) {
        return `${remote.slice(0, prefix.length)}${change.insert}${remote.slice(remote.length - suffix.length)}`;
    }

    if (local.startsWith(base)) {
        return `${remote}${local.slice(base.length)}`;
    }

    return local;
}

export class DocSync {
    private db: OutboxStore;
    private ydoc = new Y.Doc();
    private ytext = this.ydoc.getText(MARKDOWN_FIELD);
    private openedTime = Date.now();
    private localRevision = 0;
    private localEditRevision = 0;
    private checkpointTimer: ReturnType<typeof setTimeout> | null = null;
    private checkpointPromise: Promise<void> = Promise.resolve();
    private editsSinceCheckpoint = 0;
    private serverSyncedState = false;
    private serverBaseContent: string;


    constructor(
        db: OutboxStore,
        private readonly stateStore: YjsStateStore,
        private readonly path: string,
        initialState: Uint8Array,
        initialServerSyncedState = false,
    ) {
        this.db = db;
        this.serverSyncedState = initialServerSyncedState;
        Y.applyUpdateV2(this.ydoc, initialState);
        this.serverBaseContent = this.ytext.toJSON();
    }

    public destroy(){
        if (this.checkpointTimer !== null) {
            clearTimeout(this.checkpointTimer);
            this.checkpointTimer = null;
        }
        this.ydoc.destroy();
    }
    public getTimeOpened(){
        return this.openedTime;
    }

    public getYdoc(){
        return this.ydoc;
    }

    public getLocalRevision(): number {
        return this.localRevision;
    }

    public hasLocalEdits(): boolean {
        return this.localEditRevision > 0;
    }

    public hasServerSyncedState(): boolean {
        return this.serverSyncedState;
    }

    public async persistState(): Promise<void> {
        if (this.checkpointTimer !== null) {
            clearTimeout(this.checkpointTimer);
            this.checkpointTimer = null;
        }
        const state = Y.encodeStateAsUpdateV2(this.ydoc);
        const contentHash = await sha256Hex(new TextEncoder().encode(this.ytext.toJSON()));
        if ("putWithContentHash" in this.stateStore && typeof this.stateStore.putWithContentHash === "function") {
            await this.stateStore.putWithContentHash(this.path, state, contentHash);
        } else {
            await this.stateStore.put(this.path, state);
            if ("putContentHash" in this.stateStore && typeof this.stateStore.putContentHash === "function") {
                await this.stateStore.putContentHash(this.path, contentHash);
            }
        }
        this.editsSinceCheckpoint = 0;
    }

    public async replaceState(state: Uint8Array): Promise<void> {
        this.ydoc.destroy();
        this.ydoc = new Y.Doc();
        Y.applyUpdateV2(this.ydoc, state);
        this.ytext = this.ydoc.getText(MARKDOWN_FIELD);
        this.localRevision++;
        this.localEditRevision = 0;
        this.serverSyncedState = true;
        this.serverBaseContent = this.ytext.toJSON();
        await this.persistState();
    }

    public async replaceStateIfRevision(state: Uint8Array, expectedRevision: number): Promise<boolean> {
        if (this.localRevision !== expectedRevision) {
            return false;
        }
        await this.replaceState(state);
        return true;
    }

    public encodeStateVector(): Uint8Array {
        return Y.encodeStateVector(this.ydoc);
    }

    public encodeUploadSince(stateVector: Uint8Array): Uint8Array {
        return Y.encodeStateAsUpdateV2(this.ydoc, stateVector);
    }

    public applyChanges(
        changeset: ChangeSet,
        row: outboxData,
        onError?: (error: Error) => void,
        expectedBefore?: string,
        expectedAfter?: string,
    ): Promise<void> {
        const before = Y.encodeStateVector(this.ydoc);
        const changes: {
            fromA: number;
            toA: number;
            insertText: string;
        }[] = [];
        changeset.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
            changes.push({ fromA, toA, insertText: inserted.toString() });
        });
        this.ydoc.transact(() => {
            if (expectedBefore !== undefined && this.ytext.toJSON() !== expectedBefore) {
                log.warn("repairing Yjs/editor mismatch before applying local edit", {
                    path: this.path,
                    yjsChars: this.ytext.length,
                    editorChars: expectedBefore.length,
                });
                if (this.ytext.length > 0) {
                    this.ytext.delete(0, this.ytext.length);
                }
                if (expectedBefore.length > 0) {
                    this.ytext.insert(0, expectedBefore);
                }
                this.serverSyncedState = false;
                this.serverBaseContent = expectedBefore;
            }
            for (const { fromA, toA, insertText } of changes.reverse()) {
                const deletelen = toA - fromA;
                if (deletelen > 0) {
                    this.ytext.delete(fromA, deletelen);
                }
                if (insertText.length > 0) {
                    this.ytext.insert(fromA, insertText);
                }
            }
            if (expectedAfter !== undefined && this.ytext.toJSON() !== expectedAfter) {
                log.warn("repairing Yjs/editor mismatch after applying local edit", {
                    path: this.path,
                    yjsChars: this.ytext.length,
                    editorChars: expectedAfter.length,
                });
                if (this.ytext.length > 0) {
                    this.ytext.delete(0, this.ytext.length);
                }
                if (expectedAfter.length > 0) {
                    this.ytext.insert(0, expectedAfter);
                }
                this.serverSyncedState = false;
            }
        }, "user changes");
        this.localRevision++;
        this.localEditRevision++;
        this.editsSinceCheckpoint++;
        row.data = Y.encodeStateAsUpdateV2(this.ydoc, before);
        const outboxWrite = this.db.putInOutbox(row).then(() => undefined);
        if (this.editsSinceCheckpoint >= CHECKPOINT_MAX_LOCAL_EDITS) {
            void this.flushCheckpointSoon(0);
        } else {
            this.scheduleCheckpoint();
        }
        return outboxWrite.catch(error => {
            const err = error instanceof Error ? error : new Error(String(error));
            log.error("failed to write update to outbox", { path: this.path, mutationId: row.mutationId, ...errorContext(err) });
            onError?.(err);
            throw err;
        });
    }

    public applyRemoteUpdate(update: Uint8Array): string {
        Y.applyUpdateV2(this.ydoc, update);
        this.localRevision++;
        this.serverSyncedState = true;
        if (this.localEditRevision === 0) {
            this.serverBaseContent = this.ytext.toJSON();
        }
        void this.flushCheckpointSoon(0).catch(error => {
            log.error("failed to persist remote Yjs state", { path: this.path, ...errorContext(error) });
        });
        return this.ytext.toJSON();
    }

    public async rebaseLocalChangesOntoRemoteState(remoteState: Uint8Array): Promise<string> {
        const localContent = this.ytext.toJSON();
        const remoteContent = contentFromState(remoteState);
        const rebasedContent = rebaseLocalTextChange(this.serverBaseContent, localContent, remoteContent);

        this.ydoc.destroy();
        this.ydoc = new Y.Doc();
        Y.applyUpdateV2(this.ydoc, remoteState);
        this.ytext = this.ydoc.getText(MARKDOWN_FIELD);
        this.ydoc.transact(() => {
            if (this.ytext.length > 0) {
                this.ytext.delete(0, this.ytext.length);
            }
            if (rebasedContent.length > 0) {
                this.ytext.insert(0, rebasedContent);
            }
        }, "rebase local changes");
        this.localRevision++;
        this.serverSyncedState = false;
        this.serverBaseContent = remoteContent;
        await this.persistState();
        return rebasedContent;
    }

    private scheduleCheckpoint(): void {
        if (this.checkpointTimer !== null) {
            return;
        }
        this.checkpointTimer = setTimeout(() => {
            this.checkpointTimer = null;
            void this.flushCheckpointSoon(0).catch(error => {
                log.error("failed to persist debounced Yjs state", { path: this.path, ...errorContext(error) });
            });
        }, CHECKPOINT_DEBOUNCE_MS);
        (this.checkpointTimer as { unref?: () => void }).unref?.();
    }

    private flushCheckpointSoon(delayMs: number): Promise<void> {
        if (this.checkpointTimer !== null) {
            clearTimeout(this.checkpointTimer);
            this.checkpointTimer = null;
        }
        this.checkpointPromise = this.checkpointPromise
            .catch(() => {})
            .then(async () => {
                if (delayMs > 0) {
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
                await this.persistState();
            });
        return this.checkpointPromise;
    }
}
