#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type ChildHandle = {
  name: string;
  pid: number;
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  stdout: string[];
  stderr: string[];
};

const activeChildren = new Map<string, ChildHandle>();
const activeRestores = new Set<() => Promise<void>>();
let signalCleanupStarted = false;

type Sample = {
  atMs: number;
  rssMb: number;
  heapMb?: number;
  latencyMs?: number;
};

type Summary = {
  avg: number;
  p95: number;
  p99: number;
  peak: number;
};

type CommandResult = {
  name: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
};

const repoRoot = "/home/shlok/Documents/Programming/sandbox/obsidian-sync-engine";
const vaultPath = "/home/shlok/Documents/Programming/sandbox/convex-sync";
const vaultName = "convex-sync";
const pluginId = "obsidian-sync-engine";
const vaultPluginDir = join(vaultPath, ".obsidian/plugins", pluginId);
const dataJsonPath = join(vaultPluginDir, "data.json");
const statePath = join(vaultPath, ".sync-engine-state");
const dbDataPath = join(repoRoot, "db_data");
const reportDir = join(repoRoot, "mega-test-results");
const backendPort = Number(Bun.env.MEGA_BACKEND_PORT ?? "3000");
const postgresPort = Number(Bun.env.MEGA_POSTGRES_PORT ?? "5432");
const cdpPort = Number(Bun.env.MEGA_CDP_PORT ?? "9222");
const iterations = Number(Bun.env.MEGA_RUNS ?? "3");
const sampleIntervalMs = Number(Bun.env.MEGA_SAMPLE_INTERVAL_MS ?? "500");
const startupTimeoutMs = Number(Bun.env.MEGA_STARTUP_TIMEOUT_MS ?? "600000");
const postAppendSettleMs = Number(Bun.env.MEGA_POST_APPEND_SETTLE_MS ?? "8000");
const injectedSleepMs = Number(Bun.env.MEGA_TEST_SLEEP_MS ?? "0");
const appendPath = Bun.env.MEGA_APPEND_PATH ?? "Mega Harness Scratch.md";
const selfTest = process.argv.includes("--self-test");
const skipObsidian = process.argv.includes("--skip-obsidian");
const skipDocker = process.argv.includes("--skip-docker");
const skipTests = process.argv.includes("--skip-tests");
const noBuildPlugin = process.argv.includes("--no-build-plugin");

