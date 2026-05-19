import { describe, expect, it } from "bun:test";
import * as Y from "yjs";
import {
  applyYjsPayload,
  docStateFromContent,
  encodeMissingUpdate,
  replayYjsPayloads,
} from "./apply";

function makeDoc(text: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("markdown").insert(0, text);
  return doc;
}

describe("applyYjsPayload", () => {
  it("applies coalesced upload after sync handshake", () => {
    const serverState = docStateFromContent("hello");

    const clientDoc = new Y.Doc();
    const clientVector = Y.encodeStateVector(clientDoc);
    Y.applyUpdateV2(clientDoc, encodeMissingUpdate(serverState, clientVector));

    const before = Y.encodeStateVector(clientDoc);
    clientDoc.getText("markdown").insert(5, " world");
    const upload = Y.encodeStateAsUpdateV2(clientDoc, before);

    const result = applyYjsPayload(serverState, upload);
    expect(result.content).toBe("hello world");

    clientDoc.destroy();
  });

  it("applies incremental uploads on a shared server chain", () => {
    const writer = makeDoc("hello");
    let serverState = Y.encodeStateAsUpdateV2(writer);

    for (const ch of [" ", "w", "o", "r", "l", "d"]) {
      const before = Y.encodeStateVector(writer);
      writer.getText("markdown").insert(writer.getText("markdown").length, ch);
      const payload = Y.encodeStateAsUpdateV2(writer, before);
      serverState = applyYjsPayload(serverState, payload).state;
    }

    const verify = new Y.Doc();
    Y.applyUpdateV2(verify, serverState);
    expect(verify.getText("markdown").toString()).toBe("hello world");
    verify.destroy();
    writer.destroy();
  });

  it("merges two client payloads on the same base state", () => {
    const base = docStateFromContent("hello");

    const docA = new Y.Doc();
    Y.applyUpdateV2(docA, base);
    const beforeA = Y.encodeStateVector(docA);
    docA.getText("markdown").insert(5, "!");
    const updateA = Y.encodeStateAsUpdateV2(docA, beforeA);

    const afterA = applyYjsPayload(base, updateA);

    const docB = new Y.Doc();
    Y.applyUpdateV2(docB, base);
    const beforeB = Y.encodeStateVector(docB);
    docB.getText("markdown").insert(5, " there");
    const updateB = Y.encodeStateAsUpdateV2(docB, beforeB);

    const merged = applyYjsPayload(afterA.state, updateB);
    expect(merged.content).toContain("hello");
    expect(merged.content.length).toBeGreaterThan("hello!".length);

    docA.destroy();
    docB.destroy();
  });
});

describe("encodeMissingUpdate", () => {
  it("returns server diff for an empty client doc", () => {
    const serverState = docStateFromContent("hello world");
    const clientDoc = new Y.Doc();
    const clientVector = Y.encodeStateVector(clientDoc);

    const missing = encodeMissingUpdate(serverState, clientVector);
    Y.applyUpdateV2(clientDoc, missing);

    expect(clientDoc.getText("markdown").toString()).toBe("hello world");
    clientDoc.destroy();
  });
});

describe("replayYjsPayloads", () => {
  it("matches sequential applyYjsPayload for the same payloads", () => {
    const writer = makeDoc("start");
    const initialState = Y.encodeStateAsUpdateV2(writer);
    let liveState = initialState;
    const payloads: Uint8Array[] = [];

    for (const ch of [" ", "x", "y"]) {
      const before = Y.encodeStateVector(writer);
      writer.getText("markdown").insert(writer.getText("markdown").length, ch);
      const payload = Y.encodeStateAsUpdateV2(writer, before);
      payloads.push(payload);
      liveState = applyYjsPayload(liveState, payload).state;
    }

    const replayed = replayYjsPayloads(initialState, payloads);
    expect(replayed.content).toBe("start xy");
    expect(replayed.state).toEqual(liveState);
    writer.destroy();
  });
});
