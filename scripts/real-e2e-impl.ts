#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "bun";
import { EditorState } from "@codemirror/state";
import { App, TFile, TFolder, normalizePath } from "obsidian";
import * as Y from "yjs";
import { JsonlOutboxStore } from "../plugin/src/db/db";
import { SyncClient } from "../plugin/src/sync/SyncClient";
import { YjsStateStore } from "../plugin/src/yjs/YjsStateStore";
import { DocSync } from "../plugin/src/yjs/DocSync";
import { VaultYjsIndexer } from "../plugin/src/yjs/VaultYjsIndexer";
import { docStateFromContent, MARKDOWN_FIELD } from "../shared/yjsSeed";
import { shouldSyncPath, shouldUseYjs } from "../shared/pathPolicy";

type PluginLifecycleMode = "minimal" | "mobile" | "desktop";
type BootVaultEntry = {
  isFolder: boolean;
  fingerprint: string | null;
};
type PreStartupLocalEvent = {
  path: string;
  isFolder: boolean;
  kind: "create" | "modify";
};

type ChildHandle = {
  name: string;
  pid: number;
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  stdout: string[];
  stderr: string[];
};

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const backendPort = Number(Bun.env.REAL_E2E_BACKEND_PORT ?? "3000");
const postgresPort = Number(Bun.env.REAL_E2E_POSTGRES_PORT ?? "55432");
const backendUrl = `http://127.0.0.1:${backendPort}`;
const postgresContainerName = Bun.env.REAL_E2E_POSTGRES_CONTAINER ?? `obsidian-sync-real-e2e-${process.pid}`;
const postgresImage = Bun.env.REAL_E2E_POSTGRES_IMAGE ?? "postgres:16";
const postgresDatabase = "obsidian_sync_real_e2e";
const postgresUser = "postgres";
const postgresPassword = "postgres";
const databaseUrl = `postgres://${postgresUser}:${postgresPassword}@127.0.0.1:${postgresPort}/${postgresDatabase}`;
const pluginId = "obsidian-sync-engine";
const inlineBytesLimit = 16 * 1024;
const skipTests = process.argv.includes("--skip-tests");
const withDockerIntegration = process.argv.includes("--with-docker-integration");
const keepTemp = process.argv.includes("--keep-temp");
const activeChildren = new Map<number, ChildHandle>();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tail(value: string, max = 6000): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

async function commandExists(command: string): Promise<boolean> {
  const result = Bun.spawnSync(["bash", "-lc", `command -v ${command}`], { stdout: "ignore", stderr: "ignore" });
  return result.exitCode === 0;
}

async function requireCommands(commands: string[]): Promise<void> {
  const missing: string[] = [];
  for (const command of commands) {
    if (!(await commandExists(command))) missing.push(command);
  }
  if (missing.length > 0) {
    throw new Error(`Missing required commands: ${missing.join(", ")}`);
  }
}

async function optionalCommand(command: string): Promise<boolean> {
  return commandExists(command);
}

async function runCommand(name: string, cmd: string[], cwd = repoRoot, env: Record<string, string> = {}): Promise<void> {
  console.log(`[real-e2e] ${name}: ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...Bun.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${name} failed with exit ${exitCode}\nstdout:\n${tail(stdout)}\nstderr:\n${tail(stderr)}`);
  }
}

function spawnManaged(name: string, cmd: string[], cwd = repoRoot, env: Record<string, string> = {}): ChildHandle {
  console.log(`[real-e2e] starting ${name}: ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...Bun.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const child = { name, pid: proc.pid, process: proc, stdout: [], stderr: [] };
  activeChildren.set(proc.pid, child);
  void proc.exited.finally(() => activeChildren.delete(proc.pid));
  void streamLines(proc.stdout, line => child.stdout.push(line));
  void streamLines(proc.stderr, line => child.stderr.push(line));
  return child;
}

async function streamLines(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
    }
    if (buffer.trim()) onLine(buffer);
  } catch {
    // Process teardown can close pipes while the reader is active.
  }
}

function childPids(pid: number): number[] {
  try {
    const children = Bun.file(`/proc/${pid}/task/${pid}/children`).textSync();
    return children.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function killProcessTree(pid: number, signal: NodeJS.Signals | string): void {
  for (const child of childPids(pid)) killProcessTree(child, signal);
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

async function killManaged(child: ChildHandle | null): Promise<void> {
  if (!child) return;
  console.log(`[real-e2e] stopping ${child.name} pid=${child.pid}`);
  killProcessTree(child.pid, "SIGTERM");
  const exited = await Promise.race([child.process.exited, sleep(5000).then(() => null)]);
  if (exited === null) {
    killProcessTree(child.pid, "SIGKILL");
    await Promise.race([child.process.exited, sleep(1000)]);
  }
}

async function findListeningPids(port: number): Promise<string[]> {
  if (await commandExists("lsof")) {
    const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return [...new Set(new TextDecoder().decode(result.stdout).trim().split(/\s+/).filter(Boolean))];
  }
  const result = Bun.spawnSync(["ss", "-ltnp", `sport = :${port}`], { stdout: "pipe", stderr: "ignore" });
  return [...new Set([...new TextDecoder().decode(result.stdout).matchAll(/pid=(\d+)/g)].map(match => match[1]!))];
}

async function assertPortsFree(): Promise<void> {
  const conflicts: string[] = [];
  for (const port of [backendPort, postgresPort]) {
    const pids = await findListeningPids(port);
    if (pids.length > 0) conflicts.push(`${port} (pid ${pids.join(", ")})`);
  }
  if (conflicts.length > 0) {
    throw new Error(`Refusing to run because required ports are already listening: ${conflicts.join("; ")}`);
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not ready yet.
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForOutput(child: ChildHandle, pattern: RegExp, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const exited = await Promise.race([child.process.exited, sleep(0).then(() => null)]);
    if (exited !== null) throw new Error(`${child.name} exited early\n${tail(child.stderr.join("\n"))}`);
    if (pattern.test(`${child.stdout.join("\n")}\n${child.stderr.join("\n")}`)) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${child.name} output ${pattern}`);
}

