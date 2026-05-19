import * as Y from "yjs";
import { MARKDOWN_FIELD } from "./yjsSeed";

export function serverMarkdownFromState(serverState: Uint8Array): string {
    const doc = new Y.Doc();
    if (serverState.length > 0) {
        Y.applyUpdateV2(doc, serverState);
    }
    const text = doc.getText(MARKDOWN_FIELD).toString();
    doc.destroy();
    return text;
}

/**
 * Merging catch-up into a locally seeded doc with the same text prefix duplicates
 * content; skip apply and let buildUploadFromSyncedDoc rebase onto server state.
 */
export function shouldApplyDocSyncCatchUp(
    localText: string,
    serverYjsState: Uint8Array,
    catchUp: Uint8Array,
): boolean {
    return catchUp.length > 0 && !localText.startsWith(serverMarkdownFromState(serverYjsState));
}

export function buildUploadFromSyncedDoc(
    doc: Y.Doc,
    serverStateVector: Uint8Array,
    serverState: Uint8Array,
    targetContent: string,
): { upload: Uint8Array; state: Uint8Array } {
    const directUpload = Y.encodeStateAsUpdateV2(doc, serverStateVector);
    const directCheck = new Y.Doc();
    if (serverState.length > 0) {
        Y.applyUpdateV2(directCheck, serverState);
    }
    Y.applyUpdateV2(directCheck, directUpload);
    const directContent = directCheck.getText(MARKDOWN_FIELD).toString();
    directCheck.destroy();

    if (directContent === targetContent) {
        return {
            upload: directUpload,
            state: Y.encodeStateAsUpdateV2(doc),
        };
    }

    const workspace = new Y.Doc();
    if (serverState.length > 0) {
        Y.applyUpdateV2(workspace, serverState);
    }
    const originVector = Y.encodeStateVector(workspace);
    workspace.transact(() => {
        const ytext = workspace.getText(MARKDOWN_FIELD);
        if (ytext.length > 0) {
            ytext.delete(0, ytext.length);
        }
        if (targetContent.length > 0) {
            ytext.insert(0, targetContent);
        }
    });
    const upload = Y.encodeStateAsUpdateV2(workspace, originVector);
    const state = Y.encodeStateAsUpdateV2(workspace);
    workspace.destroy();
    return { upload, state };
}
