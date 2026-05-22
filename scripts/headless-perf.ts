#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { performance } from "node:perf_hooks";
import * as Y from "yjs";
import { decodePacket, encodePacket, encodeUpdateBatchJsonl } from "../shared/protocol";
import { shouldSyncPath, shouldUseYjs } from "../shared/pathPolicy";
import { opType, ServerChange, SyncMutation } from "../shared/types";
import { docStateFromContent, MARKDOWN_FIELD } from "../shared/yjsSeed";

type MemorySample = {
  atMs: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
};

type PhaseResult = {
  name: string;
  durationMs: number;
  memoryStart: MemorySample;
  memoryEnd: MemorySample;
  memoryPeak: MemorySample;
  eventLoopLagMs: {
    max: number;
    avg: number;
    p95: number;
    samples: number;
  };
  stats?: Record<string, unknown>;
};

type VaultEntry = {
  path: string;
  absPath: string;
  size: number;
  isMarkdown: boolean;
  useYjs: boolean;
};

const repoRoot = "/home/shlok/Documents/Programming/sandbox/obsidian-sync-engine";
const defaultVaultPath = "/home/shlok/Documents/Programming/sandbox/convex-sync";
const vaultPath = argValue("--vault") ?? Bun.env.HEADLESS_PERF_VAULT ?? defaultVaultPath;
const reportDir = join(repoRoot, "mega-test-results");
const runs = numberArg("--runs", Number(Bun.env.HEADLESS_PERF_RUNS ?? "3"));
const batchSize = numberArg("--batch-size", Number(Bun.env.HEADLESS_PERF_BATCH_SIZE ?? "100"));
const maxFiles = numberArg("--max-files", Number(Bun.env.HEADLESS_PERF_MAX_FILES ?? "0"));
const inlineLimit = numberArg("--inline-limit", Number(Bun.env.HEADLESS_PERF_INLINE_LIMIT ?? String(64 * 1024)));
const sampleIntervalMs = numberArg("--sample-interval-ms", Number(Bun.env.HEADLESS_PERF_SAMPLE_INTERVAL_MS ?? "100"));
const materializeLimit = numberArg("--materialize-limit", Number(Bun.env.HEADLESS_PERF_MATERIALIZE_LIMIT ?? "0"));
const stressRepeats = numberArg("--stress-repeats", Number(Bun.env.HEADLESS_PERF_STRESS_REPEATS ?? "1"));
const floodCounts = (argValue("--flood-counts") ?? Bun.env.HEADLESS_PERF_FLOOD_COUNTS ?? "10,100,1000,10000")
  .split(",")
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value > 0);
const blobEvery = numberArg("--blob-every", Number(Bun.env.HEADLESS_PERF_BLOB_EVERY ?? "100"));
const blobBytes = numberArg("--blob-bytes", Number(Bun.env.HEADLESS_PERF_BLOB_BYTES ?? String(16 * 1024)));
const loBlobBytes = numberArg("--lo-blob-bytes", Number(Bun.env.HEADLESS_PERF_LO_BLOB_BYTES ?? String(5 * 1024 * 1024)));
const runGc = process.argv.includes("--gc") || Bun.env.HEADLESS_PERF_GC === "1";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index !== -1) {
    return process.argv[index + 1];
  }
  const prefix = `${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}

function numberArg(name: string, fallback: number): number {
  const value = argValue(name);
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number for ${name}: ${value}`);
  }
  return parsed;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function mb(bytes: number): number {
  return bytes / 1024 / 1024;
}

function memorySample(startedAt = performance.now()): MemorySample {
  const usage = process.memoryUsage();
  return {
    atMs: round(performance.now() - startedAt),
    rssMb: round(mb(usage.rss)),
    heapUsedMb: round(mb(usage.heapUsed)),
    heapTotalMb: round(mb(usage.heapTotal)),
    externalMb: round(mb(usage.external)),
    arrayBuffersMb: round(mb(usage.arrayBuffers)),
  };
}

