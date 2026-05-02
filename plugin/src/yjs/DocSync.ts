import { Editor } from "obsidian";
// one stop shop for all the document syncing needs

export class DocSync {
    private ydoc = new Y.Doc();
    constructor(private editor: Editor) {
        
    }
}