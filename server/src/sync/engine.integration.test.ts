import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { readdir, stat } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { sql } from "bun";
import * as Y from "yjs";
import { opType, SyncMutation, wsPacket } from "../../../shared/types";
import { decodePacket, encodePacket, encodePathToken, encodeUpdateBatchJsonl, PROTOCOL_VERSION } from "../../../shared/protocol";
import { shouldSyncPath, shouldUseYjs } from "../../../shared/pathPolicy";
import {
  acceptMutations,
  changeBatchPacket,
  compactYjsEvents,
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
  stateFromMarkdown,
  uploadYjsEdit,
} from "../test/yjsHarness";
import { buildBootstrapZip } from "../bootstrap";
import { putBootstrapBlob } from "./bootstrapBlobUpload";
import { acceptBootstrapSnapshot } from "./bootstrapUpload";
import { authenticateClientKey, rotateClientKey, validateClientKey } from "../security";
import server from "../index";

const CLIENT_A = "integration-client-a";
const CLIENT_B = "integration-client-b";
const NOTE_PATH = "notes/test.md";
const SAMPLE_VAULT_PATH = "/home/shlok/Obsidian/obsidian-notes-test";
const SAMPLE_LARGE_PDF_PATH = "ZArchive/CS436/Books/Research Methods in Human-Computer Interaction,Jonathan Lazar,Jinjuan Heidi Feng (Harry Hochheiser) (Z-Library).pdf";
const SAMPLE_VAULT_INLINE_LIMIT = 512 * 1024;
const SAMPLE_VAULT_BATCH_SIZE = 100;
const BUN_DEFAULT_MAX_REQUEST_BODY_SIZE = 128 * 1024 * 1024;

let wsServer: Bun.Server<unknown> | null = null;
let wsUrl = "";

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    wait(ms).then(() => {
      throw new Error(message);
    }),
  ]);
}

class TestPeer {
  private ws: WebSocket | null = null;
  private packets: wsPacket[] = [];
  private waiters: {
    predicate: (packet: wsPacket) => boolean;
    resolve: (packet: wsPacket) => void;
  }[] = [];
  clientKey: string;

  constructor(
    private readonly clientId: string,
    clientKey: string,
    private readonly lastPulledRevision = "0",
  ) {
    this.clientKey = clientKey;
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    await withTimeout(new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
    }), 2000, "timed out opening websocket");
    ws.addEventListener("message", event => {
      const packet = decodePacket(String(event.data));
      const waiterIndex = this.waiters.findIndex(waiter => waiter.predicate(packet));
      if (waiterIndex !== -1) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        waiter.resolve(packet);
        return;
      }
      this.packets.push(packet);
    });
    this.send({
      type: opType.Auth,
      clientId: this.clientId,
      clientName: this.clientId,
      clientKey: this.clientKey,
      protocolVersion: PROTOCOL_VERSION,
      lastPulledRevision: this.lastPulledRevision,
    });
    const ack = await this.waitFor(packet => packet.type === opType.AuthAck);
    if (ack.type !== opType.AuthAck) {
      throw new Error(`Expected AuthAck, got ${ack.type}`);
    }
    this.clientKey = ack.newClientKey;
  }

  send(packet: wsPacket): void {
    this.ws?.send(encodePacket(packet));
  }

  waitFor(predicate: (packet: wsPacket) => boolean): Promise<wsPacket> {
    const existingIndex = this.packets.findIndex(predicate);
    if (existingIndex !== -1) {
      const [packet] = this.packets.splice(existingIndex, 1);
      return Promise.resolve(packet);
    }
    return withTimeout(new Promise(resolve => {
      this.waiters.push({ predicate, resolve });
    }), 2000, "timed out waiting for websocket packet");
  }

  waitForClose(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }
    return withTimeout(new Promise(resolve => {
      ws.addEventListener("close", () => resolve(), { once: true });
    }), 2000, "timed out waiting for websocket close");
  }

  close(): void {
    this.ws?.close();
  }
}

function mutation(path: string, content: string): SyncMutation {
  return {
    mutationId: crypto.randomUUID(),
    operation: "UpsertFile",
    path,
    content,
    storageKind: "text",
    isYjs: path.endsWith(".md"),
    isFolder: false,
    created: Date.now(),
  };
}

function updateBatch(segmentId: string, mutations: SyncMutation[]): Extract<wsPacket, { type: opType.UpdateBatch }> {
  const jsonl = mutations.map((entry, index) => JSON.stringify({ ...entry, id: index + 1 })).join("\n") + "\n";
  return { type: opType.UpdateBatch, segmentId, jsonl };
}

function httpUrl(path: string): string {
  if (!wsServer) {
    throw new Error("test server is not running");
  }
  return `http://127.0.0.1:${wsServer.port}${path}`;
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function serverPacketPaths(packet: wsPacket): string[] {
  if (packet.type === opType.ChangeBatch) {
    return packet.changes.map(change => change.path);
  }
  if (packet.type === opType.SnapshotReset) {
    return packet.files.map(change => change.path);
  }
  throw new Error(`Expected server changes, got ${packet.type}`);
}

function docFromState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, state);
  return doc;
}