function summarize(values: number[]): { avg: number; p95: number; p99: number; peak: number } {
  if (values.length === 0) {
    return { avg: 0, p95: 0, p99: 0, peak: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))]!;
  return {
    avg: round(values.reduce((sum, value) => sum + value, 0) / values.length),
    p95: round(pick(0.95)),
    p99: round(pick(0.99)),
    peak: round(sorted[sorted.length - 1]!),
  };
}

async function withPhase<T>(
  name: string,
  fn: (samples: MemorySample[]) => Promise<{ value: T; stats?: Record<string, unknown> }>,
): Promise<{ value: T; result: PhaseResult; samples: MemorySample[] }> {
  forceGc();
  const started = performance.now();
  const samples: MemorySample[] = [memorySample(started)];
  const lagSamples: number[] = [];
  let stopped = false;
  let lastTick = performance.now();
  const interval = setInterval(() => {
    const now = performance.now();
    lagSamples.push(Math.max(0, now - lastTick - sampleIntervalMs));
    lastTick = now;
    samples.push(memorySample(started));
  }, sampleIntervalMs);

  try {
    const { value, stats } = await fn(samples);
    await new Promise(resolve => setImmediate(resolve));
    stopped = true;
    clearInterval(interval);
    samples.push(memorySample(started));
    const result: PhaseResult = {
      name,
      durationMs: round(performance.now() - started),
      memoryStart: samples[0]!,
      memoryEnd: samples[samples.length - 1]!,
      memoryPeak: samples.reduce((peak, sample) => sample.rssMb > peak.rssMb ? sample : peak, samples[0]!),
      eventLoopLagMs: {
        max: round(Math.max(0, ...lagSamples)),
        avg: summarize(lagSamples).avg,
        p95: summarize(lagSamples).p95,
        samples: lagSamples.length,
      },
      stats,
    };
    return { value, result, samples };
  } finally {
    if (!stopped) {
      clearInterval(interval);
    }
    forceGc();
  }
}

function forceGc(): void {
  if (runGc && typeof globalThis.gc === "function") {
    globalThis.gc();
  }
}

async function listVaultEntries(root: string): Promise<VaultEntry[]> {
  const entries: VaultEntry[] = [];
  async function walk(dir: string): Promise<void> {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const absPath = join(dir, item.name);
      const path = relative(root, absPath).split(sep).join("/");
      if (item.isDirectory()) {
        if (shouldSyncPath(path) || path === ".obsidian") {
          await walk(absPath);
        }
        continue;
      }
      if (!item.isFile() || !shouldSyncPath(path)) {
        continue;
      }
      const fileStat = await stat(absPath);
      entries.push({
        path,
        absPath,
        size: fileStat.size,
        isMarkdown: path.endsWith(".md"),
        useYjs: shouldUseYjs(path),
      });
      if (maxFiles > 0 && entries.length >= maxFiles) {
        return;
      }
    }
  }
  await walk(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

async function readText(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

async function readBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}

function makeMutation(path: string, content: string, state: Uint8Array, created: number): SyncMutation {
  return {
    mutationId: crypto.randomUUID(),
    operation: "UpsertFile",
    path,
    content,
    yjsState: state,
    isFolder: false,
    isYjs: true,
    storageKind: "text",
    byteSize: new TextEncoder().encode(content).byteLength,
    created,
  };
}

function makeServerChange(
  revision: number,
  change: Omit<ServerChange, "revision" | "clientId" | "created"> & { created?: number; clientId?: string },
): ServerChange {
  return {
    ...change,
    revision: String(revision),
    clientId: change.clientId ?? "server-peer",
    created: change.created ?? Date.now(),
  };
}

function markdownFromState(state: Uint8Array): string {
  const doc = new Y.Doc();
  if (state.length > 0) {
    Y.applyUpdateV2(doc, state);
  }
  const text = doc.getText(MARKDOWN_FIELD).toString();
  doc.destroy();
  return text;
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

function deterministicBytes(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = (seed + i * 31) & 0xff;
  }
  return bytes;
}

function chooseFloodBase(seedRows: Array<{ path: string; content: string; state: Uint8Array }>): { path: string; content: string; state: Uint8Array } {
  const sorted = [...seedRows].sort((a, b) => b.content.length - a.content.length);
  return sorted.find(row => row.content.length > 1000) ?? sorted[0]!;
}

function makeYjsFloodChanges(
  base: { path: string; content: string; state: Uint8Array },
  count: number,
): { changes: ServerChange[]; finalState: Uint8Array; finalContent: string; totalUpdateBytes: number; maxUpdateBytes: number } {
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, base.state);
  const ytext = doc.getText(MARKDOWN_FIELD);
  const changes: ServerChange[] = [];
  let totalUpdateBytes = 0;
  let maxUpdateBytes = 0;
  for (let i = 1; i <= count; i++) {
    const before = Y.encodeStateVector(doc);
    ytext.insert(ytext.length, `\nheadless offline edit ${i}`);
    const update = Y.encodeStateAsUpdateV2(doc, before);
    totalUpdateBytes += update.byteLength;
    maxUpdateBytes = Math.max(maxUpdateBytes, update.byteLength);
    changes.push(makeServerChange(i, {
      operation: "YjsUpdate",
      path: base.path,
      data: update,
    }));
  }
  const finalState = Y.encodeStateAsUpdateV2(doc);
  const finalContent = ytext.toString();
  doc.destroy();
  return { changes, finalState, finalContent, totalUpdateBytes, maxUpdateBytes };
}

