import * as Y from "yjs";
import { SyncMutation } from "../../../shared/types";
import { buildUploadFromSyncedDoc, shouldApplyDocSyncCatchUp } from "../../../shared/yjsUpload";
import { applyYjsPayload, docStateFromContent } from "../yjs/apply";
import { acceptMutations, getFile, handleDocSync } from "../sync/engine";

const MARKDOWN = "markdown";

export function makeClientDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText(MARKDOWN).insert(0, text);
  return doc;
}

/** Mirrors plugin SyncClient: handshake then one coalesced upload. */
export async function uploadYjsEdit(
  clientId: string,
  path: string,
  clientDoc: Y.Doc,
  mutationId = crypto.randomUUID(),
): Promise<string> {
  const clientStateVector = Y.encodeStateVector(clientDoc);
  const ack = await handleDocSync([{
    path,
    stateVector: clientStateVector,
    content: clientDoc.getText(MARKDOWN).toString(),
  }]);
  const syncResult = ack.paths.find(entry => entry.path === path);
  if (!syncResult) {
    throw new Error(`DocSyncAck missing path ${path}`);
  }

  let target = clientDoc.getText(MARKDOWN).toString();
  if (shouldApplyDocSyncCatchUp(target, syncResult.yjsState, syncResult.data)) {
    Y.applyUpdateV2(clientDoc, syncResult.data);
    target = clientDoc.getText(MARKDOWN).toString();
  }
  const { upload } = buildUploadFromSyncedDoc(
    clientDoc,
    syncResult.stateVector,
    syncResult.yjsState,
    target,
  );
  return acceptMutations(clientId, [{
    mutationId,
    operation: "YjsUpdate",
    path,
    data: upload,
    created: Date.now(),
  }]);
}

export async function seedMarkdownFile(
  clientId: string,
  path: string,
  content: string,
): Promise<string> {
  return acceptMutations(clientId, [{
    mutationId: crypto.randomUUID(),
    operation: "UpsertFile",
    path,
    content,
    isYjs: true,
    created: Date.now(),
  }]);
}

export function appendToDoc(doc: Y.Doc, text: string): void {
  const ytext = doc.getText(MARKDOWN);
  ytext.insert(ytext.length, text);
}

export function readDoc(doc: Y.Doc): string {
  return doc.getText(MARKDOWN).toString();
}

export async function expectFileContent(path: string, expected: string): Promise<void> {
  const file = await getFile(path);
  if (!file) {
    throw new Error(`files row missing for ${path}`);
  }
  if (file.content !== expected) {
    throw new Error(`files.content for ${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(file.content)}`);
  }
}

export function applyUploadToState(
  serverState: Uint8Array | null,
  upload: Uint8Array,
): { content: string; state: Uint8Array } {
  return applyYjsPayload(serverState, upload);
}

export function stateFromMarkdown(content: string): Uint8Array {
  return docStateFromContent(content);
}

export function mutationYjsUpdate(path: string, data: Uint8Array): SyncMutation {
  return {
    mutationId: crypto.randomUUID(),
    operation: "YjsUpdate",
    path,
    data,
    created: Date.now(),
  };
}
