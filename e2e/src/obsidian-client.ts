import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
	clientConfigSchema,
	clientInviteSchema,
	type ClientConfig,
	type ClientInvite,
} from "obsidian-sync-protocol";
import { waitFor } from "./wait";
import {
	installPlugin,
	sampleVault,
	writeObsidianConfig,
	clearVault,
} from "./fixtures";
import { CONTAINER_BIN, hostGatewayRunArgs } from "./container";

const IMAGE = process.env.E2E_OBSIDIAN_IMAGE ?? "lscr.io/linuxserver/obsidian:latest";
const EVAL_BRIDGE_KEY = "__obsidianSyncE2EAsync";
const PAUSED_TICK_KEY = "__obsidianSyncE2EPausedTick";

type ConfigurableClientSettings = Pick<
	ClientConfig,
	"serverUrl" | "clientName"
> &
	Partial<Pick<ClientConfig, "clientSecret" | "revision">>;

type AsyncEvalState =
	| { status: "pending" }
	| { status: "fulfilled"; value?: string }
	| { status: "rejected"; error: string };

export type ClientDiagnostics = {
	revision: number;
	outboxDepth: number;
	inboxDepth: number;
	lastError: string | null;
};

export type ObsidianClientOptions = {
	name: string;
	/** Host directory mounted at /config inside the container. */
	configHostDir: string;
	httpPort: number;
	httpsPort: number;
};

/**
 * Obsidian client driven exclusively through `obsidian-cli` inside a
 * linuxserver/obsidian Podman container. Vault lives at
 * `<configHostDir>/vaults/<name>` so a single /config mount is enough.
 */
export class ObsidianClient {
	readonly name: string;
	readonly containerName: string;
	readonly configHostDir: string;
	readonly vaultHostDir: string;
	readonly vaultContainerPath: string;
	private readonly httpPort: number;
	private readonly httpsPort: number;

	constructor(options: ObsidianClientOptions) {
		this.name = options.name;
		this.containerName = `e2e-obsidian-${options.name}`;
		this.configHostDir = options.configHostDir;
		this.vaultHostDir = join(options.configHostDir, "vaults", options.name);
		this.vaultContainerPath = `/config/vaults/${options.name}`;
		this.httpPort = options.httpPort;
		this.httpsPort = options.httpsPort;
	}

	vaultPath(...parts: string[]): string {
		return join(this.vaultHostDir, ...parts);
	}

	pluginDataPath(): string {
		return this.vaultPath(".obsidian", "plugins", "obsidian-sync-engine", "data.json");
	}

	outboxPath(): string {
		return this.vaultPath(
			".obsidian",
			"plugins",
			"obsidian-sync-engine",
			"outbox.jsonl",
		);
	}

	async prepareFreshSampleVault(): Promise<void> {
		await mkdir(this.configHostDir, { recursive: true });
		await sampleVault(this.vaultHostDir);
		await installPlugin(this.vaultHostDir);
		await writeObsidianConfig(
			this.configHostDir,
			this.vaultContainerPath,
			this.name,
		);
	}

	async prepareEmptyVaultWithPlugin(): Promise<void> {
		await mkdir(this.configHostDir, { recursive: true });
		await clearVault(this.vaultHostDir);
		await installPlugin(this.vaultHostDir);
		await writeObsidianConfig(
			this.configHostDir,
			this.vaultContainerPath,
			this.name,
		);
	}