function now(): number {
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mb(bytes: number): number {
  return bytes / 1024 / 1024;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function tail(value: string, max = 5000): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function summarize(values: number[]): Summary {
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

async function commandExists(command: string): Promise<boolean> {
  const result = Bun.spawnSync(["bash", "-lc", `command -v ${command}`], { stdout: "ignore", stderr: "ignore" });
  return result.exitCode === 0;
}

async function requireCommands(commands: string[]): Promise<void> {
  const missing: string[] = [];
  for (const command of commands) {
    if (!(await commandExists(command))) {
      missing.push(command);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing required commands: ${missing.join(", ")}`);
  }
}

async function runCommand(name: string, cmd: string[], cwd = repoRoot, env: Record<string, string> = {}): Promise<CommandResult> {
  const started = now();
  console.log(`\n[mega] ${name}: ${cmd.join(" ")}`);
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
  const result = {
    name,
    ok: exitCode === 0,
    exitCode,
    durationMs: now() - started,
    stdoutTail: tail(stdout),
    stderrTail: tail(stderr),
  };
  if (!result.ok) {
    console.error(`[mega] ${name} failed with exit ${exitCode}`);
  }
  return result;
}

function spawnManaged(name: string, cmd: string[], cwd = repoRoot, env: Record<string, string> = {}): ChildHandle {
  console.log(`[mega] starting ${name}: ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...Bun.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const child: ChildHandle = { name, pid: proc.pid, process: proc, stdout: [], stderr: [] };
  activeChildren.set(`${name}:${proc.pid}`, child);
  void proc.exited.finally(() => activeChildren.delete(`${name}:${proc.pid}`));
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
      for (const line of lines) {
        if (line.trim()) onLine(line);
      }
    }
    if (buffer.trim()) onLine(buffer);
  } catch {
    // Process teardown can close pipes while the reader is active.
  }
}

async function killManaged(child: ChildHandle | null, signal = "SIGTERM"): Promise<void> {
  if (!child) return;
  console.log(`[mega] stopping ${child.name} pid=${child.pid}`);
  killProcessTree(child.pid, signal);
  const exit = await Promise.race([child.process.exited, sleep(5000).then(() => null)]);
  if (exit === null) {
    killProcessTree(child.pid, "SIGKILL");
    await Promise.race([child.process.exited, sleep(2000)]);
  }
  activeChildren.delete(`${child.name}:${child.pid}`);
}

function killProcessTree(pid: number, signal: string): void {
  for (const childPid of childPids(pid)) {
    killProcessTree(childPid, signal);
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

function childPids(pid: number): number[] {
  try {
    const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8");
    return children.trim().split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

async function processTreeRssMb(pid: number): Promise<number> {
  let total = await rssForPid(pid);
  for (const childPid of childPids(pid)) {
    total += await processTreeRssMb(childPid);
  }
  return mb(total);
}

async function rssForPid(pid: number): Promise<number> {
  try {
    const status = await Bun.file(`/proc/${pid}/status`).text();
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

async function findListeningPids(port: number): Promise<string[]> {
  if (await commandExists("lsof")) {
    const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = new TextDecoder().decode(result.stdout);
    return [...new Set(text.trim().split(/\s+/).filter(Boolean))];
  }
  if (!(await commandExists("ss"))) {
    console.warn("[mega] neither lsof nor ss exists; skipping port preflight");
    return [];
  }
  const result = Bun.spawnSync(["ss", "-ltnp", `sport = :${port}`], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = new TextDecoder().decode(result.stdout);
  const pids = [...text.matchAll(/pid=(\d+)/g)].map(match => match[1]!);
  if (pids.length === 0 && text.split(/\r?\n/).some(line => line.includes("LISTEN"))) {
    return ["unknown"];
  }
  return [...new Set(pids)];
}

async function assertPortsFree(): Promise<void> {
  const conflicts = [];
  for (const port of [backendPort, postgresPort, cdpPort]) {
    const pids = await findListeningPids(port);
    if (pids.length > 0) {
      conflicts.push(`${port} (pid ${pids.join(", ")})`);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(`Refusing to run because expected-dead ports are already listening: ${conflicts.join("; ")}`);
  }
}

async function assertNoExistingObsidian(): Promise<void> {
  if (skipObsidian || !(await commandExists("pgrep"))) {
    return;
  }
  const result = Bun.spawnSync(["pgrep", "-af", "(obsidian|electron)"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const lines = new TextDecoder().decode(result.stdout)
    .split(/\r?\n/)
    .filter(line => line.trim())
    .filter(line => /\/share\/obsidian\/app\.asar|\belectron\b.*obsidian/i.test(line))
    .filter(line => !line.includes("pgrep -af"));
  if (lines.length > 0) {
    throw new Error(`Refusing to run because Obsidian already appears to be running:\n${lines.join("\n")}`);
  }
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const started = now();
  while (now() - started < timeoutMs) {
    if ((await findListeningPids(port)).length === 0) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for port ${port} to become free`);
}

async function killHarnessObsidian(): Promise<void> {
  const result = Bun.spawnSync(["pgrep", "-af", `obsidian.*remote-debugging-port=${cdpPort}`], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const pids = new TextDecoder().decode(result.stdout)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => Number(line.split(/\s+/, 1)[0]))
    .filter(pid => Number.isFinite(pid));
  for (const pid of pids) {
    killProcessTree(pid, "SIGTERM");
  }
  if (pids.length > 0) {
    await sleep(3000);
  }
  for (const pid of pids) {
    killProcessTree(pid, "SIGKILL");
  }
  await waitForPortFree(cdpPort, 5000).catch(() => undefined);
}

async function cleanupActiveState(): Promise<void> {
  for (const child of [...activeChildren.values()].reverse()) {
    await killManaged(child).catch(() => undefined);
  }
  await killHarnessObsidian().catch(() => undefined);
  for (const restore of [...activeRestores]) {
    await restore().catch(() => undefined);
  }
  await rm(dbDataPath, { recursive: true, force: true }).catch(() => undefined);
}

function installSignalCleanup(): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (signalCleanupStarted) {
        process.exit(130);
      }
      signalCleanupStarted = true;
      console.log(`[mega] received ${signal}; cleaning active processes`);
      void cleanupActiveState().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
    });
  }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const started = now();
  while (now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not ready yet.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForListeningPort(port: number, timeoutMs: number, owner?: ChildHandle): Promise<void> {
  const started = now();
  while (now() - started < timeoutMs) {
    const exited = owner ? await Promise.race([owner.process.exited, sleep(0).then(() => null)]) : null;
    if (exited !== null) {
      throw new Error(`${owner?.name ?? "process"} exited before port ${port} listened`);
    }
    if ((await findListeningPids(port)).length > 0) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for port ${port} to listen`);
}

async function waitForChildOutput(child: ChildHandle, pattern: RegExp, timeoutMs: number): Promise<void> {
  const started = now();
  while (now() - started < timeoutMs) {
    const exited = await Promise.race([child.process.exited, sleep(0).then(() => null)]);
    if (exited !== null) {
      throw new Error(`${child.name} exited before output matched ${pattern}`);
    }
    const output = `${child.stdout.join("\n")}\n${child.stderr.join("\n")}`;
    if (pattern.test(output)) {
      return;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${child.name} output to match ${pattern}`);
}

async function sampleLatency(url: string): Promise<number | undefined> {
  const started = performance.now();
  try {
    const response = await fetch(url);
    await response.text();
    return response.ok ? performance.now() - started : undefined;
  } catch {
    return undefined;
  }
}

async function resetVaultState(): Promise<() => Promise<void>> {
  const originalData = existsSync(dataJsonPath) ? await readFile(dataJsonPath, "utf8") : null;
  const originalAppend = existsSync(join(vaultPath, appendPath)) ? await readFile(join(vaultPath, appendPath), "utf8") : null;
  await mkdir(dirname(dataJsonPath), { recursive: true });
  const settings = originalData ? JSON.parse(originalData) : {};
  settings.backendUrl = `http://127.0.0.1:${backendPort}`;
  settings.lastPulledRevision = "0";
  await writeFile(dataJsonPath, JSON.stringify(settings, null, 2) + "\n");
  await rm(join(vaultPluginDir, "bootstrap"), { recursive: true, force: true });
  await rm(join(vaultPluginDir, "outbox"), { recursive: true, force: true });
  await rm(statePath, { recursive: true, force: true });
  return async () => {
    if (originalData === null) {
      await rm(dataJsonPath, { force: true });
    } else {
      await writeFile(dataJsonPath, originalData);
    }
    const appendFullPath = join(vaultPath, appendPath);
    if (originalAppend === null) {
      await rm(appendFullPath, { force: true });
    } else {
      await writeFile(appendFullPath, originalAppend);
    }
    await rm(join(vaultPluginDir, "bootstrap"), { recursive: true, force: true });
    await rm(join(vaultPluginDir, "outbox"), { recursive: true, force: true });
    await rm(statePath, { recursive: true, force: true });
  };
}

async function copyBuiltPluginToVault(): Promise<void> {
  const files = ["main.js", "manifest.json", "styles.css"];
  await mkdir(vaultPluginDir, { recursive: true });
  for (const file of files) {
    await writeFile(join(vaultPluginDir, file), await readFile(join(repoRoot, "plugin", file)));
  }
}

class CdpClient {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private ws: WebSocket;
  private opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error("CDP websocket failed to open"));
      this.ws.onmessage = event => this.onMessage(String(event.data));
    });
  }

  async ready(): Promise<void> {
    await this.opened;
  }

  async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 45000): Promise<any> {
    await this.ready();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: error => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.ws.send(payload);
    return result;
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(data: string): void {
    const message = JSON.parse(data);
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
    } else {
      pending.resolve(message.result);
    }
  }
}

async function connectObsidianCdp(): Promise<CdpClient> {
  const started = now();
  while (now() - started < 60000) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as Array<any>;
      const page =
        pages.find(target => target.type === "page" && target.url === "app://obsidian.md/index.html" && target.webSocketDebuggerUrl) ??
        pages.find(target => target.type === "page" && /Obsidian/i.test(target.title ?? "") && target.webSocketDebuggerUrl) ??
        pages.find(target => target.type === "page" && !String(target.url ?? "").startsWith("devtools://") && target.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) {
        const cdp = new CdpClient(page.webSocketDebuggerUrl);
        await cdp.ready();
        await cdp.send("Runtime.enable");
        await cdp.send("Performance.enable");
        await cdp.send("Profiler.enable");
        return cdp;
      }
    } catch {
      // Not ready yet.
    }
    await sleep(500);
  }
  throw new Error("Timed out waiting for Obsidian CDP target");
}

async function evalCdp(cdp: CdpClient, expression: string, timeoutMs = 30000): Promise<any> {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails));
  }
  return result.result?.value;
}

async function getHeapMb(cdp: CdpClient): Promise<number | undefined> {
  try {
    const result = await cdp.send("Runtime.getHeapUsage");
    return mb(result.usedSize);
  } catch {
    return undefined;
  }
}

async function waitForPluginReady(cdp: CdpClient): Promise<number> {
  const started = now();
  const expression = `
    (() => {
      const plugin = window.app?.plugins?.plugins?.["${pluginId}"];
      return Boolean(plugin?.syncClient?.startupSynced);
    })()
  `;
  while (now() - started < startupTimeoutMs) {
    if (await evalCdp(cdp, expression).catch(() => false)) {
      return now() - started;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${pluginId} startup sync`);
}

async function appendWithObsidianCli(runId: number): Promise<number> {
  const content = `\\n\\nmega-test ${new Date().toISOString()} run=${runId}`;
  const started = now();
  const result = await runCommand("obsidian append", [
    "obsidian",
    "append",
    `vault=${vaultName}`,
    `path=${appendPath}`,
    `content=${content}`,
  ]);
  if (!result.ok) {
    throw new Error(`obsidian append failed: ${result.stderrTail || result.stdoutTail}`);
  }
  return now() - started;
}

async function waitForOutboxOrRevisionChange(cdp: CdpClient, previousRevision: string | null): Promise<number> {
  const started = now();
  const expression = `
    (async () => {
      const plugin = window.app?.plugins?.plugins?.["${pluginId}"];
      if (!plugin) return { ready: false };
      const revision = plugin.settings?.lastPulledRevision ?? null;
      const outboxPending = await plugin.db?.hasPendingChanges?.().catch(() => false);
      const testFile = window.app?.vault?.getAbstractFileByPath?.(${JSON.stringify(appendPath)});
      const content = testFile ? await window.app.vault.read(testFile).catch(() => "") : "";
      const sawAppend = content.includes("mega-test ");
      return { ready: sawAppend && (revision !== ${JSON.stringify(previousRevision)} || outboxPending === false), revision, outboxPending, sawAppend };
    })()
  `;
  while (now() - started < 30000) {
    const result = await evalCdp(cdp, expression).catch(() => null);
    if (result?.ready) {
      return now() - started;
    }
    await sleep(250);
  }
  return now() - started;
}

async function startSampler(
  name: string,
  pid: number,
  opts: { heap?: () => Promise<number | undefined>; latencyUrl?: string } = {},
): Promise<{ samples: Sample[]; stop: () => Promise<void> }> {
  let stopped = false;
  let reported = false;
  const samples: Sample[] = [];
  const started = now();
  const loop = async () => {
    while (!stopped) {
      const [rssMb, heapMb, latencyMs] = await Promise.all([
        processTreeRssMb(pid),
        opts.heap ? opts.heap() : Promise.resolve(undefined),
        opts.latencyUrl ? sampleLatency(opts.latencyUrl) : Promise.resolve(undefined),
      ]);
      samples.push({ atMs: now() - started, rssMb: round(rssMb), heapMb: heapMb === undefined ? undefined : round(heapMb), latencyMs: latencyMs === undefined ? undefined : round(latencyMs) });
      await sleep(sampleIntervalMs);
    }
  };
  const running = loop();
  return {
    samples,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await Promise.race([running, sleep(sampleIntervalMs + 1000)]);
      if (!reported) {
        reported = true;
        console.log(`[mega] collected ${samples.length} ${name} samples`);
      }
    },
  };
}

async function runSelfTest(): Promise<void> {
  console.log("[mega] running self-test mode");
  if (injectedSleepMs > 0) await sleep(injectedSleepMs);
  const sleeper = spawnManaged("self-test-sleeper", ["bash", "-lc", "sleep 30"]);
  const sampler = await startSampler("self-test", sleeper.pid);
  await sleep(1500);
  await sampler.stop();
  await killManaged(sleeper);
  const report = {
    mode: "self-test",
    samples: sampler.samples,
    summary: summarize(sampler.samples.map(sample => sample.rssMb)),
  };
  await mkdir(reportDir, { recursive: true });
  const path = join(reportDir, `self-test-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(report, null, 2));
  console.log(`[mega] self-test report: ${path}`);
}

async function runUnitAndDockerTests(): Promise<CommandResult[]> {
  if (skipTests) return [];
  const results: CommandResult[] = [];
  results.push(await runCommand("shared protocol/path tests", ["bun", "test", "shared"], repoRoot));
  results.push(await runCommand("plugin unit tests", ["npm", "test"], join(repoRoot, "plugin")));
  results.push(await runCommand("server unit tests", ["bun", "run", "test:unit"], join(repoRoot, "server")));
  if (!skipDocker) {
    results.push(await runCommand("server docker integration tests", ["bun", "run", "test:integration:docker"], join(repoRoot, "server")));
  }
  return results;
}

async function runPluginBuild(): Promise<CommandResult | null> {
  if (noBuildPlugin) return null;
  const result = await runCommand("plugin build", ["npm", "run", "build"], join(repoRoot, "plugin"));
  if (result.ok) {
    await copyBuiltPluginToVault();
  }
  return result;
}

async function runOneIteration(runId: number): Promise<Record<string, unknown>> {
  console.log(`\n[mega] ===== iteration ${runId}/${iterations} =====`);
  let restoreVault: (() => Promise<void>) | null = null;
  let db: ChildHandle | null = null;
  let server: ChildHandle | null = null;
  let obsidian: ChildHandle | null = null;
  let backendSampler: Awaited<ReturnType<typeof startSampler>> | null = null;
  let obsidianSampler: Awaited<ReturnType<typeof startSampler>> | null = null;
  let cdp: CdpClient | null = null;
  const started = now();

  try {
    restoreVault = await resetVaultState();
    activeRestores.add(restoreVault);
    if (injectedSleepMs > 0) await sleep(injectedSleepMs);

    db = spawnManaged("db_setup.sh", ["bash", "./db_setup.sh"], repoRoot);
    await waitForListeningPort(postgresPort, 30000, db);
    await waitForChildOutput(db, /connect at postgres:\/\//, 30000);

    server = spawnManaged("bun server", ["bun", "run", "src/index.ts"], join(repoRoot, "server"), {
      DATABASE_URL: `postgres://${Bun.env.USER ?? "postgres"}@127.0.0.1:${postgresPort}/obsidian_sync`,
      POSTGRES_URL: `postgres://${Bun.env.USER ?? "postgres"}@127.0.0.1:${postgresPort}/obsidian_sync`,
      SYNC_LOG_LEVEL: "warn",
    });
    const backendInitStarted = now();
    await waitForHttp(`http://127.0.0.1:${backendPort}/health`, 60000);
    const backendInitMs = now() - backendInitStarted;
    backendSampler = await startSampler("backend", server.pid, { latencyUrl: `http://127.0.0.1:${backendPort}/health` });

    let obsidianStartupMs: number | null = null;
    let appendCliMs: number | null = null;
    let appendSyncMs: number | null = null;
    let heapBeforeMb: number | undefined;
    let heapAfterStartupMb: number | undefined;
    let heapAfterAppendMb: number | undefined;
    let cpuProfilePath: string | null = null;
    let performanceMetrics: { afterStartup?: unknown; afterAppend?: unknown } = {};

    if (!skipObsidian) {
      const obsidianStarted = now();
      obsidian = spawnManaged("obsidian", [
        "obsidian",
        `--remote-debugging-port=${cdpPort}`,
        `--remote-allow-origins=http://localhost:${cdpPort}`,
        "--js-flags=--max-old-space-size=300",
        `obsidian://open?vault=${encodeURIComponent(vaultName)}`,
      ], repoRoot);
      cdp = await connectObsidianCdp();
      await cdp.send("Profiler.start");
      heapBeforeMb = await getHeapMb(cdp);
      obsidianSampler = await startSampler("obsidian", obsidian.pid, { heap: () => cdp ? getHeapMb(cdp) : Promise.resolve(undefined) });
      obsidianStartupMs = await waitForPluginReady(cdp);
      heapAfterStartupMb = await getHeapMb(cdp);
      performanceMetrics.afterStartup = await cdp.send("Performance.getMetrics").catch(() => null);
      const previousRevision = await evalCdp(cdp, `window.app?.plugins?.plugins?.["${pluginId}"]?.settings?.lastPulledRevision ?? null`).catch(() => null);
      appendCliMs = await appendWithObsidianCli(runId);
      appendSyncMs = await waitForOutboxOrRevisionChange(cdp, previousRevision);
      await sleep(postAppendSettleMs);
      heapAfterAppendMb = await getHeapMb(cdp);
      performanceMetrics.afterAppend = await cdp.send("Performance.getMetrics").catch(() => null);
      const profile = await cdp.send("Profiler.stop").catch(() => null);
      if (profile) {
        cpuProfilePath = join(reportDir, `obsidian-run-${runId}-${Date.now()}.cpuprofile`);
        await writeFile(cpuProfilePath, JSON.stringify(profile.profile ?? profile));
      }
      console.log(`[mega] obsidian process startup wall=${now() - obsidianStarted}ms pluginReady=${obsidianStartupMs}ms appendCli=${appendCliMs}ms appendSync=${appendSyncMs}ms`);
    }

    await backendSampler?.stop();
    await obsidianSampler?.stop();
    cdp?.close();

    const backendRss = summarize(backendSampler?.samples.map(sample => sample.rssMb) ?? []);
    const backendLatency = summarize((backendSampler?.samples ?? []).map(sample => sample.latencyMs).filter((value): value is number => value !== undefined));
    const obsidianRss = summarize(obsidianSampler?.samples.map(sample => sample.rssMb) ?? []);
    const obsidianHeap = summarize((obsidianSampler?.samples ?? []).map(sample => sample.heapMb).filter((value): value is number => value !== undefined));

    return {
      runId,
      ok: true,
      durationMs: now() - started,
      backend: { initMs: backendInitMs, rssMb: backendRss, latencyMs: backendLatency, samples: backendSampler?.samples },
      obsidian: {
        startupMs: obsidianStartupMs,
        appendCliMs,
        appendSyncMs,
        rssMb: obsidianRss,
        heapMb: obsidianHeap,
        heapDeltaStartupMb: heapBeforeMb !== undefined && heapAfterStartupMb !== undefined ? round(heapAfterStartupMb - heapBeforeMb) : null,
        heapDeltaAppendMb: heapAfterStartupMb !== undefined && heapAfterAppendMb !== undefined ? round(heapAfterAppendMb - heapAfterStartupMb) : null,
        cpuProfilePath,
        performanceMetrics,
        samples: obsidianSampler?.samples,
      },
    };
  } catch (error) {
    return {
      runId,
      ok: false,
      durationMs: now() - started,
      error: error instanceof Error ? error.message : String(error),
      logs: {
        db: db ? { stdout: tail(db.stdout.join("\n")), stderr: tail(db.stderr.join("\n")) } : null,
        server: server ? { stdout: tail(server.stdout.join("\n")), stderr: tail(server.stderr.join("\n")) } : null,
        obsidian: obsidian ? { stdout: tail(obsidian.stdout.join("\n")), stderr: tail(obsidian.stderr.join("\n")) } : null,
      },
    };
  } finally {
    await obsidianSampler?.stop().catch(() => undefined);
    await backendSampler?.stop().catch(() => undefined);
    cdp?.close();
    await killManaged(obsidian);
    await killHarnessObsidian();
    await killManaged(server);
    await killManaged(db);
    await restoreVault?.();
    if (restoreVault) {
      activeRestores.delete(restoreVault);
    }
    await rm(dbDataPath, { recursive: true, force: true });
  }
}

function aggregateRuns(runs: Array<Record<string, any>>): Record<string, unknown> {
  const okRuns = runs.filter(run => run.ok);
  return {
    okRuns: okRuns.length,
    totalRuns: runs.length,
    backendInitMs: summarize(okRuns.map(run => run.backend?.initMs).filter((value): value is number => typeof value === "number")),
    backendRssAvgMb: summarize(okRuns.map(run => run.backend?.rssMb?.avg).filter((value): value is number => typeof value === "number")),
    backendLatencyAvgMs: summarize(okRuns.map(run => run.backend?.latencyMs?.avg).filter((value): value is number => typeof value === "number")),
    obsidianStartupMs: summarize(okRuns.map(run => run.obsidian?.startupMs).filter((value): value is number => typeof value === "number")),
    obsidianRssAvgMb: summarize(okRuns.map(run => run.obsidian?.rssMb?.avg).filter((value): value is number => typeof value === "number")),
    obsidianHeapAvgMb: summarize(okRuns.map(run => run.obsidian?.heapMb?.avg).filter((value): value is number => typeof value === "number")),
    appendSyncMs: summarize(okRuns.map(run => run.obsidian?.appendSyncMs).filter((value): value is number => typeof value === "number")),
  };
}

async function main(): Promise<void> {
  installSignalCleanup();
  await mkdir(reportDir, { recursive: true });
  if (selfTest) {
    await runSelfTest();
    return;
  }
  await requireCommands(["bun", "npm", "bash"]);
  await requireCommands(["initdb", "pg_ctl", "createdb"]);
  if (!skipObsidian) {
    await requireCommands(["obsidian"]);
  }
  if (!existsSync(vaultPath)) throw new Error(`Vault path does not exist: ${vaultPath}`);
  if (!existsSync(vaultPluginDir)) throw new Error(`Vault plugin dir does not exist: ${vaultPluginDir}`);
  await assertPortsFree();
  await assertNoExistingObsidian();

  const build = await runPluginBuild();
  if (build && !build.ok) {
    throw new Error("Plugin build failed; refusing to run perf harness with stale plugin bundle");
  }

  const tests = await runUnitAndDockerTests();
  const failedTests = tests.filter(result => !result.ok);
  if (failedTests.length > 0) {
    const report = { generatedAt: new Date().toISOString(), build, tests };
    const failedPath = join(reportDir, `mega-test-failed-tests-${Date.now()}.json`);
    await writeFile(failedPath, JSON.stringify(report, null, 2));
    throw new Error(`Tests failed before profiling. Report: ${failedPath}`);
  }

  const runs = [];
  for (let runId = 1; runId <= iterations; runId++) {
    runs.push(await runOneIteration(runId));
  }
  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      repoRoot,
      vaultPath,
      vaultName,
      pluginId,
      appendPath,
      iterations,
      sampleIntervalMs,
      startupTimeoutMs,
      postAppendSettleMs,
      injectedSleepMs,
      skipObsidian,
      skipDocker,
      skipTests,
      noBuildPlugin,
    },
    build,
    tests,
    aggregate: aggregateRuns(runs),
    runs,
  };
  const reportPath = join(reportDir, `mega-test-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n[mega] report: ${reportPath}`);
  console.log(JSON.stringify(report.aggregate, null, 2));
  if (runs.some(run => !run.ok)) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