async function startDockerPostgres(): Promise<ChildHandle> {
  await runCommand("remove stale real e2e postgres container", [
    "docker",
    "rm",
    "-f",
    postgresContainerName,
  ]).catch(() => undefined);
  const child = spawnManaged("postgres docker", [
    "docker",
    "run",
    "--rm",
    "--name",
    postgresContainerName,
    "-e",
    `POSTGRES_DB=${postgresDatabase}`,
    "-e",
    `POSTGRES_USER=${postgresUser}`,
    "-e",
    `POSTGRES_PASSWORD=${postgresPassword}`,
    "-p",
    `127.0.0.1:${postgresPort}:5432`,
    postgresImage,
  ]);
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const exited = await Promise.race([child.process.exited, sleep(0).then(() => null)]);
    if (exited !== null) throw new Error(`postgres docker exited early\n${tail(child.stderr.join("\n"))}`);
    const result = Bun.spawnSync([
      "docker",
      "exec",
      postgresContainerName,
      "pg_isready",
      "-U",
      postgresUser,
      "-d",
      postgresDatabase,
    ], { stdout: "ignore", stderr: "ignore" });
    if (result.exitCode === 0) {
      await sleep(1500);
      return child;
    }
    await sleep(500);
  }
  throw new Error("Docker Postgres did not become ready in time");
}

async function runAllTests(): Promise<void> {
  if (skipTests) return;
  await runCommand("shared tests", ["bun", "test", "shared"]);
  await runCommand("plugin/client tests", ["npm", "test"], join(repoRoot, "plugin"));
  await runCommand("server unit tests", ["bun", "run", "test:unit"], join(repoRoot, "server"));
  if (withDockerIntegration) {
    await runCommand("server integration tests in docker", ["bun", "run", "test:integration:docker"], join(repoRoot, "server"));
  }
}

function pathToVaultPath(root: string, fullPath: string): string {
  return relative(root, fullPath).split(sep).join("/");
}

function makeFile(path: string): TFile {
  const file = new TFile();
  (file as TFile & { path: string; name: string; extension: string }).path = path;
  (file as TFile & { path: string; name: string; extension: string }).name = path.split("/").pop() ?? path;
  (file as TFile & { path: string; name: string; extension: string }).extension = path.split(".").pop() ?? "";
  return file;
}

function makeFolder(path: string): TFolder {
  const folder = new TFolder();
  (folder as TFolder & { path: string; name: string }).path = path;
  (folder as TFolder & { path: string; name: string }).name = path.split("/").pop() ?? path;
  return folder;
}

class FsAdapter {
  constructor(private readonly root: string) {}

  full(path: string): string {
    return join(this.root, normalizePath(path));
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(this.full(path));
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(this.full(path), { recursive: true });
  }

  async write(path: string, content: string): Promise<void> {
    await mkdir(dirname(this.full(path)), { recursive: true });
    await writeFile(this.full(path), content);
  }

  async append(path: string, content: string): Promise<void> {
    await mkdir(dirname(this.full(path)), { recursive: true });
    await Bun.write(this.full(path), (existsSync(this.full(path)) ? await readFile(this.full(path), "utf8") : "") + content);
  }

