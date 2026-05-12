import { yDb } from "db/db";
import { Editor } from "obsidian";
import * as Y from 'yjs';
import { ChangeSet } from "@codemirror/state";

// one stop shop for all the document syncing needs

export class DocSync {
    private ydoc = new Y.Doc();
    private ytext = this.ydoc.getText('markdown');  
    private openedTime = Date.now();
    private db: yDb;

    constructor(db: yDb) {
        this.db = db;
        // do nothing yipee
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

    public applyChanges(changeset: ChangeSet){
        console.log(JSON.stringify(changeset));
    }
}