async function currentServerDoc(path: string): Promise<Y.Doc> {
  const file = await getFile(path);
  expect(file?.yjsState).toBeInstanceOf(Uint8Array);
  return docFromState(file!.yjsState!);
}

async function catchUpClientDoc(path: string, doc: Y.Doc): Promise<void> {
  const ack = await handleDocSync([{
    path,
    stateVector: Y.encodeStateVector(doc),
    content: readDoc(doc),
  }]);
  const syncResult = ack.paths.find(entry => entry.path === path);
  expect(syncResult).toBeDefined();
  if (syncResult!.data.length > 0) {
    Y.applyUpdateV2(doc, syncResult!.data);
  }
}

function expectMarkerOnce(content: string, marker: string): void {
  expect(content.includes(marker)).toBe(true);
  expect(content.indexOf(marker)).toBe(content.lastIndexOf(marker));
}

function percentile(values: number[], rank: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
}

function logLatencySummary(
  label: string,
  measurements: Record<string, number[]>,
  counters: Record<string, number | string> = {},
): void {
  const rows = Object.entries(measurements).map(([name, values]) => ({
    name,
    count: values.length,
    total: formatMs(sum(values)),
    avg: formatMs(sum(values) / Math.max(values.length, 1)),
    p50: formatMs(percentile(values, 50)),
    p95: formatMs(percentile(values, 95)),
    max: formatMs(Math.max(0, ...values)),
  }));
  console.info(`${label} counters`, counters);
  console.table(rows);
}

async function measure<T>(bucket: number[], work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await work();
  } finally {
    bucket.push(performance.now() - started);
  }
}

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

type SampleVaultSnapshot = {
  folderMutations: SyncMutation[];
  fileMutations: SyncMutation[];
  markdownPaths: string[];
  skippedLargeFiles: number;
  totalBytes: number;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function vaultRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join(posix.sep);
}

async function listSampleVaultFiles(root: string): Promise<{ path: string; size: number }[]> {
  const files: { path: string; size: number }[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relativePath = vaultRelativePath(root, fullPath);
      if (!shouldSyncPath(relativePath)) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        files.push({ path: fullPath, size: (await stat(fullPath)).size });
      }
    }
  }
  await walk(root);
  return files.sort((a, b) => vaultRelativePath(root, a.path).localeCompare(vaultRelativePath(root, b.path)));
}

function folderMutationsForFiles(paths: string[]): SyncMutation[] {
  const folders = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const folder = parts.slice(0, index).join("/");
      if (shouldSyncPath(folder)) {
        folders.add(folder);
      }
    }
  }
  return [...folders].sort().map(path => ({
    mutationId: crypto.randomUUID(),
    operation: "CreateFolder",
    path,
    isFolder: true,
    created: Date.now(),
  }));
}

async function buildSampleVaultSnapshot(root: string): Promise<SampleVaultSnapshot> {
  const files = await listSampleVaultFiles(root);
  const fileMutations: SyncMutation[] = [];
  const markdownPaths: string[] = [];
  let skippedLargeFiles = 0;
  let totalBytes = 0;

  for (const file of files) {
    const path = vaultRelativePath(root, file.path);
    const isYjs = shouldUseYjs(path);
    if (!isYjs && file.size > SAMPLE_VAULT_INLINE_LIMIT) {
      skippedLargeFiles++;
      continue;
    }

    if (isYjs) {
      const content = await Bun.file(file.path).text();
      const bytes = new TextEncoder().encode(content);
      totalBytes += bytes.byteLength;
      markdownPaths.push(path);
      fileMutations.push({
        mutationId: crypto.randomUUID(),
        operation: "UpsertFile",
        path,
        content,
        yjsState: stateFromMarkdown(content),
        isYjs: true,
        isFolder: false,
        storageKind: "text",
        byteSize: bytes.byteLength,
        created: Date.now(),
      });
    } else {
      const bytes = new Uint8Array(await Bun.file(file.path).arrayBuffer());
      totalBytes += bytes.byteLength;
      fileMutations.push({
        mutationId: crypto.randomUUID(),
        operation: "UpsertFile",
        path,
        contentBytes: bytes,
        isYjs: false,
        isFolder: false,
        storageKind: "bytea",
        byteSize: bytes.byteLength,
        contentSha256: `sample-vault-${bytes.byteLength}-${path.length}`,
        created: Date.now(),
      });
    }
  }

  return {
    folderMutations: folderMutationsForFiles(fileMutations.map(mutation => mutation.path)),
    fileMutations,
    markdownPaths,
    skippedLargeFiles,
    totalBytes,
  };
}

async function acceptInBatches(clientId: string, mutations: SyncMutation[]): Promise<string> {
  let revision = await getServerRevision();
  for (let offset = 0; offset < mutations.length; offset += SAMPLE_VAULT_BATCH_SIZE) {
    revision = await acceptMutations(clientId, mutations.slice(offset, offset + SAMPLE_VAULT_BATCH_SIZE));
  }
  return revision;
}

const dbAvailable = await canConnectToDatabase();
const describeIntegration = dbAvailable ? describe : describe.skip;