  async read(path: string): Promise<string> {
    return readFile(this.full(path), "utf8");
  }

  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    await mkdir(dirname(this.full(path)), { recursive: true });
    await writeFile(this.full(path), new Uint8Array(content));
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = await readFile(this.full(path));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }

  async remove(path: string): Promise<void> {
    await rm(this.full(path), { force: true });
  }

  async rmdir(path: string, recursive = false): Promise<void> {
    await rm(this.full(path), { recursive, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    await mkdir(dirname(this.full(to)), { recursive: true });
    await rm(this.full(to), { recursive: true, force: true });
    await Bun.$`mv ${this.full(from)} ${this.full(to)}`.quiet();
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const dir = this.full(path);
    if (!existsSync(dir)) return { files: [], folders: [] };
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    const folders: string[] = [];
    for (const entry of entries) {
      const vaultPath = normalizePath(path ? `${path}/${entry.name}` : entry.name);
      if (entry.isDirectory()) folders.push(vaultPath);
      if (entry.isFile()) files.push(vaultPath);
    }
    return { files: files.sort(), folders: folders.sort() };
  }

  async stat(path: string): Promise<{ type: "file" | "folder"; mtime: number; size: number } | null> {
    try {
      const info = await stat(this.full(path));
      return { type: info.isDirectory() ? "folder" : "file", mtime: info.mtimeMs, size: info.size };
    } catch {
      return null;
    }
  }
}

class RealClient {
  readonly adapter: FsAdapter;
  readonly app: App;
  readonly outbox: JsonlOutboxStore;
  readonly stateStore: YjsStateStore;
  readonly syncClient: SyncClient;
  readonly indexer: VaultYjsIndexer;
  readonly docs = new Map<string, DocSync>();
  readonly bootstrapStatuses: Array<{ status: string; downloadUrl?: string; expiresAt?: number }> = [];
  lastPulledRevision = "0";
  clientKey = "To Be Generated";
  private indexerStarted = false;
  private startupSyncCompleted = false;
  private bootVaultEntries = new Map<string, BootVaultEntry>();
  private preStartupLocalEvents = new Map<string, PreStartupLocalEvent>();

  constructor(
    readonly root: string,
    readonly clientId: string,
    readonly clientName: string,
    private readonly lifecycle: PluginLifecycleMode = "minimal",
  ) {
    this.adapter = new FsAdapter(root);
    const vault = {
      configDir: ".obsidian",
      adapter: this.adapter,
      getName: () => this.clientName,
      getAllLoadedFiles: () => this.getAllLoadedFiles(),
      getFiles: () => this.getAllLoadedFiles().filter((entry): entry is TFile => entry instanceof TFile),
      getMarkdownFiles: () => this.getAllLoadedFiles()
        .filter((entry): entry is TFile => entry instanceof TFile && entry.extension === "md"),
      getAbstractFileByPath: (path: string) => this.abstractFile(path),
      read: async (file: TFile) => this.adapter.read(file.path),
      modify: async (file: TFile, content: string) => this.adapter.write(file.path, content),
      create: async (path: string, content: string) => {
        await this.adapter.write(path, content);
        return makeFile(path);
      },
      createFolder: async (path: string) => {
        await this.adapter.mkdir(path);
        return makeFolder(path);
      },
      rename: async (file: TFile | TFolder, path: string) => {
        await this.adapter.rename(file.path, path);
        (file as TFile & { path: string }).path = path;
      },
    };
    this.app = {
      vault,
      fileManager: {
        trashFile: async (file: TFile | TFolder) => {
          const info = await this.adapter.stat(file.path);
          if (info?.type === "folder") await this.adapter.rmdir(file.path, true);
          else await this.adapter.remove(file.path);
        },
      },
    } as unknown as App;
    const manifest = { id: pluginId } as const;
    this.outbox = new JsonlOutboxStore(this.app, manifest);
    this.stateStore = new YjsStateStore(this.app, manifest);
    this.indexer = new VaultYjsIndexer(
      this.app,
      this.stateStore,
      path => !shouldUseYjs(path, ".obsidian"),
      async change => {
        await this.outbox.putInOutbox({
          mutationId: crypto.randomUUID(),
          operation: "UpsertFile",
          path: change.path,
          content: change.content,
          yjsState: change.yjsState,
          isFolder: false,
          isYjs: true,
          storageKind: "text",
          created: Date.now(),
        });
        this.syncClient.wakeSoon();
      },
    );
    this.syncClient = new SyncClient(
      this.app,
      this.outbox,
      this.stateStore,
      {
        backendUrl,
        clientId,
        clientKey: this.clientKey,
        clientName,
        lastPulledRevision: this.lastPulledRevision,
      },
      async key => {
        this.clientKey = key;
        await this.persistPluginData();
      },
      async revision => {
        this.lastPulledRevision = revision;
        await this.persistPluginData();
      },
      path => this.docs.get(path),
      status => {
        this.bootstrapStatuses.push(status);
      },
      () => {
        this.startupSyncCompleted = true;
        void this.flushDeferredPreStartupLocalEvents();
        if (this.lifecycle === "desktop" && !this.indexerStarted) {
          this.indexerStarted = true;
          this.indexer.start();
        }
      },
      undefined,
      undefined,
      async (path, content) => {
        await this.adapter.write(path, content);
        return true;
      },
      async () => {},
    );
  }

  async open(): Promise<void> {
    await this.adapter.mkdir(".obsidian/plugins/obsidian-sync-engine");
    await this.stateStore.open();
    await this.outbox.open();
    await this.loadPluginData();
    await this.captureBootVaultEntries();
  }

  start(): void {
    this.syncClient.start();
  }

  async stop(): Promise<void> {
    this.syncClient.stop();
    for (const doc of this.docs.values()) doc.destroy();
    this.docs.clear();
    await this.outbox.close();
  }

  async waitReady(timeoutMs = 30000): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if ((this.syncClient as unknown as { startupSynced: boolean }).startupSynced) return;
      await sleep(100);
    }
    throw new Error(`${this.clientName} did not finish startup sync`);
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.adapter.write(path, content);
  }

  async indexVault(): Promise<void> {
    this.indexer.start();
    await this.indexer.waitForInitialScan();
  }

  async indexMarkdownFile(path: string): Promise<void> {
    await this.indexer.ensureFile(makeFile(path));
  }

  async openEditor(path: string): Promise<void> {
    await this.getOrCreateDoc(path, existsSync(this.adapter.full(path)) ? await this.readText(path) : "");
  }

  async readText(path: string): Promise<string> {
    return this.adapter.read(path);
  }

  async appendMarkdown(path: string, text: string): Promise<void> {
    const before = existsSync(this.adapter.full(path)) ? await this.readText(path) : "";
    const doc = await this.getOrCreateDoc(path, before);
    const update = EditorState.create({ doc: before }).update({
      changes: { from: before.length, insert: text },
    });
    await doc.applyChanges(update.changes, {
      mutationId: crypto.randomUUID(),
      operation: "YjsUpdate",
      path,
      data: new Uint8Array(),
      created: Date.now(),
    }, undefined, before, before + text);
    await this.adapter.write(path, before + text);
    this.syncClient.wakeSoon();
  }

  async createBootstrapDownload(): Promise<Uint8Array> {
    await this.syncClient.generateBootstrapLink("Bootstrapped Vault", ".obsidian", pluginId);
    const started = Date.now();
    while (Date.now() - started < 30000) {
      const ready = [...this.bootstrapStatuses].reverse().find(status => status.status === "ready" && status.downloadUrl);
      if (ready?.downloadUrl) {
        const url = new URL(ready.downloadUrl);
        url.searchParams.set("download", "1");
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`bootstrap download failed: ${response.status} ${await response.text()}`);
        }
        return new Uint8Array(await response.arrayBuffer());
      }
      await sleep(100);
    }
    throw new Error("timed out waiting for bootstrap link");
  }

  async putBinary(path: string, bytes: Uint8Array): Promise<void> {
    await this.adapter.writeBinary(path, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const upload = await this.syncClient.uploadBlob(path, bytes);
    await this.outbox.putInOutbox({
      mutationId: crypto.randomUUID(),
      operation: "UpsertFile",
      path,
      storageKind: "lo",
      isFolder: false,
      isYjs: false,
      blobUploadId: upload.blobUploadId,
      byteSize: upload.byteSize,
      contentSha256: upload.contentSha256,
      created: Date.now(),
    });
    this.syncClient.wakeSoon();
  }

  async hasPendingOutbox(): Promise<boolean> {
    return this.outbox.hasPendingChanges();
  }

  private shouldSyncLocalPath(path: string): boolean {
    return shouldSyncPath(path, ".obsidian", pluginId);
  }

  /** Mirrors `main.ts` `enqueueLocalCreate` for vault `create` events on bootstrap open. */
  async enqueueLocalCreate(file: TFile | TFolder): Promise<void> {
    if (
      this.syncClient.isApplyingRemoteChanges(file.path) ||
      !this.shouldSyncLocalPath(file.path)
    ) {
      return;
    }
    if (this.deferPreStartupLocalEvent(file.path, file instanceof TFolder, "create")) {
      return;
    }
    if (file instanceof TFolder) {
      await this.outbox.putInOutbox({
        mutationId: crypto.randomUUID(),
        operation: "CreateFolder",
        path: file.path,
        isFolder: true,
        created: Date.now(),
      });
      this.syncClient.wakeSoon();
      return;
    }
    if (shouldUseYjs(file.path, ".obsidian")) {
      const content = await this.adapter.read(file.path);
      const yjsState = docStateFromContent(content, Y);
      await this.stateStore.putWithContentHash(
        file.path,
        yjsState,
        await sha256Hex(new TextEncoder().encode(content)),
      );
      await this.outbox.putInOutbox({
        mutationId: crypto.randomUUID(),
        operation: "UpsertFile",
        path: file.path,
        content,
        yjsState,
        isFolder: false,
        isYjs: true,
        storageKind: "text",
        created: Date.now(),
      });
      this.syncClient.wakeSoon();
      return;
    }
    const bytes = new Uint8Array(await this.adapter.readBinary(file.path));
    if (bytes.byteLength > inlineBytesLimit) {
      const upload = await this.syncClient.uploadBlob(file.path, bytes);
      await this.outbox.putInOutbox({
        mutationId: crypto.randomUUID(),
        operation: "UpsertFile",
        path: file.path,
        storageKind: "lo",
        isFolder: false,
        isYjs: false,
        blobUploadId: upload.blobUploadId,
        byteSize: upload.byteSize,
        contentSha256: upload.contentSha256,
        created: Date.now(),
      });
    } else {
      await this.outbox.putInOutbox({
        mutationId: crypto.randomUUID(),
        operation: "UpsertFile",
        path: file.path,
        contentBytes: bytes,
        storageKind: "bytea",
        isFolder: false,
        isYjs: false,
        byteSize: bytes.byteLength,
        created: Date.now(),
      });
    }
    this.syncClient.wakeSoon();
  }

  private deferPreStartupLocalEvent(path: string, isFolder: boolean, kind: PreStartupLocalEvent["kind"]): boolean {
    if (this.startupSyncCompleted || !this.hasServerBaseline()) {
      return false;
    }
    this.preStartupLocalEvents.set(path, { path, isFolder, kind });
    return true;
  }

  private hasServerBaseline(): boolean {
    try {
      return BigInt(this.lastPulledRevision || "0") > BigInt(0);
    } catch {
      return false;
    }
  }

  private async flushDeferredPreStartupLocalEvents(): Promise<void> {
    const events = [...this.preStartupLocalEvents.values()]
      .sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.path.localeCompare(b.path);
      });
    this.preStartupLocalEvents.clear();
    for (const event of events) {
      if (!(await this.shouldReplayDeferredPreStartupEvent(event))) {
        continue;
      }
      await this.enqueueLocalCreate(event.isFolder ? makeFolder(event.path) : makeFile(event.path));
    }
  }

  private async shouldReplayDeferredPreStartupEvent(event: PreStartupLocalEvent): Promise<boolean> {
    if (!this.shouldSyncLocalPath(event.path)) {
      return false;
    }
    const stat = await this.adapter.stat(event.path);
    if (!stat) {
      return false;
    }
    const current: BootVaultEntry = {
      isFolder: stat.type === "folder",
      fingerprint: stat.type === "file" ? `${stat.mtime}:${stat.size}` : null,
    };
    const boot = this.bootVaultEntries.get(event.path);
    if (!boot) {
      return true;
    }
    return boot.isFolder !== current.isFolder || boot.fingerprint !== current.fingerprint;
  }

  private async captureBootVaultEntries(): Promise<void> {
    this.bootVaultEntries.clear();
    await this.addBootVaultEntries("");
    await this.addBootVaultEntries(".obsidian");
  }

  private async addBootVaultEntries(dir: string): Promise<void> {
    if (dir && !(await this.adapter.exists(dir))) {
      return;
    }
    const listed = await this.adapter.list(dir);
    for (const folder of listed.folders) {
      if (!this.shouldSyncLocalPath(folder)) {
        continue;
      }
      this.bootVaultEntries.set(folder, { isFolder: true, fingerprint: null });
      await this.addBootVaultEntries(folder);
    }
    for (const file of listed.files) {
      if (!this.shouldSyncLocalPath(file)) {
        continue;
      }
      const stat = await this.adapter.stat(file);
      if (stat?.type === "file") {
        this.bootVaultEntries.set(file, { isFolder: false, fingerprint: `${stat.mtime}:${stat.size}` });
      }
    }
  }

  /**
   * Obsidian fires `vault.on("create")` for files/folders as a bootstrapped vault is discovered.
   * Mobile does not run the Yjs indexer on startup; this path is the main upload source there.
   */
  async simulateObsidianVaultDiscovery(): Promise<{ folders: number; files: number }> {
    const folders: TFolder[] = [];
    const files: TFile[] = [];
    for (const entry of this.getAllLoadedFiles()) {
      if (entry instanceof TFolder && this.shouldSyncLocalPath(entry.path)) {
        folders.push(entry);
      } else if (entry instanceof TFile && this.shouldSyncLocalPath(entry.path)) {
        files.push(entry);
      }
    }
    folders.sort((a, b) => a.path.localeCompare(b.path));
    files.sort((a, b) => a.path.localeCompare(b.path));
    for (const folder of folders) {
      await this.enqueueLocalCreate(folder);
    }
    for (const file of files) {
      await this.enqueueLocalCreate(file);
    }
    return { folders: folders.length, files: files.length };
  }

  /** Mirrors plugin settings load: bootstrap zips ship their own client identity. */
  async readPluginData(): Promise<{
    clientId: string;
    clientKey: string;
    clientName: string;
    lastPulledRevision: string;
  }> {
    const path = ".obsidian/plugins/obsidian-sync-engine/data.json";
    if (await this.adapter.exists(path)) {
      try {
        const parsed = JSON.parse(await this.adapter.read(path)) as Partial<{
          clientId: string;
          clientKey: string;
          clientName: string;
          lastPulledRevision: string;
        }>;
        return {
          clientId: typeof parsed.clientId === "string" ? parsed.clientId : this.clientId,
          clientKey: typeof parsed.clientKey === "string" ? parsed.clientKey : this.clientKey,
          clientName: typeof parsed.clientName === "string" ? parsed.clientName : this.clientName,
          lastPulledRevision: typeof parsed.lastPulledRevision === "string" ? parsed.lastPulledRevision : this.lastPulledRevision,
        };
      } catch {
        // Fall through to in-memory values.
      }
    }
    return {
      clientId: this.clientId,
      clientKey: this.clientKey,
      clientName: this.clientName,
      lastPulledRevision: this.lastPulledRevision,
    };
  }

  private async getOrCreateDoc(path: string, content: string): Promise<DocSync> {
    const existing = this.docs.get(path);
    if (existing) return existing;
    const hash = await sha256Hex(new TextEncoder().encode(content));
    const cachedHash = await this.stateStore.getContentHash(path);
    let state = await this.stateStore.get(path);
    if (!state || cachedHash !== hash) {
      state = docStateFromContent(content, Y);
      await this.stateStore.putWithContentHash(path, state, hash);
    }
    const metadata = await this.stateStore.getMetadata(path);
    const doc = new DocSync(this.outbox, this.stateStore, path, state, metadata?.serverSynced === true);
    this.docs.set(path, doc);
    return doc;
  }

  private async loadPluginData(): Promise<void> {
    const path = ".obsidian/plugins/obsidian-sync-engine/data.json";
    if (!(await this.adapter.exists(path))) {
      return;
    }
    try {
      const parsed = JSON.parse(await this.adapter.read(path)) as Partial<{
        clientId: string;
        clientKey: string;
        clientName: string;
        lastPulledRevision: string;
      }>;
      if (typeof parsed.clientId === "string") {
        this.clientId = parsed.clientId;
        (this.syncClient as unknown as { clientId: string }).clientId = parsed.clientId;
      }
      if (typeof parsed.clientName === "string") {
        this.clientName = parsed.clientName;
        (this.syncClient as unknown as { clientName: string }).clientName = parsed.clientName;
      }
      if (typeof parsed.clientKey === "string") {
        this.clientKey = parsed.clientKey;
        (this.syncClient as unknown as { clientKey: string }).clientKey = parsed.clientKey;
        (this.syncClient as unknown as { blobClient: { update: (backendUrl: string, clientKey: string) => void } })
          .blobClient.update(backendUrl, parsed.clientKey);
        (this.syncClient as unknown as { bootstrapUploader: { updateClientKey: (clientKey: string) => void } })
          .bootstrapUploader.updateClientKey(parsed.clientKey);
      }
      if (typeof parsed.lastPulledRevision === "string") {
        this.lastPulledRevision = parsed.lastPulledRevision;
        (this.syncClient as unknown as { lastPulledRevision: string; lastUploadedRevisionHint: string }).lastPulledRevision = parsed.lastPulledRevision;
        (this.syncClient as unknown as { lastUploadedRevisionHint: string }).lastUploadedRevisionHint = parsed.lastPulledRevision;
      }
    } catch {
      // Invalid plugin data should not hide sync behavior under test.
    }
  }

  private async persistPluginData(): Promise<void> {
    await this.adapter.write(".obsidian/plugins/obsidian-sync-engine/data.json", JSON.stringify({
      backendUrl,
      clientId: this.clientId,
      clientKey: this.clientKey,
      clientName: this.clientName,
      lastPulledRevision: this.lastPulledRevision,
    }, null, 2));
  }

  private abstractFile(path: string): TFile | TFolder | null {
    const info = existsSync(this.adapter.full(path)) ? Bun.file(this.adapter.full(path)) : null;
    if (!info) return null;
    const statResult = statSyncSafe(this.adapter.full(path));
    if (!statResult) return null;
    return statResult.isDirectory() ? makeFolder(path) : makeFile(path);
  }

  private getAllLoadedFiles(): Array<TFile | TFolder> {
    const entries: Array<TFile | TFolder> = [];
    const walk = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSyncSafe(dir)) {
        const full = join(dir, entry);
        const info = statSyncSafe(full);
        if (!info) continue;
        const vaultPath = normalizePath(pathToVaultPath(this.root, full));
        if (info.isDirectory()) {
          entries.push(makeFolder(vaultPath));
          walk(full);
        } else {
          entries.push(makeFile(vaultPath));
        }
      }
    };
    walk(this.root);
    return entries;
  }
}

