import { OutboxStore } from "db/db";
import * as Y from 'yjs';
import { ChangeSet } from "@codemirror/state";
import { outboxData } from "../../../shared/types";
import { MARKDOWN_FIELD } from "../../../shared/yjsSeed";
import { YjsStateStore } from "./YjsStateStore";

// one stop shop for all the document syncing needs

export class DocSync {
    private db: OutboxStore;
    private ydoc = new Y.Doc();
    private ytext = this.ydoc.getText(MARKDOWN_FIELD);
    private openedTime = Date.now();


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

    public async persistState(): Promise<void> {
        await this.stateStore.put(this.path, Y.encodeStateAsUpdateV2(this.ydoc));
    }

    public async replaceState(state: Uint8Array): Promise<void> {
        this.ydoc.destroy();
        this.ydoc = new Y.Doc();
        Y.applyUpdateV2(this.ydoc, state);
        this.ytext = this.ydoc.getText(MARKDOWN_FIELD);
        await this.persistState();
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
    ): void {
        const before = Y.encodeStateVector(this.ydoc);
        this.ydoc.transact(() => {
            changeset.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
                const deletelen = toA - fromA;
                if (deletelen > 0) {
                    this.ytext.delete(fromA, deletelen);
                }
                const insertText = inserted.toString();
                if (insertText.length > 0) {
                    this.ytext.insert(fromA, insertText);
                }
            });
        }, "user changes");
        row.data = Y.encodeStateAsUpdateV2(this.ydoc, before);
        void Promise.all([
            this.db.putInOutbox(row),
            this.persistState(),
        ]).catch(error => {
            const err = error instanceof Error ? error : new Error(String(error));
            console.error("failed to write update to outbox", err);
            onError?.(err);
        });
    }

    public applyRemoteUpdate(update: Uint8Array): string {
        Y.applyUpdateV2(this.ydoc, update);
        void this.persistState().catch(error => {
            console.error("failed to persist remote Yjs state", error);
        });
        return this.ytext.toJSON();
    }
}
