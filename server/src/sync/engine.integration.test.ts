import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "bun";
import * as Y from "yjs";
import { opType } from "../../../shared/types";
import {
  acceptMutations,
  countYjsEvents,
  getCompactedRevision,
  getBlobMetadata,
  getFile,
  getServerRevision,
  handleDocSync,
  handlePull,
  listSyncEvents,
  listYjsEvents,
  putBlobFile,
  readBlobFile,
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
import { buildBootstrapZip } from "../bootstrap";
import { rotateClientKey } from "../security";

const CLIENT_A = "integration-client-a";
const CLIENT_B = "integration-client-b";
const NOTE_PATH = "notes/test.md";

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

async function readStoredZip(path: string): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const decoder = new TextDecoder();
  const entries = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset < bytes.byteLength && readUint32(bytes, offset) === 0x04034b50) {
    const compressedSize = readUint32(bytes, offset + 18);
    const nameLength = readUint16(bytes, offset + 26);
    const extraLength = readUint16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    entries.set(name, bytes.slice(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

async function readStoredZipCentralDirectory(path: string): Promise<string[]> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const decoder = new TextDecoder();
  let eocdOffset = -1;
  for (let offset = bytes.byteLength - 22; offset >= 0; offset--) {
    if (readUint32(bytes, offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  expect(eocdOffset).toBeGreaterThanOrEqual(0);
  const entryCount = readUint16(bytes, eocdOffset + 10);
  let offset = readUint32(bytes, eocdOffset + 16);
  const names: string[] = [];
  for (let index = 0; index < entryCount; index++) {
    expect(readUint32(bytes, offset)).toBe(0x02014b50);
    const nameLength = readUint16(bytes, offset + 28);
    const extraLength = readUint16(bytes, offset + 30);
    const commentLength = readUint16(bytes, offset + 32);
    const nameStart = offset + 46;
    names.push(decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)));
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return names;
}

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

  it("bootstraps the first client key from the first auth request", async () => {
    const auth = await rotateClientKey("To Be Generated");

    expect(auth.authenticated).toBe(true);
    expect(auth.clientKey).toStartWith("obs_sync_");
    expect(auth.clientKey).not.toBe("To Be Generated");
    expect(auth.currentKeyId).toBeDefined();
    expect(auth.previousKeyId).toBeNull();

    const rows = await sql<{ clientKey: string; valid: boolean }[]>`
      SELECT client_key AS "clientKey", valid
      FROM client_keys
      ORDER BY id;
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientKey).toBe(auth.clientKey);
    expect(rows[0]?.valid).toBe(true);
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

  it("rejects plugin-internal paths", async () => {
    await expect(acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: ".obsidian/plugins/obsidian-sync-engine/data.json",
      content: "{}",
      created: Date.now(),
    }])).rejects.toThrow("plugin-internal path");
  });

  it("round-trips non-markdown BYTEA files through snapshot metadata", async () => {
    const path = ".obsidian/workspace.json";
    const contentBytes = new TextEncoder().encode(JSON.stringify({ active: "pane" }));

    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path,
      contentBytes,
      storageKind: "bytea",
      isYjs: false,
      byteSize: contentBytes.byteLength,
      contentSha256: "sha-test",
      created: Date.now(),
    }]);

    const file = await getFile(path);
    expect(file?.content).toBeNull();
    expect(file?.contentBytes).toEqual(contentBytes);
    expect(file?.storageKind).toBe("bytea");
    expect(file?.isYjs).toBe(false);

    const snapshot = await snapshotPacket();
    const change = snapshot.files.find(entry => entry.path === path);
    expect(change?.contentBytes).toEqual(contentBytes);
    expect(change?.storageKind).toBe("bytea");
  });

  it("stores and unlinks Large Object blob files", async () => {
    const path = "assets/photo.bin";
    const bytes = new Uint8Array([0, 1, 2, 3, 255]);

    const uploaded = await putBlobFile(path, bytes, "sha-lo");
    expect(uploaded.contentOid).toBeGreaterThan(0);

    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path,
      storageKind: "lo",
      isYjs: false,
      byteSize: bytes.byteLength,
      contentSha256: "sha-lo",
      created: Date.now(),
    }]);

    const blob = await readBlobFile(path);
    expect(blob?.bytes).toEqual(bytes);

    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "Delete",
      path,
      isFolder: false,
      created: Date.now(),
    }]);

    expect(await getBlobMetadata(path)).toBeNull();
    expect((await getFile(path))?.contentOid).toBeNull();
  });

  it("multiple clients can upsert distinct BYTEA blob files and pull both changes", async () => {
    const aPath = ".obsidian/workspace.json";
    const bPath = ".obsidian/app.json";
    const aBytes = new TextEncoder().encode(JSON.stringify({ client: "A", pane: "left" }));
    const bBytes = new TextEncoder().encode(JSON.stringify({ client: "B", theme: "dark" }));

    const revA = await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: aPath,
      contentBytes: aBytes,
      storageKind: "bytea",
      isYjs: false,
      byteSize: aBytes.byteLength,
      contentSha256: "sha-bytea-a",
      created: Date.now(),
    }]);
    const revB = await acceptMutations(CLIENT_B, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: bPath,
      contentBytes: bBytes,
      storageKind: "bytea",
      isYjs: false,
      byteSize: bBytes.byteLength,
      contentSha256: "sha-bytea-b",
      created: Date.now(),
    }]);

    expect(BigInt(revB)).toBeGreaterThan(BigInt(revA));
    expect((await getFile(aPath))?.contentBytes).toEqual(aBytes);
    expect((await getFile(bPath))?.contentBytes).toEqual(bBytes);

    const pull = await handlePull({ type: opType.PullSince, revision: revA });
    expect(pull.type).toBe(opType.ChangeBatch);
    if (pull.type === opType.ChangeBatch) {
      expect(pull.changes).toHaveLength(1);
      expect(pull.changes[0]).toMatchObject({
        clientId: CLIENT_B,
        path: bPath,
        storageKind: "bytea",
        contentSha256: "sha-bytea-b",
      });
      expect(pull.changes[0]?.contentBytes).toEqual(bBytes);
    }
  });

  it("multiple clients overwriting the same BYTEA blob keep the latest file row and both events", async () => {
    const path = ".obsidian/workspace.json";
    const firstBytes = new Uint8Array([1, 2, 3]);
    const secondBytes = new Uint8Array([9, 8, 7, 6]);

    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path,
      contentBytes: firstBytes,
      storageKind: "bytea",
      isYjs: false,
      byteSize: firstBytes.byteLength,
      contentSha256: "sha-first",
      created: Date.now(),
    }]);
    const latestRevision = await acceptMutations(CLIENT_B, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path,
      contentBytes: secondBytes,
      storageKind: "bytea",
      isYjs: false,
      byteSize: secondBytes.byteLength,
      contentSha256: "sha-second",
      created: Date.now(),
    }]);

    const file = await getFile(path);
    expect(file).toMatchObject({
      path,
      storageKind: "bytea",
      contentSha256: "sha-second",
      isYjs: false,
      deleted: false,
      revision: latestRevision,
    });
    expect(file?.contentBytes).toEqual(secondBytes);
    expect(file?.content).toBeNull();

    const events = await listSyncEvents(path);
    expect(events.map(event => event.clientId)).toEqual([CLIENT_A, CLIENT_B]);
    expect(events.map(event => event.contentSha256)).toEqual(["sha-first", "sha-second"]);
    expect(events[0]?.contentBytes).toEqual(firstBytes);
    expect(events[1]?.contentBytes).toEqual(secondBytes);
  });

  it("multiple clients overwriting the same Large Object blob keep the new object and unlink the old one", async () => {
    const path = "assets/shared.bin";
    const firstBytes = new Uint8Array([0, 1, 2, 3, 4]);
    const secondBytes = new Uint8Array([255, 254, 253]);

    const firstUpload = await putBlobFile(path, firstBytes, "sha-lo-first");
    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path,
      storageKind: "lo",
      isYjs: false,
      byteSize: firstBytes.byteLength,
      contentSha256: "sha-lo-first",
      created: Date.now(),
    }]);
    const firstOid = firstUpload.contentOid;

    const secondUpload = await putBlobFile(path, secondBytes, "sha-lo-second");
    const latestRevision = await acceptMutations(CLIENT_B, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path,
      storageKind: "lo",
      isYjs: false,
      byteSize: secondBytes.byteLength,
      contentSha256: "sha-lo-second",
      created: Date.now(),
    }]);

    expect(secondUpload.contentOid).not.toBe(firstOid);
    const blob = await readBlobFile(path);
    expect(blob?.bytes).toEqual(secondBytes);
    expect(blob?.metadata).toMatchObject({
      path,
      contentOid: secondUpload.contentOid,
      byteSize: secondBytes.byteLength,
      contentSha256: "sha-lo-second",
      revision: latestRevision,
    });

    const file = await getFile(path);
    expect(file).toMatchObject({
      storageKind: "lo",
      contentOid: secondUpload.contentOid,
      contentSha256: "sha-lo-second",
      revision: latestRevision,
    });
    expect(file?.contentBytes).toBeNull();
    expect(file?.content).toBeNull();

    const oldObjectRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::TEXT AS count
      FROM pg_largeobject_metadata
      WHERE oid = ${firstOid};
    `;
    const currentObjectRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::TEXT AS count
      FROM pg_largeobject_metadata
      WHERE oid = ${secondUpload.contentOid};
    `;
    expect(oldObjectRows[0]?.count).toBe("0");
    expect(currentObjectRows[0]?.count).toBe("1");
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
    expect(snapFile?.yjsState).toEqual(fileBeforeCompact?.yjsState ?? undefined);
  });

  it("builds a bootstrap zip from compacted server state", async () => {
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "bootstrap note");
    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: ".obsidian/workspace.json",
      contentBytes: new TextEncoder().encode('{"pane":"left"}'),
      storageKind: "bytea",
      isYjs: false,
      byteSize: 15,
      contentSha256: "sha-bytea",
      created: Date.now(),
    }]);
    await putBlobFile("assets/photo.bin", new Uint8Array([0, 1, 2, 255]), "sha-lo");
    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: "assets/photo.bin",
      storageKind: "lo",
      isYjs: false,
      byteSize: 4,
      contentSha256: "sha-lo",
      created: Date.now(),
    }]);

    const built = await buildBootstrapZip({
      vaultName: "Bootstrap Vault",
      backendUrl: "https://sync.example.test",
      configDir: ".obsidian",
      pluginId: "obsidian-sync-engine",
    });

    try {
      const entries = await readStoredZip(built.zipPath);
      const centralNames = await readStoredZipCentralDirectory(built.zipPath);
      expect([...entries.keys()].every(name => name.startsWith("Bootstrap Vault/"))).toBe(true);
      expect(centralNames).toContain("Bootstrap Vault/notes/test.md");
      expect(new TextDecoder().decode(entries.get("Bootstrap Vault/notes/test.md"))).toBe("bootstrap note");
      expect(entries.get("Bootstrap Vault/.obsidian/workspace.json")).toEqual(new TextEncoder().encode('{"pane":"left"}'));
      expect(entries.get("Bootstrap Vault/assets/photo.bin")).toEqual(new Uint8Array([0, 1, 2, 255]));
      expect(entries.get("Bootstrap Vault/.obsidian/plugins/obsidian-sync-engine/yjs-state/notes/test.md.state")?.byteLength).toBeGreaterThan(0);
      expect(new TextDecoder().decode(entries.get("Bootstrap Vault/.obsidian/plugins/obsidian-sync-engine/outbox/active.jsonl"))).toBe("");
      expect(new TextDecoder().decode(entries.get("Bootstrap Vault/.obsidian/plugins/obsidian-sync-engine/outbox/meta.json"))).toBe('{"nextRowId":1,"nextSegmentId":1}');
      const data = JSON.parse(new TextDecoder().decode(entries.get("Bootstrap Vault/.obsidian/plugins/obsidian-sync-engine/data.json")));
      expect(data).toMatchObject({
        backendUrl: "https://sync.example.test",
        lastPulledRevision: built.snapshotRevision,
      });
      expect(data.clientId).toStartWith("obs_client_");
      expect(data.clientKey).toStartWith("obs_sync_");
      expect((await listSyncEvents(NOTE_PATH))).toHaveLength(0);
      expect(BigInt(await getCompactedRevision())).toBeGreaterThan(0n);
    } finally {
      await built.cleanup();
    }
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
    expect(verify.getText("markdown").toString()).toBe(file?.content ?? "");
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