function makeBlobFloodChanges(startRevision: number, count: number): { changes: ServerChange[]; inlineBlobBytes: number; loBlobBytesTotal: number } {
  const changes: ServerChange[] = [];
  let inlineBlobBytes = 0;
  let loBlobBytesTotal = 0;
  if (blobEvery <= 0) {
    return { changes, inlineBlobBytes, loBlobBytesTotal };
  }
  for (let i = blobEvery; i <= count; i += blobEvery) {
    const inline = deterministicBytes(blobBytes, i);
    inlineBlobBytes += inline.byteLength;
    changes.push(makeServerChange(startRevision + changes.length, {
      operation: "UpsertFile",
      path: `headless/blob-${count}-${i}.bin`,
      contentBytes: inline,
      storageKind: "bytea",
      byteSize: inline.byteLength,
      contentSha256: `headless-inline-${count}-${i}`,
      isFolder: false,
      isYjs: false,
    }));
  }
  if (count >= 1000 && loBlobBytes > 0) {
    loBlobBytesTotal += loBlobBytes;
    changes.push(makeServerChange(startRevision + changes.length, {
      operation: "UpsertFile",
      path: `headless/large-${count}.bin`,
      storageKind: "lo",
      byteSize: loBlobBytes,
      contentSha256: `headless-lo-${count}`,
      isFolder: false,
      isYjs: false,
    }));
  }
  return { changes, inlineBlobBytes, loBlobBytesTotal };
}

function applyServerChangesHeadless(changes: ServerChange[]): {
  yjsStates: Map<string, Uint8Array>;
  binaryFiles: Map<string, Uint8Array>;
  loFiles: Map<string, number>;
  materializedChars: number;
} {
  const yjsStates = new Map<string, Uint8Array>();
  const binaryFiles = new Map<string, Uint8Array>();
  const loFiles = new Map<string, number>();
  let materializedChars = 0;
  for (const change of changes) {
    if (change.operation === "UpsertFile") {
      if (change.storageKind === "lo") {
        loFiles.set(change.path, change.byteSize ?? 0);
      } else if (change.contentBytes) {
        binaryFiles.set(change.path, cloneBytes(change.contentBytes));
      } else if (change.isYjs) {
        const state = change.yjsState ?? docStateFromContent(change.content ?? "", Y);
        yjsStates.set(change.path, cloneBytes(state));
      }
    } else if (change.operation === "YjsUpdate") {
      if (change.yjsState) {
        yjsStates.set(change.path, cloneBytes(change.yjsState));
      } else if (change.data) {
        const doc = new Y.Doc();
        const existing = yjsStates.get(change.path);
        if (existing) {
          Y.applyUpdateV2(doc, existing);
        }
        Y.applyUpdateV2(doc, change.data);
        materializedChars += doc.getText(MARKDOWN_FIELD).length;
        yjsStates.set(change.path, Y.encodeStateAsUpdateV2(doc));
        doc.destroy();
      }
    } else if (change.operation === "Delete") {
      yjsStates.delete(change.path);
      binaryFiles.delete(change.path);
      loFiles.delete(change.path);
    }
  }
  return { yjsStates, binaryFiles, loFiles, materializedChars };
}

