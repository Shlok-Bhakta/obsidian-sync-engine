import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as Y from "yjs";
import { opType } from "../../../shared/types";
import {
  acceptMutations,
  countYjsEvents,
  getCompactedRevision,
  getFile,
  getServerRevision,
  handleDocSync,
  handlePull,
  listSyncEvents,
  listYjsEvents,
  resetCompactionConfig,
  setCompactionConfig,
  snapshotPacket,
} from "./engine";
import { canConnectToDatabase, ensureIntegrationClient, resetIntegrationData, setupIntegrationDb } from "../test/dbHarness";
import { buildUploadFromSyncedDoc, shouldApplyDocSyncCatchUp } from "../../../shared/yjsUpload";
import {
  appendToDoc,
  makeClientDoc,
  mutationYjsUpdate,
  readDoc,
  seedMarkdownFile,
  uploadYjsEdit,
} from "../test/yjsHarness";
import { applyYjsPayload } from "../yjs/apply";

const CLIENT_A = "integration-client-a";
const CLIENT_B = "integration-client-b";
const NOTE_PATH = "notes/test.md";

const dbAvailable = await canConnectToDatabase();
const describeIntegration = dbAvailable ? describe : describe.skip;

describeIntegration("sync engine postgres integration", () => {
  beforeAll(async () => {
    await setupIntegrationDb();
  });

  beforeEach(async () => {
    resetCompactionConfig();
    await resetIntegrationData();
    await ensureIntegrationClient(CLIENT_A);
    await ensureIntegrationClient(CLIENT_B);
  });

  afterEach(() => {
    resetCompactionConfig();
  });

  it("UpsertFile writes files.content and files.yjs_state", async () => {
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "hello");

    const file = await getFile(NOTE_PATH);
    expect(file).not.toBeNull();
    expect(file?.content).toBe("hello");
    expect(file?.isYjs).toBe(true);
    expect(file?.yjsState).not.toBeNull();
    expect(file?.yjsState?.length).toBeGreaterThan(0);

    const events = await listSyncEvents(NOTE_PATH);
    const upsertEvents = events.filter(event => event.operation === "UpsertFile");
    expect(upsertEvents).toHaveLength(1);
    expect(upsertEvents[0]?.content).toBe("hello");
  });

  it("YjsUpdate stores payload only in sync_events and updates files.content", async () => {
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "hello");

    const doc = makeClientDoc("hello");
    appendToDoc(doc, " world");
    await uploadYjsEdit(CLIENT_A, NOTE_PATH, doc);
    doc.destroy();

    const file = await getFile(NOTE_PATH);
    expect(file?.content).toBe("hello world");

    const events = await listYjsEvents(NOTE_PATH);
    const yjsEvents = events.filter(event => event.operation === "YjsUpdate");
    expect(yjsEvents.length).toBeGreaterThanOrEqual(1);

    const last = yjsEvents[yjsEvents.length - 1]!;
    expect(last.content).toBeNull();
    expect(last.payload).not.toBeNull();
    expect(last.payload!.length).toBeGreaterThan(0);
  });

  it("rejects duplicate mutation_id without double-applying", async () => {
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "hello");

    const doc = makeClientDoc("hello");
    appendToDoc(doc, "!");
    const mutationId = crypto.randomUUID();
    const clientVector = Y.encodeStateVector(doc);
    const ack = await handleDocSync([{
      path: NOTE_PATH,
      stateVector: clientVector,
      content: readDoc(doc),
    }]);
    const syncResult = ack.paths[0];
    let target = readDoc(doc);
    if (syncResult && shouldApplyDocSyncCatchUp(target, syncResult.yjsState, syncResult.data)) {
      Y.applyUpdateV2(doc, syncResult.data);
      target = readDoc(doc);
    }
    const { upload: data } = buildUploadFromSyncedDoc(
      doc,
      syncResult!.stateVector,
      syncResult!.yjsState,
      target,
    );
    doc.destroy();

    const mutation = {
      mutationId,
      operation: "YjsUpdate" as const,
      path: NOTE_PATH,
      data,
      created: Date.now(),
    };

    const rev1 = await acceptMutations(CLIENT_A, [mutation]);
    const rev2 = await acceptMutations(CLIENT_A, [mutation]);
    expect(rev1).toBe(rev2);

    const file = await getFile(NOTE_PATH);
    expect(file?.content).toBe("hello!");

    const events = await listYjsEvents(NOTE_PATH);
    const dupes = events.filter(event => event.mutationId === mutationId);
    expect(dupes).toHaveLength(1);
  });

  it("two clients converge on files.content via handshake uploads", async () => {
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "hello");

    const docA = makeClientDoc("hello");
    appendToDoc(docA, " from A");
    await uploadYjsEdit(CLIENT_A, NOTE_PATH, docA);
    docA.destroy();

    const fileAfterA = await getFile(NOTE_PATH);
    expect(fileAfterA?.content).toBe("hello from A");

    const docB = makeClientDoc("hello");
    appendToDoc(docB, " from B");
    await uploadYjsEdit(CLIENT_B, NOTE_PATH, docB);
    docB.destroy();

    const fileAfterB = await getFile(NOTE_PATH);
    expect(fileAfterB?.content).toContain("hello");
    expect(fileAfterB?.content).toContain("from A");
    expect(fileAfterB?.content).toContain("from B");
  });

  it("DocSync returns catch-up bytes for a client behind the server", async () => {
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "server text");

    const behindDoc = new Y.Doc();
    const ack = await handleDocSync([{
      path: NOTE_PATH,
      stateVector: Y.encodeStateVector(behindDoc),
    }]);

    const catchUp = ack.paths[0]?.data;
    expect(catchUp).toBeDefined();
    expect(catchUp!.length).toBeGreaterThan(0);

    Y.applyUpdateV2(behindDoc, catchUp!);
    expect(readDoc(behindDoc)).toBe("server text");
    behindDoc.destroy();
  });

  it("DocSync returns catch-up when text matches but CRDT state differs", async () => {
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "hello");

    const sameTextDoc = makeClientDoc("hello");
    const ack = await handleDocSync([{
      path: NOTE_PATH,
      stateVector: Y.encodeStateVector(sameTextDoc),
      content: "hello",
    }]);

    expect(ack.paths[0]?.data.length).toBeGreaterThan(0);
    sameTextDoc.destroy();
  });

  it("raw Yjs delta without handshake does not update files.content", async () => {
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "hello");

    const mismatchedDoc = makeClientDoc("hello");
    const before = Y.encodeStateVector(mismatchedDoc);
    appendToDoc(mismatchedDoc, " FAIL");
    const badDelta = Y.encodeStateAsUpdateV2(mismatchedDoc, before);
    mismatchedDoc.destroy();

    await acceptMutations(CLIENT_A, [mutationYjsUpdate(NOTE_PATH, badDelta)]);

    const file = await getFile(NOTE_PATH);
    expect(file?.content).toBe("hello");
  });

  it("compaction flushes files then deletes yjs sync_events", async () => {
    setCompactionConfig({ count: 3, bytes: 1 });

    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "line");

    const doc = makeClientDoc("line");
    for (const ch of ["1", "2", "3", "4"]) {
      appendToDoc(doc, ch);
      await uploadYjsEdit(CLIENT_A, NOTE_PATH, doc, crypto.randomUUID());
    }

    const fileBeforeCompact = await getFile(NOTE_PATH);
    expect(fileBeforeCompact?.content).toBe("line1234");

    const remaining = await countYjsEvents(NOTE_PATH, false);
    expect(remaining).toBe(0);

    const yjsEvents = await listYjsEvents(NOTE_PATH);
    expect(yjsEvents).toHaveLength(0);

    const allEvents = await listSyncEvents(NOTE_PATH);
    expect(allEvents.some(event => event.operation === "UpsertFile")).toBe(true);

    const compactedRevision = await getCompactedRevision();
    expect(BigInt(compactedRevision)).toBeGreaterThan(0n);

    const snapshot = await snapshotPacket();
    const snapFile = snapshot.files.find(file => file.path === NOTE_PATH);
    expect(snapFile?.content).toBe("line1234");
    expect(snapFile?.yjsState).toEqual(fileBeforeCompact?.yjsState);
  });

  it("snapshot is served when pull revision is behind compacted_revision", async () => {
    setCompactionConfig({ count: 2, bytes: 1 });

    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "v0");

    const doc = makeClientDoc("v0");
    for (const suffix of ["1", "2", "3"]) {
      appendToDoc(doc, suffix);
      await uploadYjsEdit(CLIENT_A, NOTE_PATH, doc, crypto.randomUUID());
    }

    const revisionBeforePull = "1";
    const pull = await handlePull({ type: opType.PullSince, revision: revisionBeforePull });
    expect(pull.type).toBe(opType.SnapshotReset);

    if (pull.type === opType.SnapshotReset) {
      const file = pull.files.find(entry => entry.path === NOTE_PATH);
      expect(file?.content).toBe("v0123");
      expect(file?.yjsState?.length).toBeGreaterThan(0);
    }
  });

  it("files.yjs_state round-trips through apply and matches content", async () => {
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "round trip");

    const doc = makeClientDoc("round trip");
    appendToDoc(doc, " ok");
    await uploadYjsEdit(CLIENT_A, NOTE_PATH, doc);
    doc.destroy();

    const file = await getFile(NOTE_PATH);
    expect(file?.yjsState).not.toBeNull();

    const verify = new Y.Doc();
    Y.applyUpdateV2(verify, file!.yjsState!);
    expect(verify.getText("markdown").toString()).toBe(file?.content);
    verify.destroy();
  });

  it("folder Rename rewrites descendant paths", async () => {
    const folder = "notes/old";
    const child = `${folder}/child.md`;
    const renamedFolder = "notes/new";

    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "CreateFolder",
      path: folder,
      isFolder: true,
      created: Date.now(),
    }]);
    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: child,
      content: "inside",
      created: Date.now(),
    }]);

    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "Rename",
      path: folder,
      toPath: renamedFolder,
      isFolder: true,
      created: Date.now(),
    }]);

    expect(await getFile(child)).toBeNull();
    expect(await getFile(`${renamedFolder}/child.md`)).toMatchObject({
      content: "inside",
      deleted: false,
    });
  });

  it("folder Rename preserves descendant paths with astral Unicode in the folder name", async () => {
    const folder = "notes/📁";
    const child = `${folder}/child.md`;
    const renamedFolder = "archive/📁";

    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "CreateFolder",
      path: folder,
      isFolder: true,
      created: Date.now(),
    }]);
    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: child,
      content: "inside",
      created: Date.now(),
    }]);

    expect(await getFile(child)).not.toBeNull();

    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "Rename",
      path: folder,
      toPath: renamedFolder,
      isFolder: true,
      created: Date.now(),
    }]);

    expect(await getFile(child)).toBeNull();
    expect(await getFile(`${renamedFolder}/child.md`)).toMatchObject({
      content: "inside",
      deleted: false,
    });
  });

  it("server revision advances monotonically across mutations", async () => {
    const r0 = await getServerRevision();
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "a");
    const r1 = await getServerRevision();
    const doc = makeClientDoc("a");
    appendToDoc(doc, "b");
    await uploadYjsEdit(CLIENT_A, NOTE_PATH, doc);
    doc.destroy();
    const r2 = await getServerRevision();

    expect(BigInt(r1)).toBeGreaterThan(BigInt(r0));
    expect(BigInt(r2)).toBeGreaterThan(BigInt(r1));
  });
});

if (!dbAvailable) {
  afterAll(() => {
    console.warn(
      "postgres integration tests skipped: set DATABASE_URL (or Bun's default postgres env) and run migrations",
    );
  });
}