function readdirSyncSafe(path: string): string[] {
  try {
    return require("node:fs").readdirSync(path);
  } catch {
    return [];
  }
}

function statSyncSafe(path: string): import("node:fs").Stats | null {
  try {
    return require("node:fs").statSync(path);
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function waitFor(predicate: () => Promise<boolean>, message: string, timeoutMs = 30000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await sleep(100);
  }
  throw new Error(message);
}

async function serverText(path: string): Promise<string | null> {
  const rows = await sql<{ content: string | null }[]>`SELECT content FROM files WHERE path = ${path} AND deleted = FALSE;`;
  return rows[0]?.content ?? null;
}

async function serverStorageKind(path: string): Promise<string | null> {
  const rows = await sql<{ storageKind: string }[]>`SELECT storage_kind AS "storageKind" FROM files WHERE path = ${path} AND deleted = FALSE;`;
  return rows[0]?.storageKind ?? null;
}

async function countEvents(path: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`SELECT COUNT(*)::TEXT AS count FROM sync_events WHERE path = ${path};`;
  return Number.parseInt(rows[0]?.count ?? "0", 10);
}

async function countEventsForClient(clientId: string): Promise<number> {
  const rows = await sql<{ count: string }[]>`SELECT COUNT(*)::TEXT AS count FROM sync_events WHERE client_id = ${clientId};`;
  return Number.parseInt(rows[0]?.count ?? "0", 10);
}

async function getServerRevision(): Promise<string> {
  const rows = await sql<{ revision: string }[]>`
    SELECT GREATEST(
      COALESCE((SELECT MAX(revision) FROM sync_events), 0),
      COALESCE((SELECT MAX(revision) FROM files), 0)
    )::TEXT AS revision;
  `;
  return rows[0]?.revision ?? "0";
}

async function resetServerSyncState(): Promise<void> {
  await sql`TRUNCATE TABLE sync_events, files, bootstrap_blobs, clients, client_keys RESTART IDENTITY CASCADE;`;
  await sql`UPDATE server_meta SET compacted_revision = 0 WHERE id = 1;`;
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

async function extractStoredZipToVault(bytes: Uint8Array, targetRoot: string): Promise<void> {
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < bytes.byteLength && readUint32(bytes, offset) === 0x04034b50) {
    const compressedSize = readUint32(bytes, offset + 18);
    const nameLength = readUint16(bytes, offset + 26);
    const extraLength = readUint16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const rawName = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    const relativeName = rawName.split("/").slice(1).join("/");
    if (relativeName) {
      const target = join(targetRoot, ...relativeName.split("/"));
      if (rawName.endsWith("/")) {
        await mkdir(target, { recursive: true });
      } else {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes.slice(dataStart, dataStart + compressedSize));
      }
    }
    offset = dataStart + compressedSize;
  }
}

