import { yDb } from "db/db";
import { Editor } from "obsidian";
import * as Y from 'yjs';
import { ChangeSet } from "@codemirror/state";
import { outboxData } from "../../../shared/types";

// one stop shop for all the document syncing needs

export class DocSync {
    private db: yDb;
    private syncWorker: Worker;
    private ydoc = new Y.Doc();
    private ytext = this.ydoc.getText('markdown');  
    private openedTime = Date.now();


    constructor(db: yDb, content: string) {
        this.db = db;
        // do nothing yipee
        this.ydoc.transact(() => {
            this.ytext.insert(0, content);
        }, "seed");
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

    public applyChanges(changeset: ChangeSet, row: outboxData){
        console.log(JSON.stringify(changeset));
        const before = Y.encodeStateVector(this.ydoc);
        this.ydoc.transact(() => {
            changeset.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
                const deletelen = toA - fromA;
                if(deletelen > 0){
                    this.ytext.delete(fromA, deletelen);
                }
                const insertText = inserted.toString();
                if(insertText.length > 0){
                    this.ytext.insert(fromA, insertText);
                }
            });
        }, "user changes");
        const updates = Y.encodeStateAsUpdateV2(this.ydoc, before);
        // console.log(JSON.stringify(after));
        row.data = updates;
        this.db.putInOutbox(row);
        // wake up service worker to go do stuff
    }
}