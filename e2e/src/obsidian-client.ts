import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { waitFor } from "./wait";
import {
	installPlugin,
	sampleVault,
	writeObsidianConfig,
	clearVault,
} from "./fixtures";
import { CONTAINER_BIN, hostGatewayRunArgs } from "./container";

const IMAGE = process.env.E2E_OBSIDIAN_IMAGE ?? "lscr.io/linuxserver/obsidian:latest";

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
		const out = await this.cli(["eval", `code=${code}`]);
		const match = out.match(/=>\s*([\s\S]*)$/);
		return (match?.[1] ?? out).trim();
	}

	async command(id: string): Promise<string> {
		return this.cli(["command", `id=${id}`]);
	}

	async createNote(name: string, content: string): Promise<void> {
		await this.cli([
			"create",
			`name=${name}`,
			`content=${content.replace(/\n/g, "\\n")}`,
			"overwrite",
		]);
	}

	async deleteNote(path: string): Promise<void> {
		await this.cli(["delete", `path=${path}`, "permanent"]);
	}

	async appendNote(path: string, content: string): Promise<void> {
		await this.cli([
			"append",
			`path=${path}`,
			`content=${content.replace(/\n/g, "\\n")}`,
		]);
	}

	async configurePlugin(settings: {
		serverUrl: string;
		clientName: string;
		clientSecret?: string;
		revision?: number;
	}): Promise<void> {
		const next = {
			serverUrl: settings.serverUrl,
			clientName: settings.clientName,
			clientSecret: settings.clientSecret ?? "Made by server",
			revision: settings.revision ?? 0,
		};
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

	async authenticate(): Promise<void> {
		await this.command("obsidian-sync-engine:authenticate-with-server");
	}

	async seed(): Promise<void> {
		await this.command("obsidian-sync-engine:seed-server-from-vault");
	}

	async readSettings(): Promise<{
		serverUrl: string;
		clientName: string;
		clientSecret: string;
		revision: number;
	}> {
		const raw = await this.eval(
			`JSON.stringify(app.plugins.getPlugin('obsidian-sync-engine').settings)`,
		);
		return JSON.parse(raw) as {
			serverUrl: string;
			clientName: string;
			clientSecret: string;
			revision: number;
		};
	}

	async forceTick(): Promise<void> {
		await this.eval(
			`await app.plugins.getPlugin('obsidian-sync-engine').sync.engine.tick()`,
		);
	}
}