async function seedVaultTree(client: RealClient, folderCount: number, filesPerFolder: number): Promise<void> {
  for (let index = 0; index < folderCount; index++) {
    const folder = `CMCU/seed-${index}`;
    await client.adapter.mkdir(folder);
    for (let fileIndex = 0; fileIndex < filesPerFolder; fileIndex++) {
      await client.writeText(`${folder}/note-${fileIndex}.md`, `seed ${index}-${fileIndex}`);
    }
  }
  await client.putBinary("CMCU/assets/logo.bin", new Uint8Array([1, 2, 3, 4]));
  await client.indexVault();
  await waitFor(async () => !(await client.hasPendingOutbox()), "seed vault did not finish uploading");
}

async function assertStableText(client: RealClient, path: string, expected: string, label: string): Promise<void> {
  await waitFor(async () => await client.readText(path).catch(() => "") === expected, `${label} did not reach ${expected}`);
  await sleep(750);
  const actual = await client.readText(path);
  if (actual !== expected) {
    throw new Error(`${label} changed after settling: expected ${expected}, got ${actual}`);
  }
}

async function runBootstrapReadOnlyOpenScenario(root: string): Promise<void> {
  const folderCount = 20;
  const filesPerFolder = 10;
  const clientA = new RealClient(join(root, "vault-bootstrap-a"), "real-e2e-bootstrap-a", "Bootstrap A");
  const clientBRoot = join(root, "vault-bootstrap-b");
  const note = "CMCU/seed-0/note-0.md";
  try {
    await clientA.open();
    await seedVaultTree(clientA, folderCount, filesPerFolder);
    clientA.start();
    await clientA.waitReady();
    await waitFor(async () => await serverText(note) === "seed 0-0", "server did not receive seeded vault");

    const serverRevisionAtLink = await getServerRevision();
    const bootstrapZip = await clientA.createBootstrapDownload();

    await extractStoredZipToVault(bootstrapZip, clientBRoot);
    const pluginDataFromZip = await (async () => {
      const dataPath = join(clientBRoot, ".obsidian/plugins/obsidian-sync-engine/data.json");
      return JSON.parse(await readFile(dataPath, "utf8")) as {
        clientId: string;
        lastPulledRevision: string;
      };
    })();

    if (pluginDataFromZip.lastPulledRevision !== serverRevisionAtLink) {
      throw new Error(
        `bootstrap zip revision mismatch: zip has ${pluginDataFromZip.lastPulledRevision}, server was ${serverRevisionAtLink}`,
      );
    }

    const clientB = new RealClient(clientBRoot, "placeholder-until-load", "Bootstrap B", "mobile");
    await clientB.open();
    const revisionBeforeSync = clientB.lastPulledRevision;
    const discovery = await clientB.simulateObsidianVaultDiscovery();
    console.log(
      `[real-e2e] simulated mobile vault discovery: ${discovery.folders} folders, ${discovery.files} files, pendingOutbox=${await clientB.hasPendingOutbox()}`,
    );
    if (revisionBeforeSync !== pluginDataFromZip.lastPulledRevision) {
      throw new Error(
        `harness failed to load bootstrap revision: expected ${pluginDataFromZip.lastPulledRevision}, got ${revisionBeforeSync}`,
      );
    }
    if (clientB.clientId !== pluginDataFromZip.clientId) {
      throw new Error(
        `harness failed to load bootstrap client id: expected ${pluginDataFromZip.clientId}, got ${clientB.clientId}`,
      );
    }

    const eventsBefore = await countEventsForClient(clientB.clientId);
    clientB.start();
    await clientB.waitReady();

    if (clientB.lastPulledRevision !== revisionBeforeSync) {
      throw new Error(
        `read-only bootstrap open advanced lastPulledRevision: ${revisionBeforeSync} -> ${clientB.lastPulledRevision}`,
      );
    }
    if (await clientB.hasPendingOutbox()) {
      throw new Error("read-only bootstrap open queued local outbox mutations");
    }
    const eventsAfter = await countEventsForClient(clientB.clientId);
    if (eventsAfter !== eventsBefore) {
      throw new Error(
        `read-only bootstrap open created server events: before=${eventsBefore}, after=${eventsAfter}`,
      );
    }
    if (await clientB.readText(note) !== "seed 0-0") {
      throw new Error("bootstrap vault content does not match server snapshot");
    }

    await clientB.stop();
  } finally {
    await clientA.stop().catch(() => undefined);
  }
}

