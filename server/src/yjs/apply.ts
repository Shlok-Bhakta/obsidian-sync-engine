import * as Y from "yjs";
import { docStateFromContent as createDocStateFromContent, MARKDOWN_FIELD } from "../../../shared/yjsSeed";

export { MARKDOWN_FIELD };

export function docStateFromContent(content: string): Uint8Array {
  return createDocStateFromContent(content, Y);
}

export function applyYjsPayload(
  currentState: Uint8Array | null,
  payload: Uint8Array,
): { content: string; state: Uint8Array } {
  const doc = new Y.Doc();
  if (currentState) {
    Y.applyUpdateV2(doc, currentState);
  }
  Y.applyUpdateV2(doc, payload);
  const content = doc.getText(MARKDOWN_FIELD).toString();
  const state = Y.encodeStateAsUpdateV2(doc);
  doc.destroy();
  return { content, state };
}

export function encodeMissingUpdate(
  serverState: Uint8Array | null,
  clientStateVector: Uint8Array,
): Uint8Array {
  const doc = new Y.Doc();
  if (serverState) {
    Y.applyUpdateV2(doc, serverState);
  }
  const update = Y.encodeStateAsUpdateV2(doc, clientStateVector);
  doc.destroy();
  return update;
}

export function replayYjsPayloads(
  initialState: Uint8Array | null,
  payloads: Uint8Array[],
): { content: string; state: Uint8Array } {
  const doc = new Y.Doc();
  if (initialState) {
    Y.applyUpdateV2(doc, initialState);
  }
  for (const payload of payloads) {
    Y.applyUpdateV2(doc, payload);
  }
  const content = doc.getText(MARKDOWN_FIELD).toString();
  const state = Y.encodeStateAsUpdateV2(doc);
  doc.destroy();
  return { content, state };
}
