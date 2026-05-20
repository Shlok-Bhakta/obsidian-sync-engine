import { OutboxStore } from "db/db";
import * as Y from 'yjs';
import { ChangeSet } from "@codemirror/state";
import { outboxData } from "../../../shared/types";
import { MARKDOWN_FIELD } from "../../../shared/yjsSeed";
import { YjsStateStore } from "./YjsStateStore";
import { errorContext } from "../../../shared/logger";
import { log } from "../logger";

// one stop shop for all the document syncing needs

export class DocSync {
    private db: OutboxStore;
    private ydoc = new Y.Doc();
    private ytext = this.ydoc.getText(MARKDOWN_FIELD);
    private openedTime = Date.now();
    private localRevision = 0;
    private localEditRevision = 0;


    constructor(
        db: OutboxStore,
        private readonly stateStore: YjsStateStore,
        private readonly path: string,
        initialState: Uint8Array,
    ) {
        this.db = db;
        Y.applyUpdateV2(this.ydoc, initialState);
    }

    public destroy(){
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

    public async persistState(): Promise<void> {
        await this.stateStore.put(this.path, Y.encodeStateAsUpdateV2(this.ydoc));
    }

    public async replaceState(state: Uint8Array): Promise<void> {
        this.ydoc.destroy();
        this.ydoc = new Y.Doc();
        Y.applyUpdateV2(this.ydoc, state);
        this.ytext = this.ydoc.getText(MARKDOWN_FIELD);
        this.localRevision++;
        this.localEditRevision = 0;
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
            }
        }, "user changes");
        this.localRevision++;
        this.localEditRevision++;
        row.data = Y.encodeStateAsUpdateV2(this.ydoc, before);
        return Promise.all([
            this.db.putInOutbox(row),
            this.persistState(),
        ]).then(() => undefined).catch(error => {
            const err = error instanceof Error ? error : new Error(String(error));
            log.error("failed to write update to outbox", { path: this.path, mutationId: row.mutationId, ...errorContext(err) });
            onError?.(err);
            throw err;
        });
    }

    public applyRemoteUpdate(update: Uint8Array): string {
        Y.applyUpdateV2(this.ydoc, update);
        this.localRevision++;
        void this.persistState().catch(error => {
            log.error("failed to persist remote Yjs state", { path: this.path, ...errorContext(error) });
        });
        return this.ytext.toJSON();
    }
}