async function runRealScenario(root: string): Promise<void> {
  const clientA = new RealClient(join(root, "vault-a"), "real-e2e-a", "Real A");
  const clientB = new RealClient(join(root, "vault-b"), "real-e2e-b", "Real B");
  const clientC = new RealClient(join(root, "vault-c"), "real-e2e-c", "Real C");
  const note = "notes/shared.md";
  const replayNote = "how about folder/new file pog.md";
  const blob = "assets/big.bin";
  try {
    await clientA.open();
    await clientA.writeText(replayNote, "");
    clientA.start();
    await clientA.waitReady();
    await waitFor(async () => await serverText(replayNote) === "", "server did not receive initial empty replay file");

    await clientA.appendMarkdown(replayNote, "a");
    await waitFor(async () => await serverText(replayNote) === "a", "client A did not upload initial replay text");
    const bootstrapZip = await clientA.createBootstrapDownload();

    await clientA.appendMarkdown(replayNote, "bcd");
    await waitFor(async () => await serverText(replayNote) === "abcd", "client A post-bootstrap edit did not upload");

    await extractStoredZipToVault(bootstrapZip, clientB.root);
    await clientB.open();
    await clientB.openEditor(replayNote);
    clientB.start();
    await clientB.waitReady();
    await assertStableText(clientB, replayNote, "abcd", "client B bootstrap catch-up replay");
    await assertStableText(clientA, replayNote, "abcd", "client A after client B bootstrap catch-up");

    await clientB.stop();
    await clientA.appendMarkdown(replayNote, "efg");
    await waitFor(async () => await serverText(replayNote) === "abcdefg", "client A post-client-close edit did not upload");

    const reopenedB = new RealClient(clientB.root, "real-e2e-b", "Real B Reopened");
    await reopenedB.open();
    await reopenedB.openEditor(replayNote);
    reopenedB.start();
    await reopenedB.waitReady();
    await assertStableText(reopenedB, replayNote, "abcdefg", "client B reopen replay");
    await assertStableText(clientA, replayNote, "abcdefg", "client A after client B reopen replay");
    await reopenedB.stop();

    await clientA.writeText(note, "seed");
    await clientA.indexMarkdownFile(note);
    await waitFor(async () => await serverText(note) === "seed", "server did not receive indexed seed note");

    await rm(clientB.root, { recursive: true, force: true });
    clientB.lastPulledRevision = "0";
    (clientB.syncClient as unknown as { lastPulledRevision: string; lastUploadedRevisionHint: string }).lastPulledRevision = "0";
    (clientB.syncClient as unknown as { lastUploadedRevisionHint: string }).lastUploadedRevisionHint = "0";
    await clientB.open();
    (clientB.syncClient as unknown as { clientKey: string }).clientKey = clientA.clientKey;
    clientB.clientKey = clientA.clientKey;
    clientB.start();
    await clientB.waitReady();
    await clientB.indexVault();
    await waitFor(async () => await clientB.readText(note).catch(() => "") === "seed", "client B did not pull seed");

    await clientA.appendMarkdown(note, " from-a");
    await waitFor(async () => (await clientB.readText(note)).includes("from-a"), "client B did not receive A edit");
    if (await clientB.hasPendingOutbox()) {
      throw new Error("client B queued outbox rows while applying remote open-editor content");
    }

    const indexedNote = "how about folder/new file pog.md";
    await clientB.writeText(indexedNote, "created by indexer");
    await clientB.indexMarkdownFile(indexedNote);
    await waitFor(async () => await serverText(indexedNote) === "created by indexer", "indexed markdown file did not upload");
    await clientB.appendMarkdown(indexedNote, " plus fake editor");
    await waitFor(
      async () => (await serverText(indexedNote)) === "created by indexer plus fake editor",
      "indexed markdown fake editor edit did not upload without unresolved dependencies",
    );
    if (await countEvents(indexedNote) < 2) {
      throw new Error("indexed markdown scenario did not exercise both UpsertFile and YjsUpdate");
    }

    await clientC.open();
    (clientC.syncClient as unknown as { clientKey: string }).clientKey = clientA.clientKey;
    clientC.clientKey = clientA.clientKey;
    await clientC.writeText(note, await clientA.readText(note));
    await clientC.stateStore.putWithContentHash(note, docStateFromContent(await clientC.readText(note), Y), await sha256Hex(new TextEncoder().encode(await clientC.readText(note))));
    clientC.start();
    await clientC.waitReady();
    await clientC.appendMarkdown(note, " restart-pending");
    clientC.syncClient.stop();
    for (const doc of clientC.docs.values()) doc.destroy();
    clientC.docs.clear();
    await clientC.outbox.close();

    const restartedC = new RealClient(clientC.root, clientC.clientId, clientC.clientName);
    restartedC.clientKey = clientC.clientKey;
    restartedC.lastPulledRevision = clientC.lastPulledRevision;
    await restartedC.open();
    (restartedC.syncClient as unknown as { clientKey: string; lastPulledRevision: string }).clientKey = clientC.clientKey;
    (restartedC.syncClient as unknown as { lastPulledRevision: string }).lastPulledRevision = clientC.lastPulledRevision;
    restartedC.start();
    await restartedC.waitReady();
    await waitFor(async () => (await clientA.readText(note)).includes("restart-pending"), "pending restart edit did not converge to A");
    await restartedC.stop();

    const bytes = new Uint8Array(96 * 1024);
    crypto.getRandomValues(bytes);
    await clientA.putBinary(blob, bytes);
    await waitFor(async () => await serverStorageKind(blob) === "lo", "large blob did not materialize on server");

    const finalServer = await serverText(note);
    for (const client of [clientA, clientB]) {
      await waitFor(async () => await client.readText(note) === finalServer, `${client.clientName} content does not match server`);
    }
    if (!finalServer?.includes("from-a") || !finalServer.includes("restart-pending")) {
      throw new Error(`server content missing expected edits: ${finalServer}`);
    }
  } finally {
    await clientC.stop().catch(() => undefined);
    await clientB.stop().catch(() => undefined);
    await clientA.stop().catch(() => undefined);
  }
}