async function runOnce(runId: number): Promise<Record<string, unknown>> {
  console.log(`[headless-perf] run ${runId}/${runs}`);
  const phases: PhaseResult[] = [];
  const allSamples: Record<string, MemorySample[]> = {};

  const scan = await withPhase("scan-vault", async () => {
    const entries = await listVaultEntries(vaultPath);
    const markdown = entries.filter(entry => entry.useYjs);
    return {
      value: { entries, markdown },
      stats: {
        files: entries.length,
        markdownFiles: markdown.length,
        totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
        markdownBytes: markdown.reduce((sum, entry) => sum + entry.size, 0),
        inlineLimit,
        largeFiles: entries.filter(entry => entry.size > inlineLimit).length,
      },
    };
  });
  phases.push(scan.result);
  allSamples[scan.result.name] = scan.samples;

  const seed = await withPhase("seed-markdown-yjs", async () => {
    let totalContentBytes = 0;
    let totalStateBytes = 0;
    let largestState = { path: "", bytes: 0 };
    const states: Array<{ path: string; content: string; state: Uint8Array }> = [];
    for (let repeat = 0; repeat < stressRepeats; repeat++) {
      for (const entry of scan.value.markdown) {
        const content = await readText(entry.absPath);
        const state = docStateFromContent(content, Y);
        if (repeat === stressRepeats - 1) {
          states.push({ path: entry.path, content, state });
        }
        totalContentBytes += Buffer.byteLength(content);
        totalStateBytes += state.byteLength;
        if (state.byteLength > largestState.bytes) {
          largestState = { path: entry.path, bytes: state.byteLength };
        }
      }
    }
    return {
      value: states,
      stats: {
        filesProcessed: scan.value.markdown.length * stressRepeats,
        retainedStates: states.length,
        totalContentBytes,
        totalStateBytes,
        avgStateBytes: states.length ? Math.round(totalStateBytes / (scan.value.markdown.length * stressRepeats)) : 0,
        largestState,
        stressRepeats,
      },
    };
  });
  phases.push(seed.result);
  allSamples[seed.result.name] = seed.samples;

  const jsonl = await withPhase("encode-upload-jsonl", async () => {
    const batches: string[] = [];
    let totalJsonlBytes = 0;
    let maxBatchBytes = 0;
    for (let offset = 0; offset < seed.value.length; offset += batchSize) {
      const batch = seed.value.slice(offset, offset + batchSize).map(row => makeMutation(row.path, row.content, row.state, Date.now()));
      const jsonl = encodeUpdateBatchJsonl(batch);
      const bytes = Buffer.byteLength(jsonl);
      batches.push(jsonl);
      totalJsonlBytes += bytes;
      maxBatchBytes = Math.max(maxBatchBytes, bytes);
    }
    return {
      value: batches,
      stats: {
        batches: batches.length,
        batchSize,
        totalJsonlBytes,
        maxBatchBytes,
      },
    };
  });
  phases.push(jsonl.result);
  allSamples[jsonl.result.name] = jsonl.samples;

  const bootstrap = await withPhase("bootstrap-new-client-snapshot", async () => {
    const files: ServerChange[] = [];
    let revision = 1;
    for (const row of seed.value) {
      files.push(makeServerChange(revision++, {
        operation: "UpsertFile",
        path: row.path,
        content: row.content,
        yjsState: row.state,
        isFolder: false,
        isYjs: true,
        storageKind: "text",
        byteSize: Buffer.byteLength(row.content),
      }));
    }
    const inlineNonMarkdown = scan.value.entries.filter(entry => !entry.useYjs && entry.size <= inlineLimit);
    let inlineBytes = 0;
    for (const entry of inlineNonMarkdown) {
      const contentBytes = await readBytes(entry.absPath);
      inlineBytes += contentBytes.byteLength;
      files.push(makeServerChange(revision++, {
        operation: "UpsertFile",
        path: entry.path,
        contentBytes,
        isFolder: false,
        isYjs: false,
        storageKind: "bytea",
        byteSize: contentBytes.byteLength,
      }));
    }
    const packet = {
      type: opType.SnapshotReset,
      targetRevision: String(revision - 1),
      files,
    } as const;
    const encoded = encodePacket(packet);
    const decoded = decodePacket(encoded);
    if (decoded.type !== opType.SnapshotReset) {
      throw new Error("snapshot decode returned wrong packet type");
    }
    const applied = applyServerChangesHeadless(decoded.files);
    return {
      value: null,
      stats: {
        snapshotFiles: files.length,
        markdownFiles: seed.value.length,
        inlineBinaryFiles: inlineNonMarkdown.length,
        inlineBytes,
        encodedBytes: Buffer.byteLength(encoded),
        appliedYjsStates: applied.yjsStates.size,
        appliedBinaryFiles: applied.binaryFiles.size,
        appliedLoFiles: applied.loFiles.size,
      },
    };
  });
  phases.push(bootstrap.result);
  allSamples[bootstrap.result.name] = bootstrap.samples;

  const floodBase = chooseFloodBase(seed.value);
  for (const count of floodCounts) {
    const flood = await withPhase(`offline-flood-${count}`, async () => {
      const yjsFlood = makeYjsFloodChanges(floodBase, count);
      const blobFlood = makeBlobFloodChanges(count + 1, count);
      const changes = [
        makeServerChange(0, {
          operation: "YjsUpdate",
          path: floodBase.path,
          yjsState: floodBase.state,
        }),
        ...yjsFlood.changes,
        ...blobFlood.changes,
      ];
      const packet = {
        type: opType.ChangeBatch,
        fromRevision: "0",
        serverRevision: String(changes.length),
        changes,
      } as const;
      const encoded = encodePacket(packet);
      const decoded = decodePacket(encoded);
      if (decoded.type !== opType.ChangeBatch) {
        throw new Error("change batch decode returned wrong packet type");
      }
      const applied = applyServerChangesHeadless(decoded.changes);
      const finalState = applied.yjsStates.get(floodBase.path);
      const finalText = finalState ? markdownFromState(finalState) : "";
      return {
        value: null,
        stats: {
          path: floodBase.path,
          yjsChanges: count,
          blobChanges: blobFlood.changes.length,
          inlineBlobBytes: blobFlood.inlineBlobBytes,
          loBlobBytes: blobFlood.loBlobBytesTotal,
          totalChanges: changes.length,
          encodedBytes: Buffer.byteLength(encoded),
          totalYjsUpdateBytes: yjsFlood.totalUpdateBytes,
          maxYjsUpdateBytes: yjsFlood.maxUpdateBytes,
          finalStateBytes: finalState?.byteLength ?? 0,
          finalContentChars: finalText.length,
          finalContentMatches: finalText === yjsFlood.finalContent,
          appliedYjsStates: applied.yjsStates.size,
          appliedBinaryFiles: applied.binaryFiles.size,
          appliedLoFiles: applied.loFiles.size,
          materializedCharsDuringApply: applied.materializedChars,
        },
      };
    });
    phases.push(flood.result);
    allSamples[flood.result.name] = flood.samples;
  }

  const materializeCount = materializeLimit > 0 ? Math.min(materializeLimit, seed.value.length) : seed.value.length;
  const materialize = await withPhase("materialize-yjs-state", async () => {
    let totalChars = 0;
    let mismatches = 0;
    for (const row of seed.value.slice(0, materializeCount)) {
      const content = markdownFromState(row.state);
      totalChars += content.length;
      if (content !== row.content) {
        mismatches++;
      }
    }
    return {
      value: null,
      stats: {
        files: materializeCount,
        totalChars,
        mismatches,
      },
    };
  });
  phases.push(materialize.result);
  allSamples[materialize.result.name] = materialize.samples;

  const ydocRetain = await withPhase("retain-live-ydocs", async () => {
    const docs: Y.Doc[] = [];
    let totalChars = 0;
    for (const row of seed.value) {
      const doc = new Y.Doc();
      Y.applyUpdateV2(doc, row.state);
      totalChars += doc.getText(MARKDOWN_FIELD).length;
      docs.push(doc);
    }
    const beforeDestroy = memorySample();
    for (const doc of docs) {
      doc.destroy();
    }
    forceGc();
    const afterDestroy = memorySample();
    return {
      value: null,
      stats: {
        docs: docs.length,
        totalChars,
        beforeDestroy,
        afterDestroy,
        retainedRssDeltaMb: round(beforeDestroy.rssMb - afterDestroy.rssMb),
        retainedHeapDeltaMb: round(beforeDestroy.heapUsedMb - afterDestroy.heapUsedMb),
      },
    };
  });
  phases.push(ydocRetain.result);
  allSamples[ydocRetain.result.name] = ydocRetain.samples;

  const nonMarkdown = await withPhase("read-nonmarkdown-inline", async () => {
    const inline = scan.value.entries.filter(entry => !entry.useYjs && entry.size <= inlineLimit);
    let totalBytes = 0;
    let largest = { path: "", bytes: 0 };
    for (const entry of inline) {
      const bytes = await readBytes(entry.absPath);
      totalBytes += bytes.byteLength;
      if (bytes.byteLength > largest.bytes) {
        largest = { path: entry.path, bytes: bytes.byteLength };
      }
    }
    return {
      value: null,
      stats: {
        files: inline.length,
        totalBytes,
        largest,
      },
    };
  });
  phases.push(nonMarkdown.result);
  allSamples[nonMarkdown.result.name] = nonMarkdown.samples;

  return {
    runId,
    phases,
    samples: allSamples,
  };
}