	async start(): Promise<void> {
		await this.stop().catch(() => undefined);
		const uid = process.getuid?.() ?? 1000;
		const gid = process.getgid?.() ?? 1000;
		const volumeSuffix = CONTAINER_BIN === "podman" ? ":Z" : "";

		const proc = Bun.spawn(
			[
				CONTAINER_BIN,
				"run",
				"-d",
				"--name",
				this.containerName,
				...hostGatewayRunArgs(),
				"-e",
				`PUID=${uid}`,
				"-e",
				`PGID=${gid}`,
				"-e",
				"TZ=Etc/UTC",
				"-e",
				"PASSWORD=e2e",
				"-e",
				"CUSTOM_USER=e2e",
				"-p",
				`${this.httpPort}:3000`,
				"-p",
				`${this.httpsPort}:3001`,
				"-v",
				`${this.configHostDir}:/config${volumeSuffix}`,
				"--shm-size=1gb",
				"--security-opt",
				"seccomp=unconfined",
				IMAGE,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new Error(`${CONTAINER_BIN} run failed (${exitCode}): ${stderr}`);
		}

		await this.waitReady();
		await this.enableCommunityPlugins();
	}

	async stop(): Promise<void> {
		const proc = Bun.spawn([CONTAINER_BIN, "rm", "-f", this.containerName], {
			stdout: "pipe",
			stderr: "pipe",
		});
		await proc.exited;
	}

	async waitReady(): Promise<void> {
		await waitFor(
			async () => {
				const result = await this.cliRaw(["vaults"]);
				return result.exitCode === 0 && result.stdout.trim().length > 0;
			},
			{
				timeoutMs: 90_000,
				intervalMs: 1000,
				label: `${this.name} Obsidian CLI ready`,
			},
		);
	}

	async enableCommunityPlugins(): Promise<void> {
		const restrict = await this.cli(["plugins:restrict"]);
		if (restrict.trim() !== "off") {
			await this.cli(["plugins:restrict", "off"]);
			// Toggling restricted mode reloads the whole app; wait for CLI again.
			await this.waitReady();
		}

		// Prefer enabling explicitly; reload alone can race the post-restrict boot.
		const enable = await this.cliRaw([
			"plugin:enable",
			"id=obsidian-sync-engine",
		]);
		if (enable.exitCode !== 0) {
			await this.cli(["plugin:reload", "id=obsidian-sync-engine"]);
		}

		await waitFor(
			async () => {
				const enabled = await this.cli(["plugins:enabled"]);
				if (!enabled.split("\n").map((l) => l.trim()).includes("obsidian-sync-engine")) {
					return false;
				}
				// Confirm the instance is actually constructed, not just listed.
				const result = await this.eval(
					`!!app.plugins.getPlugin('obsidian-sync-engine')`,
				);
				return result === "true";
			},
			{ timeoutMs: 90_000, intervalMs: 1000, label: `${this.name} plugin loaded` },
		);
	}

	async cli(args: string[]): Promise<string> {
		const result = await this.cliRaw(args);
		if (result.exitCode !== 0) {
			throw new Error(
				`obsidian-cli ${args.join(" ")} failed (${result.exitCode}): ${result.stderr || result.stdout}`,
			);
		}
		return result.stdout.trim();
	}

	private async cliRaw(
		args: string[],
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn(
			[
				CONTAINER_BIN,
				"exec",
				"-u",
				"abc",
				"-e",
				"HOME=/config",
				"-e",
				"XDG_RUNTIME_DIR=/config/.XDG",
				this.containerName,
				"/opt/obsidian/obsidian-cli",
				...args,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;
		return { exitCode, stdout, stderr };
	}

	async eval(code: string): Promise<string> {
		// Do NOT JSON-quote the code value: surrounding double quotes make the
		// Obsidian CLI evaluate a string literal instead of executing the JS.
		const result = await this.cliRaw(["eval", `code=${code}`]);
		const output = [result.stdout.trim(), result.stderr.trim()]
			.filter(Boolean)
			.join("\n");
		if (result.exitCode !== 0) {
			throw new Error(
				`Obsidian eval failed (${result.exitCode}): ${output || "no diagnostic"}`,
			);
		}
		const resultMarker = result.stdout.lastIndexOf("=>");
		if (resultMarker < 0) {
			throw new Error(
				`Obsidian eval returned no result marker: ${output || "empty output"}`,
			);
		}
		const value = result.stdout.slice(resultMarker + 2).trim();
		const diagnostic = [value, result.stderr.trim()].filter(Boolean).join("\n");
		if (
			/^(?:(?:evaluation|syntax|reference|type|range)?\s*error\s*:)/i.test(
				diagnostic,
			) ||
			/\b(?:uncaught|unhandled rejection)\b/i.test(diagnostic)
		) {
			throw new Error(`Obsidian eval failed: ${diagnostic}`);
		}
		return value;
	}

	/**
	 * Evaluate a Promise-producing expression inside Obsidian and wait for its
	 * actual settlement. obsidian-cli only awaits its own command dispatch, not
	 * a Promise returned by `eval`, so a token stored in the renderer bridges
	 * completion back to the harness.
	 */
	async evalAsync<T = unknown>(
		expression: string,
		options: { timeoutMs?: number; label?: string } = {},
	): Promise<T> {
		const token = `${this.name}-${crypto.randomUUID()}`;
		const launch = `(() => {
			const root = globalThis[${JSON.stringify(EVAL_BRIDGE_KEY)}] ??=
				Object.create(null);
			const token = ${JSON.stringify(token)};
			root[token] = { status: "pending" };
			Promise.resolve()
				.then(() => (0, eval)(${JSON.stringify(expression)}))
				.then(
					(value) => {
						const encoded = JSON.stringify(value);
						root[token] = encoded === undefined
							? { status: "fulfilled" }
							: { status: "fulfilled", value: encoded };
					},
					(error) => {
						root[token] = {
							status: "rejected",
							error: error instanceof Error
								? (error.stack ?? error.message)
								: String(error),
						};
					},
				);
			return token;
		})()`;
		const launchedToken = await this.eval(launch);
		if (launchedToken !== token) {
			throw new Error(
				`Obsidian async eval launched the wrong token: ${launchedToken}`,
			);
		}

		try {
			const timeoutMs = options.timeoutMs ?? 60_000;
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const raw = await this.eval(
					`JSON.stringify(globalThis[${JSON.stringify(EVAL_BRIDGE_KEY)}]?.[${JSON.stringify(token)}] ?? null)`,
				);
				const state = JSON.parse(raw) as AsyncEvalState | null;
				if (state?.status === "rejected") {
					throw new Error(state.error);
				}
				if (state?.status === "fulfilled") {
					return state.value === undefined
						? (undefined as T)
						: (JSON.parse(state.value) as T);
				}
				await Bun.sleep(100);
			}
			throw new Error(
				`Timed out after ${timeoutMs}ms waiting for ` +
					(options.label ?? `${this.name} async eval`),
			);
		} finally {
			await this.eval(
				`delete globalThis[${JSON.stringify(EVAL_BRIDGE_KEY)}]?.[${JSON.stringify(token)}]`,
			).catch(() => undefined);
		}
	}

	async command(id: string): Promise<string> {
		return this.cli(["command", `id=${id}`]);
	}

	async createNote(name: string, content: string): Promise<void> {
		const path = name.endsWith(".md") ? name : `${name}.md`;
		await this.writeNote(path, content);
	}

	async deleteNote(path: string): Promise<void> {
		await this.evalAsync(
			`(async () => {
				const path = ${JSON.stringify(path)};
				const file = app.vault.getAbstractFileByPath(path);
				if (!file) throw new Error("Cannot delete missing path: " + path);
				await app.vault.delete(file, true);
				return true;
			})()`,
			{ label: `${this.name} delete ${path}` },
		);
	}

	async appendNote(path: string, content: string): Promise<void> {
		await this.evalAsync(
			`(async () => {
				const path = ${JSON.stringify(path)};
				const file = app.vault.getFileByPath(path);
				if (!file) throw new Error("Cannot append missing file: " + path);
				await app.vault.modify(file, (await app.vault.read(file)) + ${JSON.stringify(content)});
				return true;
			})()`,
			{ label: `${this.name} append ${path}` },
		);
	}

	async writeNote(path: string, content: string): Promise<void> {
		await this.evalAsync(
			`(async () => {
				const path = ${JSON.stringify(path)};
				const parts = path.split("/");
				parts.pop();
				let parent = "";
				for (const part of parts) {
					parent = parent ? parent + "/" + part : part;
					if (!app.vault.getAbstractFileByPath(parent)) {
						await app.vault.createFolder(parent);
					}
				}
				const existing = app.vault.getFileByPath(path);
				if (existing) await app.vault.modify(existing, ${JSON.stringify(content)});
				else await app.vault.create(path, ${JSON.stringify(content)});
				return true;
			})()`,
			{ label: `${this.name} write ${path}` },
		);
	}

	async renameNote(from: string, to: string): Promise<void> {
		await this.evalAsync(
			`(async () => {
				const from = ${JSON.stringify(from)};
				const to = ${JSON.stringify(to)};
				const file = app.vault.getAbstractFileByPath(from);
				if (!file) throw new Error("Cannot rename missing path: " + from);
				const parts = to.split("/");
				parts.pop();
				let parent = "";
				for (const part of parts) {
					parent = parent ? parent + "/" + part : part;
					if (!app.vault.getAbstractFileByPath(parent)) {
						await app.vault.createFolder(parent);
					}
				}
				await app.vault.rename(file, to);
				return true;
			})()`,
			{ label: `${this.name} rename ${from} to ${to}` },
		);
	}

	async configurePlugin(settings: ConfigurableClientSettings): Promise<void> {
		const next = clientConfigSchema.parse({
			serverUrl: settings.serverUrl,
			clientName: settings.clientName,
			clientSecret: settings.clientSecret ?? "Made by server",
			revision: settings.revision ?? 0,
		});
		const payload = JSON.stringify(next, null, 2);
		const containerDataPath =
			`${this.vaultContainerPath}/.obsidian/plugins/obsidian-sync-engine/data.json`;
		// Write as the container user so we never fight volume ownership.
		const proc = Bun.spawn(
			[
				CONTAINER_BIN,
				"exec",
				"-u",
				"abc",
				"-i",
				this.containerName,
				"bash",
				"-lc",
				`cat > ${JSON.stringify(containerDataPath)}`,
			],
			{ stdin: new Blob([payload]), stdout: "pipe", stderr: "pipe" },
		);
		const stderr = await new Response(proc.stderr).text();
		const code = await proc.exited;
		if (code !== 0) {
			throw new Error(`failed to write data.json: ${stderr}`);
		}

		await this.cli(["plugin:reload", "id=obsidian-sync-engine"]);
		await waitFor(
			async () => {
				const s = await this.readSettings();
				return s.serverUrl === next.serverUrl && s.clientName === next.clientName
					? s
					: false;
			},
			{ timeoutMs: 30_000, label: `${this.name} settings applied` },
		);
	}

	async createClientInvite(): Promise<ClientInvite> {
		const invite = await this.evalAsync<unknown>(
			`app.plugins.getPlugin("obsidian-sync-engine").createClientInvite()`,
			{ label: `${this.name} create client invite` },
		);
		return clientInviteSchema.parse(invite);
	}

	async readSettings(): Promise<ClientConfig> {
		const raw = await this.eval(
			`JSON.stringify(app.plugins.getPlugin('obsidian-sync-engine').settings)`,
		);
		return clientConfigSchema.parse(JSON.parse(raw));
	}

	async forceTick(): Promise<void> {
		const result = await this.evalAsync<{ ok: boolean; error?: string }>(
			`app.plugins.getPlugin('obsidian-sync-engine').sync.engine.tick()`,
			{ label: `${this.name} sync tick` },
		);
		if (!result.ok) {
			throw new Error(`Sync tick failed: ${result.error ?? "unknown error"}`);
		}
	}

	/**
	 * Pause network ticks without suspending Vault event capture. This lets an
	 * E2E client remain causally stale while local mutations still reach its
	 * durable outbox.
	 */
	async pauseNetworkTicks(): Promise<void> {
		await this.evalAsync(
			`(async () => {
				const plugin = app.plugins.getPlugin("obsidian-sync-engine");
				const engine = plugin.sync.engine;
				const key = ${JSON.stringify(PAUSED_TICK_KEY)};
				if (globalThis[key]) throw new Error("Network ticks are already paused");
				globalThis[key] = { engine, tick: engine.tick };
				engine.tick = async () => ({ ok: true, pushed: 0, applied: 0 });
				await engine.quiesce();
				return true;
			})()`,
			{ label: `${this.name} pause network ticks` },
		);
	}

	async resumeNetworkTicks(): Promise<void> {
		await this.evalAsync(
			`(() => {
				const key = ${JSON.stringify(PAUSED_TICK_KEY)};
				const paused = globalThis[key];
				if (!paused) throw new Error("Network ticks are not paused");
				paused.engine.tick = paused.tick;
				delete globalThis[key];
				return true;
			})()`,
			{ label: `${this.name} resume network ticks` },
		);
	}

	async diagnostics(): Promise<ClientDiagnostics> {
		return this.evalAsync<ClientDiagnostics>(
			`(async () => {
				const plugin = app.plugins.getPlugin("obsidian-sync-engine");
				const countLines = async (path) => {
					if (!(await app.vault.adapter.exists(path))) return 0;
					return (await app.vault.adapter.read(path))
						.split("\\n")
						.filter((line) => line.trim().length > 0)
						.length;
				};
				const outbox = plugin.sync.outboxPath;
				const inbox = outbox.replace(/outbox\\.jsonl$/, "inbox.jsonl");
				return {
					revision: plugin.settings.revision,
					outboxDepth: await countLines(outbox),
					inboxDepth: await countLines(inbox),
					lastError: plugin.sync.status.lastError,
				};
			})()`,
			{ label: `${this.name} diagnostics` },
		);
	}

	async snapshotFiles(): Promise<Record<string, string>> {
		return this.evalAsync<Record<string, string>>(
			`(async () => {
				const plugin = app.plugins.getPlugin("obsidian-sync-engine");
				const pluginDir =
					plugin.manifest.dir ??
					app.vault.configDir + "/plugins/" + plugin.manifest.id;
				const dataPath = pluginDir + "/data.json";
				const stateDir = pluginDir + "/state";
				const result = {};
				for (const path of await plugin.sync.fs.listAllFiles()) {
					if (
						path === dataPath ||
						path === stateDir ||
						path.startsWith(stateDir + "/")
					) continue;
					const bytes = new Uint8Array(
						await app.vault.adapter.readBinary(path),
					);
					let binary = "";
					for (const byte of bytes) binary += String.fromCharCode(byte);
					result[path] = btoa(binary);
				}
				return result;
			})()`,
			{ label: `${this.name} vault snapshot` },
		);
	}
}