async function cleanup(): Promise<void> {
  for (const child of [...activeChildren.values()].reverse()) {
    await killManaged(child).catch(() => undefined);
  }
  await rm(join(repoRoot, "db_data"), { recursive: true, force: true }).catch(() => undefined);
  await runCommand("remove real e2e postgres container", ["docker", "rm", "-f", postgresContainerName]).catch(() => undefined);
}

async function main(): Promise<void> {
  (globalThis as typeof globalThis & { window: typeof globalThis }).window = globalThis;
  process.env.DATABASE_URL = databaseUrl;
  process.env.POSTGRES_URL = databaseUrl;
  process.on("SIGINT", () => void cleanup().finally(() => process.exit(130)));
  process.on("SIGTERM", () => void cleanup().finally(() => process.exit(143)));

  await requireCommands(["bun", "npm", "bash", "docker"]);
  await assertPortsFree();
  await runAllTests();

  const tempRoot = await mkdtemp(join(tmpdir(), "obsidian-sync-real-e2e-"));
  let db: ChildHandle | null = null;
  let server: ChildHandle | null = null;
  try {
    db = await startDockerPostgres();
    server = spawnManaged("server", ["bun", "run", "src/index.ts"], join(repoRoot, "server"), {
      DATABASE_URL: databaseUrl,
      POSTGRES_URL: databaseUrl,
      PORT: String(backendPort),
      SYNC_LOG_LEVEL: "warn",
    });
    await waitForHttp(`${backendUrl}/health`, 60000);
    await runBootstrapReadOnlyOpenScenario(tempRoot);
    await resetServerSyncState();
    await runRealScenario(tempRoot);
    console.log(`[real-e2e] passed. temp root: ${tempRoot}`);
  } catch (error) {
    console.error("[real-e2e] failed");
    if (db) console.error(`[real-e2e] postgres stderr:\n${tail(db.stderr.join("\n"))}`);
    if (server) console.error(`[real-e2e] server stderr:\n${tail(server.stderr.join("\n"))}`);
    throw error;
  } finally {
    await killManaged(server);
    await killManaged(db);
    await runCommand("remove real e2e postgres container", ["docker", "rm", "-f", postgresContainerName]).catch(() => undefined);
    if (!keepTemp) await rm(tempRoot, { recursive: true, force: true });
    await rm(join(repoRoot, "db_data"), { recursive: true, force: true }).catch(() => undefined);
  }
}

await main();