function aggregate(runReports: Array<Record<string, any>>): Record<string, unknown> {
  const phaseNames = [...new Set(runReports.flatMap(report => report.phases.map((phase: PhaseResult) => phase.name)))];
  const phases: Record<string, unknown> = {};
  for (const phaseName of phaseNames) {
    const phaseRuns = runReports.flatMap(report => report.phases.filter((phase: PhaseResult) => phase.name === phaseName));
    phases[phaseName] = {
      durationMs: summarize(phaseRuns.map((phase: PhaseResult) => phase.durationMs)),
      peakRssMb: summarize(phaseRuns.map((phase: PhaseResult) => phase.memoryPeak.rssMb)),
      endRssMb: summarize(phaseRuns.map((phase: PhaseResult) => phase.memoryEnd.rssMb)),
      peakHeapUsedMb: summarize(phaseRuns.map((phase: PhaseResult) => phase.memoryPeak.heapUsedMb)),
      eventLoopLagMaxMs: summarize(phaseRuns.map((phase: PhaseResult) => phase.eventLoopLagMs.max)),
    };
  }
  return { phases };
}

async function main(): Promise<void> {
  if (!existsSync(vaultPath)) {
    throw new Error(`Vault path does not exist: ${vaultPath}`);
  }
  await mkdir(reportDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const runReports = [];
  for (let runId = 1; runId <= runs; runId++) {
    runReports.push(await runOnce(runId));
  }
  const report = {
    generatedAt: startedAt,
    config: {
      vaultPath,
      runs,
      batchSize,
      maxFiles,
      inlineLimit,
      materializeLimit,
      stressRepeats,
      floodCounts,
      blobEvery,
      blobBytes,
      loBlobBytes,
      sampleIntervalMs,
      runGc,
      argv: process.argv.slice(2),
    },
    aggregate: aggregate(runReports),
    runs: runReports,
  };
  const reportPath = join(reportDir, `headless-perf-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`[headless-perf] report: ${reportPath}`);
  console.log(JSON.stringify(report.aggregate, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
