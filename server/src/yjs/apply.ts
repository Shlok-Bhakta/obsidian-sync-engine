import * as Y from "yjs";
import { docStateFromContent as createDocStateFromContent, MARKDOWN_FIELD } from "../../../shared/yjsSeed";

export { MARKDOWN_FIELD };

type YjsStoreWithPending = {
  pendingStructs?: { missing?: { size: number } } | null;
  pendingDs?: unknown | null;
};

export type AppliedYjsPayload = {
  content: string;
  state: Uint8Array;
  hasPendingUpdates: boolean;
};

export function docStateFromContent(content: string): Uint8Array {
  return createDocStateFromContent(content, Y);
}

function hasPendingUpdates(doc: Y.Doc): boolean {
  const store = (doc as unknown as { store?: YjsStoreWithPending }).store;
  return (store?.pendingStructs?.missing?.size ?? 0) > 0 || Boolean(store?.pendingDs);
}

export function contentFromYjsState(state: Uint8Array): string {
  const doc = new Y.Doc();
  try {
    Y.applyUpdateV2(doc, state);
    const content = doc.getText(MARKDOWN_FIELD).toString();
    if (hasPendingUpdates(doc)) {
      throw new Error("Yjs state contains unresolved dependencies");
    }
    return content;
  } finally {
    doc.destroy();
  }
}

export function applyYjsPayload(
  currentState: Uint8Array | null,
  payload: Uint8Array,
): AppliedYjsPayload {
  const doc = new Y.Doc();
  try {
    if (currentState) {
      Y.applyUpdateV2(doc, currentState);
    }
    Y.applyUpdateV2(doc, payload);
    const content = doc.getText(MARKDOWN_FIELD).toString();
    const state = Y.encodeStateAsUpdateV2(doc);
    return { content, state, hasPendingUpdates: hasPendingUpdates(doc) };
  } finally {
    doc.destroy();
  }
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