describeIntegration("sync engine postgres integration", () => {
  beforeAll(async () => {
    await setupIntegrationDb();
    wsServer = Bun.serve({
      ...server,
      port: 0,
    });
    wsUrl = `ws://127.0.0.1:${wsServer.port}/worker`;
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

  afterAll(() => {
    wsServer?.stop(true);
    wsServer = null;
  });

  it("bootstraps the first client key from the first auth request", async () => {
    const auth = await authenticateClientKey("To Be Generated");

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
    expect(rows[0]!.clientKey).toBe(auth.clientKey!);
    expect(rows[0]!.valid).toBe(true);
  });

  it("does not rotate a valid client key during normal auth", async () => {
    const first = await authenticateClientKey("To Be Generated");
    expect(first.clientKey).toBeDefined();

    const second = await authenticateClientKey(first.clientKey!);

    expect(second.authenticated).toBe(true);
    expect(second.clientKey).toBe(first.clientKey);
    expect(await validateClientKey(first.clientKey!)).toBe(true);
  });

  it("rotates a client key only by explicit request", async () => {
    const first = await authenticateClientKey("To Be Generated");
    expect(first.clientKey).toBeDefined();

    const rotated = await rotateClientKey(first.clientKey!);

    expect(rotated.authenticated).toBe(true);
    expect(rotated.clientKey).toStartWith("obs_sync_");
    expect(rotated.clientKey).not.toBe(first.clientKey);
    expect(await validateClientKey(first.clientKey!)).toBe(false);
    expect(await validateClientKey(rotated.clientKey!)).toBe(true);
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

  it("initial markdown UpsertFile preserves client-supplied yjs_state", async () => {
    const clientState = stateFromMarkdown("client seeded");

    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: NOTE_PATH,
      content: "client seeded",
      yjsState: clientState,
      isYjs: true,
      storageKind: "text",
      created: Date.now(),
    }]);

    const file = await getFile(NOTE_PATH);
    expect(file?.content).toBe("client seeded");
    expect(file?.yjsState).toEqual(clientState);
  });

  it("includes materialized markdown yjs_state on UpsertFile change batches", async () => {
    const clientState = stateFromMarkdown("client seeded");

    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: NOTE_PATH,
      content: "client seeded",
      yjsState: clientState,
      isYjs: true,
      storageKind: "text",
      created: Date.now(),
    }]);

    const batch = await changeBatchPacket("0");
    const change = batch.changes.find(entry => entry.path === NOTE_PATH);
    expect(change?.operation).toBe("UpsertFile");
    expect(change?.yjsState).toEqual(clientState);
  });

  it("rejects markdown UpsertFile when content and yjs_state disagree", async () => {
    const beforeRevision = await getServerRevision();

    await expect(acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: NOTE_PATH,
      content: "visible text",
      yjsState: stateFromMarkdown("different crdt text"),
      isYjs: true,
      storageKind: "text",
      created: Date.now(),
    }])).rejects.toThrow("Yjs state/content mismatch");

    expect(await getFile(NOTE_PATH)).toBeNull();
    expect(await getServerRevision()).toBe(beforeRevision);
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

  it("accepts plugin release artifacts", async () => {
    const mainJs = new TextEncoder().encode("// synced plugin bundle");
    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: ".obsidian/plugins/obsidian-sync-engine/main.js",
      contentBytes: mainJs,
      storageKind: "bytea",
      isYjs: false,
      byteSize: mainJs.byteLength,
      contentSha256: "sha-plugin-main",
      created: Date.now(),
	    }]);
	    const file = await getFile(".obsidian/plugins/obsidian-sync-engine/main.js");
	    expect(new TextDecoder().decode(file?.contentBytes ?? undefined)).toBe("// synced plugin bundle");
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

  it("empty server requires init even when client revision is nonzero", async () => {
    const pull = await handlePull({ type: opType.PullSince, revision: "42" });

    expect(pull.type).toBe(opType.InitRequired);
    if (pull.type === opType.InitRequired) {
      expect(pull.serverRevision).toBe("0");
    }
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

  it("finalizes bootstrap snapshot atomically with staged large blobs", async () => {
    await acceptMutations(CLIENT_A, [mutation("notes/stale.md", "old partial state")]);
    expect(await getFile("notes/stale.md")).not.toBeNull();

    const bootstrapId = "bootstrap-integration-success";
    const blobPath = "assets/archive.bin";
    const blobBytes = new Uint8Array([10, 20, 30, 40, 50]);
    await putBootstrapBlob(bootstrapId, blobPath, blobBytes, "sha-bootstrap-blob");

    const result = await acceptBootstrapSnapshot(CLIENT_A, bootstrapId, [{
      mutationId: crypto.randomUUID(),
      operation: "CreateFolder",
      path: "assets",
      isFolder: true,
      created: Date.now(),
    }, {
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: NOTE_PATH,
      content: "bootstrapped note",
      yjsState: stateFromMarkdown("bootstrapped note"),
      storageKind: "text",
      isYjs: true,
      isFolder: false,
      created: Date.now(),
    }, {
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: blobPath,
      storageKind: "lo",
      isYjs: false,
      isFolder: false,
      byteSize: blobBytes.byteLength,
      contentSha256: "sha-bootstrap-blob",
      created: Date.now(),
    }]);

    expect(BigInt(result.revision)).toBeGreaterThan(0n);
    expect(result.files).toBe(3);
    expect(await getFile("notes/stale.md")).toBeNull();
    expect((await getFile(NOTE_PATH))?.content).toBe("bootstrapped note");
    expect((await readBlobFile(blobPath))?.bytes).toEqual(blobBytes);
    const blobFile = await getFile(blobPath);
    const blobEvents = await listSyncEvents(blobPath);
    expect(BigInt(blobFile?.revision ?? "0")).toBeGreaterThan(0n);
    expect(blobEvents).toHaveLength(1);
    expect(blobEvents[0]?.operation).toBe("UpsertFile");
    expect(blobEvents[0]?.storageKind).toBe("lo");
    expect(blobEvents[0]?.revision).toBe(blobFile!.revision);

    const stagedRows = await sql<{ count: string }[]>`
      SELECT COUNT(*)::TEXT AS count
      FROM bootstrap_blobs
      WHERE bootstrap_id = ${bootstrapId};
    `;
    expect(stagedRows[0]?.count).toBe("0");
  });

  it("finalizes bootstrap manifest through HTTP and removes stale files", async () => {
    await acceptMutations(CLIENT_A, [
      mutation("notes/stale.md", "old partial state"),
      mutation("ZArchive/OLD/POLS-207/Exam 2/Origins of Political Science/virtue.md", "old archive"),
    ]);

    const auth = await authenticateClientKey("To Be Generated");
    expect(auth.clientKey).toBeDefined();
    const bootstrapId = "bootstrap-http-manifest";
    const mutations: SyncMutation[] = [{
      mutationId: crypto.randomUUID(),
      operation: "CreateFolder",
      path: "notes",
      isFolder: true,
      created: Date.now(),
    }, {
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: NOTE_PATH,
      content: "bootstrapped over HTTP",
      yjsState: stateFromMarkdown("bootstrapped over HTTP"),
      storageKind: "text",
      isYjs: true,
      isFolder: false,
      created: Date.now(),
    }];
    const jsonl = encodeUpdateBatchJsonl(mutations);
    const response = await fetch(httpUrl(`/v1/bootstrap-upload/${bootstrapId}/manifest`), {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${auth.clientKey}`,
        "Content-Type": "application/x-ndjson",
        "X-Client-Id": CLIENT_A,
        "X-Content-Sha256": await sha256Hex(jsonl),
      },
      body: jsonl,
    });

    expect(response.status).toBe(200);
    const result = await response.json() as { revision: string; files: number };
    expect(BigInt(result.revision)).toBeGreaterThan(0n);
    expect(result.files).toBe(2);
    expect(await getFile("notes/stale.md")).toBeNull();
    expect(await getFile("ZArchive/OLD/POLS-207/Exam 2/Origins of Political Science/virtue.md")).toBeNull();
    expect((await getFile(NOTE_PATH))?.content).toBe("bootstrapped over HTTP");
  });

  it("rolls back bootstrap finalize when a staged large blob is missing", async () => {
    await acceptMutations(CLIENT_A, [mutation("notes/stale.md", "old partial state")]);

    await expect(acceptBootstrapSnapshot(CLIENT_A, "bootstrap-missing-blob", [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: "assets/missing.bin",
      storageKind: "lo",
      isYjs: false,
      isFolder: false,
      byteSize: 5,
      contentSha256: "sha-missing",
      created: Date.now(),
    }])).rejects.toThrow("Bootstrap blob is missing");

    expect((await getFile("notes/stale.md"))?.content).toBe("old partial state");
    expect(await getFile("assets/missing.bin")).toBeNull();
  });

  it("skips large object mutations that do not have uploaded blob content", async () => {
    const revision = await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: "assets/missing-large.bin",
      storageKind: "lo",
      isYjs: false,
      isFolder: false,
      byteSize: 5,
      contentSha256: "sha-missing-large",
      created: Date.now(),
    }]);

    expect(revision).toBe(await getServerRevision());
    expect(await getFile("assets/missing-large.bin")).toBeNull();
    expect(await listSyncEvents("assets/missing-large.bin")).toHaveLength(0);
  });

  it("accepts an HTTP blob upload larger than Bun's default 128 MiB request limit", async () => {
    const samplePath = join(SAMPLE_VAULT_PATH, ...SAMPLE_LARGE_PDF_PATH.split("/"));
    const hasSample = await pathExists(samplePath);
    const path = hasSample ? SAMPLE_LARGE_PDF_PATH : "assets/synthetic-over-128mb.bin";
    const byteSize = hasSample
      ? (await stat(samplePath)).size
      : BUN_DEFAULT_MAX_REQUEST_BODY_SIZE + 1;
    expect(byteSize).toBeGreaterThan(BUN_DEFAULT_MAX_REQUEST_BODY_SIZE);

    const auth = await authenticateClientKey("To Be Generated");
    expect(auth.clientKey).toBeDefined();
    const body = hasSample
      ? Bun.file(samplePath)
      : new Uint8Array(byteSize).fill(7);
    const response = await fetch(httpUrl(`/v1/blobs/${encodePathToken(path)}`), {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${auth.clientKey}`,
        "Content-Type": "application/octet-stream",
        "X-Content-Sha256": "sha-over-128mb",
        "X-Client-Id": CLIENT_A,
      },
      body,
    });

    expect(response.status).not.toBe(413);
    expect(response.status).toBeGreaterThanOrEqual(200);
    expect(response.status).toBeLessThan(300);
    const uploaded = await response.json() as { uploadId: string; byteSize: number; contentSha256: string };
    expect(uploaded.uploadId.startsWith("blob_")).toBeTrue();
    expect(uploaded.byteSize).toBe(byteSize);
    expect(await getBlobMetadata(path)).toBeNull();

    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path,
      storageKind: "lo",
      blobUploadId: uploaded.uploadId,
      isYjs: false,
      byteSize,
      contentSha256: "sha-over-128mb",
      created: Date.now(),
    }]);
    expect((await getBlobMetadata(path))?.byteSize).toBe(byteSize);

    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "Delete",
      path,
      isFolder: false,
      created: Date.now(),
    }]);
    expect(await getBlobMetadata(path)).toBeNull();
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
    const beforeUpdateRevision = await getServerRevision();

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

    const pull = await handlePull({ type: opType.PullSince, revision: beforeUpdateRevision });
    expect(pull.type).toBe(opType.ChangeBatch);
    if (pull.type === opType.ChangeBatch) {
      const yjsChange = pull.changes.find(change => change.operation === "YjsUpdate");
      expect(yjsChange?.yjsState).toBeInstanceOf(Uint8Array);
      expect(yjsChange?.data).toBeInstanceOf(Uint8Array);
    }
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

  it("many online edits converge after a heavily edited offline client reconnects", async () => {
    setCompactionConfig({ count: 10000, bytes: 100 * 1024 * 1024 });
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "seed\n");

    const seeded = await getFile(NOTE_PATH);
    expect(seeded?.yjsState).toBeInstanceOf(Uint8Array);

    const offlineDoc = docFromState(seeded!.yjsState!);
    const onlineClients = Array.from({ length: 5 }, (_, index) => ({
      clientId: `integration-online-${index}`,
      doc: docFromState(seeded!.yjsState!),
      markers: [] as string[],
    }));
    const offlineMarkers: string[] = [];
    const latencies = {
      offlineLocalEdit: [] as number[],
      onlineCatchUp: [] as number[],
      onlineUpload: [] as number[],
      offlineReconnectUpload: [] as number[],
      finalCatchUp: [] as number[],
      serverMaterializeRead: [] as number[],
    };
    for (const client of onlineClients) {
      await ensureIntegrationClient(client.clientId);
    }
    await ensureIntegrationClient("integration-offline");

    try {
      for (let index = 0; index < 250; index++) {
        const marker = `[offline-${index}]`;
        const started = performance.now();
        appendToDoc(offlineDoc, `${marker}\n`);
        latencies.offlineLocalEdit.push(performance.now() - started);
        offlineMarkers.push(marker);
      }

      for (let index = 0; index < 400; index++) {
        const client = onlineClients[index % onlineClients.length]!;
        await measure(latencies.onlineCatchUp, () => catchUpClientDoc(NOTE_PATH, client.doc));
        const marker = `[${client.clientId}-${index}]`;
        appendToDoc(client.doc, `${marker}\n`);
        client.markers.push(marker);
        await measure(
          latencies.onlineUpload,
          () => uploadYjsEdit(client.clientId, NOTE_PATH, client.doc, crypto.randomUUID()),
        );
      }

      await measure(
        latencies.offlineReconnectUpload,
        () => uploadYjsEdit("integration-offline", NOTE_PATH, offlineDoc, crypto.randomUUID()),
      );

      const serverDoc = await measure(latencies.serverMaterializeRead, () => currentServerDoc(NOTE_PATH));
      try {
        const serverContent = readDoc(serverDoc);
        expect((await getFile(NOTE_PATH))?.content).toBe(serverContent);

        for (const marker of offlineMarkers) {
          expectMarkerOnce(serverContent, marker);
        }
        for (const client of onlineClients) {
          for (const marker of client.markers) {
            expectMarkerOnce(serverContent, marker);
          }
        }

        await measure(latencies.finalCatchUp, () => catchUpClientDoc(NOTE_PATH, offlineDoc));
        expect(readDoc(offlineDoc)).toBe(serverContent);

        for (const client of onlineClients) {
          await measure(latencies.finalCatchUp, () => catchUpClientDoc(NOTE_PATH, client.doc));
          expect(readDoc(client.doc)).toBe(serverContent);
        }

        logLatencySummary("offline reconnect convergence stress", latencies, {
          onlineClients: onlineClients.length,
          onlineEdits: onlineClients.reduce((count, client) => count + client.markers.length, 0),
          offlineEdits: offlineMarkers.length,
          finalContentBytes: new TextEncoder().encode(serverContent).byteLength,
          finalContentChars: serverContent.length,
        });
      } finally {
        serverDoc.destroy();
      }
    } finally {
      offlineDoc.destroy();
      for (const client of onlineClients) {
        client.doc.destroy();
      }
    }
  });

  it("initial-syncs a large real sample vault, simulates two clients typing, and bootstraps the result", async () => {
    if (!(await pathExists(SAMPLE_VAULT_PATH))) {
      console.warn(`sample vault integration skipped: ${SAMPLE_VAULT_PATH} does not exist`);
      return;
    }

    setCompactionConfig({ count: 10000, bytes: 100 * 1024 * 1024 });
    await ensureIntegrationClient("sample-vault-seeder");
    await ensureIntegrationClient("sample-vault-typer-a");
    await ensureIntegrationClient("sample-vault-typer-b");

    const latencies = {
      scanVault: [] as number[],
      initialFolderUpload: [] as number[],
      initialFileUpload: [] as number[],
      typingUpload: [] as number[],
      finalCatchUp: [] as number[],
      bootstrapBuild: [] as number[],
      bootstrapInspect: [] as number[],
    };
    const sample = await measure(latencies.scanVault, () => buildSampleVaultSnapshot(SAMPLE_VAULT_PATH));
    expect(sample.fileMutations.length).toBeGreaterThan(500);
    expect(sample.markdownPaths.length).toBeGreaterThan(100);
    expect(sample.skippedLargeFiles).toBeGreaterThan(0);

    await measure(latencies.initialFolderUpload, () => acceptInBatches("sample-vault-seeder", sample.folderMutations));
    const initialRevision = await measure(latencies.initialFileUpload, () => acceptInBatches("sample-vault-seeder", sample.fileMutations));
    expect(BigInt(initialRevision)).toBeGreaterThan(0n);

    const snapshot = await snapshotPacket();
    const expectedSnapshotPaths = new Set([
      ...sample.folderMutations.map(mutation => mutation.path),
      ...sample.fileMutations.map(mutation => mutation.path),
    ]);
    const snapshotPaths = new Set(snapshot.files.map(file => file.path));
    const missingSnapshotPaths = [...expectedSnapshotPaths].filter(path => !snapshotPaths.has(path));
    expect(missingSnapshotPaths).toEqual([]);
    expect(snapshot.files.length).toBeGreaterThanOrEqual(expectedSnapshotPaths.size);
    expect(snapshot.files.some(file => file.path.startsWith(".trash/"))).toBe(false);
    expect(snapshot.files.some(file => file.path.includes("/.git/") || file.path === ".git")).toBe(false);
    expect(snapshot.files.some(file => file.path.endsWith(".md") && file.yjsState?.byteLength)).toBe(true);
    expect(snapshot.files.some(file => file.storageKind === "bytea" && (file.contentBytes?.byteLength ?? 0) > 0)).toBe(true);

    const pull = await handlePull({ type: opType.PullSince, revision: "0" });
    expect(pull.type).toBe(opType.SnapshotReset);
    if (pull.type === opType.SnapshotReset) {
      expect(pull.files).toHaveLength(snapshot.files.length);
    }

    const typingPath = sample.markdownPaths.find(path => path === "Blog/Test Blog.md")
      ?? sample.markdownPaths.find(path => path.startsWith("Blog/"))
      ?? sample.markdownPaths[0]!;
    const baseFile = await getFile(typingPath);
    expect(baseFile?.yjsState).toBeInstanceOf(Uint8Array);
    const docA = docFromState(baseFile!.yjsState!);
    const docB = docFromState(baseFile!.yjsState!);
    const markersA: string[] = [];
    const markersB: string[] = [];

    try {
      for (let index = 0; index < 30; index++) {
        const markerA = `[sample-vault-client-a-${index}]`;
        appendToDoc(docA, `\n${markerA}`);
        markersA.push(markerA);
        await measure(latencies.typingUpload, () => uploadYjsEdit("sample-vault-typer-a", typingPath, docA, crypto.randomUUID()));

        const markerB = `[sample-vault-client-b-${index}]`;
        appendToDoc(docB, `\n${markerB}`);
        markersB.push(markerB);
        await measure(latencies.typingUpload, () => uploadYjsEdit("sample-vault-typer-b", typingPath, docB, crypto.randomUUID()));
      }

      const serverDoc = await currentServerDoc(typingPath);
      try {
        const serverContent = readDoc(serverDoc);
        for (const marker of [...markersA, ...markersB]) {
          expectMarkerOnce(serverContent, marker);
        }
        expect((await getFile(typingPath))?.content).toBe(serverContent);

        await measure(latencies.finalCatchUp, () => catchUpClientDoc(typingPath, docA));
        await measure(latencies.finalCatchUp, () => catchUpClientDoc(typingPath, docB));
        expect(readDoc(docA)).toBe(serverContent);
        expect(readDoc(docB)).toBe(serverContent);
      } finally {
        serverDoc.destroy();
      }
    } finally {
      docA.destroy();
      docB.destroy();
    }

    const built = await measure(latencies.bootstrapBuild, () => buildBootstrapZip({
      vaultName: "Sample Vault Bootstrap",
      backendUrl: "https://sync.example.test",
      configDir: ".obsidian",
      pluginId: "obsidian-sync-engine",
    }));
    try {
      const centralNames = await measure(latencies.bootstrapInspect, () => readStoredZipCentralDirectory(built.zipPath));
      expect(centralNames).toContain(`Sample Vault Bootstrap/${typingPath}`);
      expect(centralNames).toContain(`Sample Vault Bootstrap/.sync-engine-state/obsidian-sync-engine/yjs/${typingPath}.state`);
      expect(centralNames).toContain(`Sample Vault Bootstrap/.sync-engine-state/obsidian-sync-engine/yjs/${typingPath}.state.sha256`);
      expect(centralNames).toContain("Sample Vault Bootstrap/.obsidian/plugins/obsidian-sync-engine/data.json");
      expect(built.snapshotRevision).toBe(await getServerRevision());
      expect(built.zipBytes).toBeGreaterThan(sample.totalBytes);
    } finally {
      await built.cleanup();
    }

    logLatencySummary("sample vault initial sync and two-client typing", latencies, {
      folders: sample.folderMutations.length,
      files: sample.fileMutations.length,
      markdownFiles: sample.markdownPaths.length,
      skippedLargeFiles: sample.skippedLargeFiles,
      loadedBytes: sample.totalBytes,
      typingPath,
      typedEdits: markersA.length + markersB.length,
    });
  }, 20_000);

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

  it("raw Yjs delta without handshake is rejected without minting a revision", async () => {
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "hello");
    const beforeRevision = await getServerRevision();

    const mismatchedDoc = makeClientDoc("hello");
    const before = Y.encodeStateVector(mismatchedDoc);
    appendToDoc(mismatchedDoc, " FAIL");
    const badDelta = Y.encodeStateAsUpdateV2(mismatchedDoc, before);
    mismatchedDoc.destroy();

    await expect(acceptMutations(CLIENT_A, [mutationYjsUpdate(NOTE_PATH, badDelta)]))
      .rejects.toThrow("unresolved dependencies");

    const file = await getFile(NOTE_PATH);
    expect(file?.content).toBe("hello");
    expect(await getServerRevision()).toBe(beforeRevision);
    expect(await listYjsEvents(NOTE_PATH)).toHaveLength(0);
  });

  it("compaction flushes files then deletes yjs sync_events", async () => {
    setCompactionConfig({ count: 3, bytes: 1 });

    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "line");

    const doc = makeClientDoc("line");
    for (const ch of ["1", "2", "3", "4"]) {
      appendToDoc(doc, ch);
      await uploadYjsEdit(CLIENT_A, NOTE_PATH, doc, crypto.randomUUID());
    }
    await compactYjsEvents();

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
    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "CreateFolder",
      path: "/",
      isFolder: true,
      created: Date.now(),
    }]);
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
    const pluginMainJs = new TextEncoder().encode("// bootstrap plugin");
    await acceptMutations(CLIENT_A, [{
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path: ".obsidian/plugins/obsidian-sync-engine/main.js",
      contentBytes: pluginMainJs,
      storageKind: "bytea",
      isYjs: false,
      byteSize: pluginMainJs.byteLength,
      contentSha256: "sha-plugin-main",
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
      expect(centralNames).toContain("Bootstrap Vault/");
      expect(centralNames).toContain("Bootstrap Vault/notes/test.md");
      expect(new TextDecoder().decode(entries.get("Bootstrap Vault/notes/test.md"))).toBe("bootstrap note");
      expect(entries.get("Bootstrap Vault/.obsidian/workspace.json")).toEqual(new TextEncoder().encode('{"pane":"left"}'));
      expect(entries.get("Bootstrap Vault/assets/photo.bin")).toEqual(new Uint8Array([0, 1, 2, 255]));
      expect(new TextDecoder().decode(entries.get("Bootstrap Vault/.obsidian/plugins/obsidian-sync-engine/main.js"))).toBe("// bootstrap plugin");
      expect(entries.get("Bootstrap Vault/.sync-engine-state/obsidian-sync-engine/yjs/notes/test.md.state")?.byteLength).toBeGreaterThan(0);
      expect(new TextDecoder().decode(entries.get("Bootstrap Vault/.sync-engine-state/obsidian-sync-engine/yjs/notes/test.md.state.sha256"))).toBe(await sha256Hex("bootstrap note"));
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

  it("bootstrapped clients pull edits made after the link revision without re-uploading the old snapshot", async () => {
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "a");
    const built = await buildBootstrapZip({
      vaultName: "Bootstrap Vault",
      backendUrl: "https://sync.example.test",
      configDir: ".obsidian",
      pluginId: "obsidian-sync-engine",
    });

    try {
      const entries = await readStoredZip(built.zipPath);
      expect(new TextDecoder().decode(entries.get("Bootstrap Vault/notes/test.md"))).toBe("a");
      const data = JSON.parse(new TextDecoder().decode(entries.get("Bootstrap Vault/.obsidian/plugins/obsidian-sync-engine/data.json")));
      expect(data.lastPulledRevision).toBe(built.snapshotRevision);

      const desktopDoc = await currentServerDoc(NOTE_PATH);
      try {
        for (const char of ["b", "c", "d", "s"]) {
          appendToDoc(desktopDoc, char);
          await uploadYjsEdit(CLIENT_A, NOTE_PATH, desktopDoc);
        }
      } finally {
        desktopDoc.destroy();
      }
      expect((await getFile(NOTE_PATH))?.content).toBe("abcds");

      const pull = await handlePull({ type: opType.PullSince, revision: built.snapshotRevision });
      expect(pull.type).toBe(opType.ChangeBatch);
      if (pull.type !== opType.ChangeBatch) {
        return;
      }
      expect(pull.changes.filter(change => change.operation === "YjsUpdate")).toHaveLength(4);

      const bootstrappedState = entries.get("Bootstrap Vault/.sync-engine-state/obsidian-sync-engine/yjs/notes/test.md.state");
      expect(bootstrappedState).toBeInstanceOf(Uint8Array);
      const bootstrappedDoc = docFromState(bootstrappedState!);
      try {
        for (const change of pull.changes) {
          if (change.operation === "YjsUpdate") {
            expect(change.yjsState).toBeInstanceOf(Uint8Array);
            Y.applyUpdateV2(bootstrappedDoc, change.yjsState!);
          }
        }
        expect(readDoc(bootstrappedDoc)).toBe("abcds");
      } finally {
        bootstrappedDoc.destroy();
      }

      expect(await getServerRevision()).toBe(pull.serverRevision);
    } finally {
      await built.cleanup();
    }
  });

  it("skips corrupt large object rows when building a bootstrap zip", async () => {
    await seedMarkdownFile(CLIENT_A, NOTE_PATH, "bootstrap note");
    await sql`
      INSERT INTO files (
        path,
        content,
        content_bytes,
        content_oid,
        storage_kind,
        byte_size,
        content_sha256,
        yjs_state,
        is_folder,
        is_yjs,
        deleted,
        revision,
        updated_at
      )
      VALUES (
        'Images/Pasted image 20220906172538.png',
        NULL,
        NULL,
        NULL,
        'lo',
        12345,
        'sha-corrupt',
        NULL,
        FALSE,
        FALSE,
        FALSE,
        0,
        NOW()
      );
    `;

    const built = await buildBootstrapZip({
      vaultName: "Bootstrap Vault",
      backendUrl: "https://sync.example.test",
      configDir: ".obsidian",
      pluginId: "obsidian-sync-engine",
    });

    try {
      const entries = await readStoredZip(built.zipPath);
      expect(new TextDecoder().decode(entries.get("Bootstrap Vault/notes/test.md"))).toBe("bootstrap note");
      expect(entries.has("Bootstrap Vault/Images/Pasted image 20220906172538.png")).toBe(false);
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
    await compactYjsEvents();

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

  it("websocket fan-out keeps prior changes until the target explicitly pulls", async () => {
    const peerB = new TestPeer("ws-client-b", "obs_sync_seed", "0");
    await peerB.connect();
    const peerA = new TestPeer("ws-client-a", peerB.clientKey, "0");
    await peerA.connect();

    try {
      peerA.send(updateBatch("segment-1", [mutation("notes/a.md", "first")]));
      await peerA.waitFor(packet => packet.type === opType.BatchAck && packet.segmentId === "segment-1");
      const firstPush = await peerB.waitFor(packet => packet.type === opType.ChangeBatch || packet.type === opType.SnapshotReset);
      expect(serverPacketPaths(firstPush)).toEqual(["notes/a.md"]);

      peerA.send(updateBatch("segment-2", [mutation("notes/b.md", "second")]));
      await peerA.waitFor(packet => packet.type === opType.BatchAck && packet.segmentId === "segment-2");
      const secondPush = await peerB.waitFor(packet => packet.type === opType.ChangeBatch || packet.type === opType.SnapshotReset);

      expect(serverPacketPaths(secondPush)).toEqual(["notes/a.md", "notes/b.md"]);
    } finally {
      peerA.close();
      peerB.close();
    }
  });

  it("websocket batch acks large object metadata when uploaded blob content is missing", async () => {
    const peer = new TestPeer("ws-missing-blob-client", "obs_sync_seed", "0");
    await peer.connect();

    try {
      const path = "Images/Pasted image 20220906174701.png";
      peer.send(updateBatch("missing-blob-segment", [{
        mutationId: crypto.randomUUID(),
        operation: "UpsertFile",
        path,
        storageKind: "lo",
        isYjs: false,
        isFolder: false,
        byteSize: 12345,
        contentSha256: "sha-missing-websocket-blob",
        created: Date.now(),
      }]));

      const ack = await peer.waitFor(packet => packet.type === opType.BatchAck && packet.segmentId === "missing-blob-segment");
      expect(ack.type).toBe(opType.BatchAck);
      expect(await getFile(path)).toBeNull();
      expect(await listSyncEvents(path)).toHaveLength(0);
    } finally {
      peer.close();
    }
  });

  it("websocket auth evicts an older connection with the same clientId", async () => {
    const first = new TestPeer("duplicate-client", "obs_sync_seed", "0");
    await first.connect();
    const second = new TestPeer("duplicate-client", first.clientKey, "0");
    await second.connect();

    try {
      await first.waitForClose();
    } finally {
      first.close();
      second.close();
    }
  });
});

if (!dbAvailable) {
  afterAll(() => {
    console.warn(
      "postgres integration tests skipped: set DATABASE_URL (or Bun's default postgres env) and run migrations",
    );
  });
}
