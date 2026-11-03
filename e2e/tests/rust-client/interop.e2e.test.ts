import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { $ } from "bun";
import { HeadlessPluginClient } from "../../src/headless-plugin-client";
import { wipeTestDatabase, type Stack } from "../../src/stack";
import { readServerSnapshot } from "../../src/convergence";
import { sleep, waitFor } from "../../src/wait";

/**
 * Real server + Postgres, the compiled Rust client as a process, and the
 * plugin's own SyncEngine/HttpTransport as the other device. Build first with
 * `cargo build --manifest-path rust-client/Cargo.toml`.
 */
const REPO_ROOT = join(import.meta.dir, "../../..");
const BINARY =
	process.env.RUST_CLIENT_BIN ??
	join(REPO_ROOT, "rust-client/target/debug/obsidian-sync-client");
const DATA_PATH = ".obsidian/plugins/obsidian-sync-engine/data.json";
const PLUGIN_DIR = ".obsidian/plugins/obsidian-sync-engine";

const BINARY_BYTES = Uint8Array.from({ length: 2048 }, (_, i) => i % 256);

type RustProcess = {
	proc: Bun.Subprocess;
	logPath: string;
};

async function collectVault(dir: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const path = relative(dir, join(entry.parentPath, entry.name));
		if (path === DATA_PATH || path.startsWith(`${PLUGIN_DIR}/state/`)) continue;
		files[path] = (await readFile(join(dir, path))).toString("base64");
	}
	return files;
}

function sameFiles(left: Record<string, string>, right: Record<string, string>): boolean {
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return (
		JSON.stringify(leftKeys) === JSON.stringify(rightKeys) &&
		leftKeys.every((key) => left[key] === right[key])
	);
}

function diffFiles(left: Record<string, string>, right: Record<string, string>): string {
	const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
	return [...keys].filter((key) => left[key] !== right[key]).join(", ");
}

const DATABASE_URL =
	process.env.E2E_DATABASE_URL ??
	"postgres://postgres:postgres@localhost:5434/test_db";

/** Starts the real server with its logs kept in a file for debugging. */
async function startLocalStack(workDir: string): Promise<Stack> {
	await wipeTestDatabase(DATABASE_URL);
	const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = probe.port;
	probe.stop(true);
	const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
		cwd: join(REPO_ROOT, "server"),
		env: {
			...process.env,
			DATABASE_URL,
			PORT: String(port),
			HOST: "127.0.0.1",
		},
		stdout: Bun.file(join(workDir, "server.log")),
		stderr: Bun.file(join(workDir, "server.err.log")),
	});
	const serverUrlLocal = `http://127.0.0.1:${port}`;
	await waitFor(
		async () => {
			try {
				return (await fetch(`${serverUrlLocal}/health`)).ok;
			} catch {
				return false;
			}
		},
		{ timeoutMs: 30_000, label: "sync server ready" },
	);
	return {
		databaseUrl: DATABASE_URL,
		serverUrl: serverUrlLocal,
		serverUrlLocal,
		serverPort: port,
		stopServer: async () => {
			proc.kill();
			await proc.exited.catch(() => undefined);
		},
	};
}

describe("rust client interop", () => {
	let stack: Stack;
	let workDir: string;
	let rustVault: string;
	let plugin: HeadlessPluginClient;
	let rust: RustProcess | null = null;
	let logIndex = 0;
	let rustSecret = "";
	const secrets: string[] = [];
	const logPaths: string[] = [];

	async function readData(vault = rustVault): Promise<Record<string, unknown>> {
		return JSON.parse(await readFile(join(vault, DATA_PATH), "utf8"));
	}

	async function startRust(
		extraArgs: string[] = [],
		vault = rustVault,
	): Promise<RustProcess> {
		const logPath = join(workDir, `rust-${logIndex++}.log`);
		logPaths.push(logPath);
		const proc = Bun.spawn([BINARY, "run", "--vault", vault, ...extraArgs], {
			stdout: "ignore",
			stderr: Bun.file(logPath),
		});
		const running = { proc, logPath };
		if (vault === rustVault) rust = running;
		return running;
	}

	async function stopRust(target = rust): Promise<void> {
		if (!target) return;
		target.proc.kill("SIGTERM");
		await target.proc.exited;
		if (target === rust) rust = null;
	}

	async function currentLog(): Promise<string> {
		return readFile(rust!.logPath, "utf8");
	}

	async function serverRevision(): Promise<number> {
		return (await readServerSnapshot(stack)).revision;
	}

	/** Both clients and the server hold identical bytes and the same cursor. */
	async function converge(label: string, timeoutMs = 30_000): Promise<void> {
		await waitFor(
			async () => {
				await plugin.tick();
				const server = await readServerSnapshot(stack);
				const rustFiles = await collectVault(rustVault);
				const pluginFiles = await collectVault(plugin.vaultDir);
				const data = await readData();
				if (!sameFiles(rustFiles, server.files)) {
					throw new Error(`rust differs: ${diffFiles(rustFiles, server.files)}`);
				}
				if (!sameFiles(pluginFiles, server.files)) {
					throw new Error(`plugin differs: ${diffFiles(pluginFiles, server.files)}`);
				}
				if (data.revision !== server.revision || plugin.revision !== server.revision) {
					throw new Error(
						`cursors rust=${data.revision} plugin=${plugin.revision} server=${server.revision}`,
					);
				}
				return true;
			},
			{ timeoutMs, intervalMs: 250, label },
		);
	}

	async function addClient(name: string): Promise<{ id: string; secret: string }> {
		const database = new Bun.SQL(stack.databaseUrl);
		try {
			const [row] = await database<{ id: string; client_secret: string }[]>`
				INSERT INTO clients (client_name) VALUES (${name})
				RETURNING id, client_secret
			`;
			secrets.push(row!.client_secret);
			return { id: row!.id, secret: row!.client_secret };
		} finally {
			await database.close();
		}
	}

	async function pushesBy(clientId: string): Promise<number> {
		const database = new Bun.SQL(stack.databaseUrl);
		try {
			const [row] = await database<{ count: string }[]>`
				SELECT COUNT(*)::text AS count FROM files WHERE author_id = ${clientId}
			`;
			return Number(row!.count);
		} finally {
			await database.close();
		}
	}

	beforeAll(async () => {
		workDir = await mkdtemp(join(tmpdir(), "rust-client-interop-"));
		await $`test -x ${BINARY}`;
		stack = await startLocalStack(workDir);
		rustVault = join(workDir, "rust-vault");
		await mkdir(join(rustVault, PLUGIN_DIR), { recursive: true });
		await mkdir(join(rustVault, "Notes"), { recursive: true });
		await mkdir(join(rustVault, "Crabcake"), { recursive: true });
		await mkdir(join(rustVault, "Ünï"), { recursive: true });
		await writeFile(join(rustVault, "Welcome.md"), "# Hello\n");
		await writeFile(join(rustVault, "Notes/Ideas.md"), "# Ideas\n");
		await writeFile(join(rustVault, "Crabcake/Hello World.md"), "spaces in the path\n");
		await writeFile(join(rustVault, "Ünï/çødé 🦀 100%+&=?.md"), "encoding\n");
		await writeFile(join(rustVault, "pixel.bin"), BINARY_BYTES);
		await writeFile(join(rustVault, ".obsidian/app.json"), "{}");
		await writeFile(
			join(rustVault, DATA_PATH),
			JSON.stringify({
				serverUrl: stack.serverUrlLocal,
				clientName: "rust-client",
				clientSecret: "Made by server",
				revision: 0,
			}),
		);
		await chmod(join(rustVault, DATA_PATH), 0o600);
	}, 120_000);

	afterAll(async () => {
		await stopRust().catch(() => undefined);
		await plugin?.stop().catch(() => undefined);
		await stack?.stopServer().catch(() => undefined);
		if (process.env.RUST_INTEROP_KEEP !== "1") {
			await rm(workDir, { recursive: true, force: true });
		}
	}, 60_000);

	test("refuses to seed at revision 0 unless told to", async () => {
		const proc = Bun.spawn(
			[BINARY, "run", "--vault", rustVault, "--once"],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(await proc.exited).not.toBe(0);
		expect(await new Response(proc.stderr).text()).toContain("--allow-seed");
		expect((await readServerSnapshot(stack)).revision).toBe(0);
	}, 30_000);

	test("enrolls on the empty server and seeds it", async () => {
		// The previous run already enrolled, so its issued secret is on disk.
		await startRust(["--allow-seed"]);
		const server = await waitFor(
			async () => {
				const snapshot = await readServerSnapshot(stack);
				return Object.keys(snapshot.files).length === 6 ? snapshot : false;
			},
			{ timeoutMs: 30_000, label: "seed reached the server" },
		);
		expect(server.files[DATA_PATH]).toBeUndefined();
		expect(
			Buffer.from(server.files["Ünï/çødé 🦀 100%+&=?.md"]!, "base64").toString(),
		).toBe("encoding\n");
		expect(
			Buffer.from(server.files["pixel.bin"]!, "base64").equals(Buffer.from(BINARY_BYTES)),
		).toBe(true);
		const data = await readData();
		rustSecret = String(data.clientSecret);
		secrets.push(rustSecret);
		expect(rustSecret).toStartWith("obs_sync_");
		await waitFor(async () => (await readData()).revision === 6, {
			timeoutMs: 15_000,
			label: "rust cursor reached the tip via self-echo",
		});
	}, 60_000);

	test("the plugin engine pulls the vault the Rust client seeded", async () => {
		const { secret } = await addClient("plugin-client");
		const vault = join(workDir, "plugin-vault");
		await mkdir(vault, { recursive: true });
		plugin = new HeadlessPluginClient(vault, stack.serverUrlLocal, secret);
		await plugin.engine.hydrate();
		await converge("plugin caught up with the seed");
	}, 60_000);

	test("an edit on the other device appears on disk within seconds", async () => {
		await plugin.write("Notes/Ideas.md", "# Ideas\n\n- from the phone\n");
		await plugin.tick();
		const startedAt = Date.now();
		await waitFor(
			async () =>
				(await readFile(join(rustVault, "Notes/Ideas.md"), "utf8")).includes("from the phone"),
			{ timeoutMs: 15_000, intervalMs: 100, label: "remote edit on disk" },
		);
		expect(Date.now() - startedAt).toBeLessThan(6000);
		await converge("after remote edit");
	}, 60_000);

	test("a local file change reaches the other device within seconds", async () => {
		await writeFile(join(rustVault, "Welcome.md"), "# Hello\n\nedited on the box\n");
		const startedAt = Date.now();
		await waitFor(
			async () => {
				const server = await readServerSnapshot(stack);
				return Buffer.from(server.files["Welcome.md"]!, "base64")
					.toString()
					.includes("edited on the box");
			},
			{ timeoutMs: 15_000, intervalMs: 100, label: "local edit on the server" },
		);
		expect(Date.now() - startedAt).toBeLessThan(6000);
		await converge("after local edit");
		expect(await readFile(join(plugin.vaultDir, "Welcome.md"), "utf8")).toContain(
			"edited on the box",
		);
	}, 60_000);

	test("binary files round-trip byte for byte in both directions", async () => {
		const fromPlugin = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 7) % 256);
		await plugin.write("attachments/from-plugin.bin", fromPlugin);
		await plugin.tick();
		const fromRust = Uint8Array.from({ length: 300_000 }, (_, i) => (i * 13) % 256);
		await mkdir(join(rustVault, "attachments"), { recursive: true });
		await writeFile(join(rustVault, "attachments/from-rust.bin"), fromRust);
		await converge("binary files");
		expect(
			Buffer.from(await readFile(join(rustVault, "attachments/from-plugin.bin"))).equals(
				Buffer.from(fromPlugin),
			),
		).toBe(true);
		expect(
			Buffer.from(await readFile(join(plugin.vaultDir, "attachments/from-rust.bin"))).equals(
				Buffer.from(fromRust),
			),
		).toBe(true);
	}, 60_000);

	test("deletes propagate in both directions", async () => {
		await plugin.write("remove-from-plugin.md", "x");
		await writeFile(join(rustVault, "remove-from-rust.md"), "y");
		await plugin.tick();
		await converge("both files exist");
		await plugin.delete("remove-from-plugin.md");
		await rm(join(rustVault, "remove-from-rust.md"));
		await plugin.tick();
		await converge("both files deleted");
		for (const vault of [rustVault, plugin.vaultDir]) {
			const files = await collectVault(vault);
			expect(files["remove-from-plugin.md"]).toBeUndefined();
			expect(files["remove-from-rust.md"]).toBeUndefined();
		}
	}, 60_000);

	test("file and folder renames propagate as delete plus put", async () => {
		await writeFile(join(rustVault, "before.md"), "rename me\n");
		await mkdir(join(rustVault, "Folder/Nested"), { recursive: true });
		await writeFile(join(rustVault, "Folder/a.md"), "a\n");
		await writeFile(join(rustVault, "Folder/Nested/b.md"), "b\n");
		await converge("rename sources exist");
		await rename(join(rustVault, "before.md"), join(rustVault, "after.md"));
		await rename(join(rustVault, "Folder"), join(rustVault, "Moved Folder"));
		await converge("after renames");
		const files = await collectVault(plugin.vaultDir);
		expect(files["before.md"]).toBeUndefined();
		expect(files["Folder/a.md"]).toBeUndefined();
		expect(files["Folder/Nested/b.md"]).toBeUndefined();
		expect(Buffer.from(files["after.md"]!, "base64").toString()).toBe("rename me\n");
		expect(Buffer.from(files["Moved Folder/Nested/b.md"]!, "base64").toString()).toBe("b\n");
	}, 60_000);

	test("file and folder shape transitions from the other device apply", async () => {
		await plugin.write("shape", "a file\n");
		await plugin.tick();
		await converge("shape is a file");
		await plugin.delete("shape");
		await plugin.write("shape/child.md", "now a folder\n");
		await plugin.tick();
		await converge("shape is a folder");
		expect(await readFile(join(rustVault, "shape/child.md"), "utf8")).toBe("now a folder\n");
	}, 60_000);

	test("applying remote changes does not echo: the revision goes quiet", async () => {
		await plugin.write("echo-check.md", "only one revision please\n");
		await plugin.tick();
		await converge("echo-check arrived");
		const revision = await serverRevision();
		await sleep(8000);
		expect(await serverRevision()).toBe(revision);
	}, 60_000);

	test("a restart resumes without re-pushing anything", async () => {
		const revision = await serverRevision();
		await stopRust();
		await startRust();
		await waitFor(async () => (await currentLog()).includes("startup.resumed"), {
			timeoutMs: 15_000,
			label: "rust resumed",
		});
		expect(await currentLog()).toContain("queued_puts=0 queued_deletes=0");
		await sleep(5000);
		expect(await serverRevision()).toBe(revision);
		await converge("after restart");
	}, 60_000);

	test("edits made while stopped are pushed, and remote edits still land", async () => {
		await stopRust();
		await writeFile(join(rustVault, "Welcome.md"), "edited while the service was down\n");
		await writeFile(join(rustVault, "offline-new.md"), "created while down\n");
		await rm(join(rustVault, "after.md"));
		await plugin.write("remote-while-down.md", "from the phone\n");
		await plugin.tick();
		await startRust();
		await converge("after offline edits");
		const files = await collectVault(plugin.vaultDir);
		expect(Buffer.from(files["Welcome.md"]!, "base64").toString()).toBe(
			"edited while the service was down\n",
		);
		expect(files["offline-new.md"]).toBeDefined();
		expect(files["after.md"]).toBeUndefined();
		expect(await readFile(join(rustVault, "remote-while-down.md"), "utf8")).toBe(
			"from the phone\n",
		);
	}, 60_000);

	test("a local edit racing an inbound change is not overwritten", async () => {
		await stopRust();
		await writeFile(join(rustVault, "race.md"), "base\n");
		await startRust();
		await converge("race base");
		await plugin.write("race.md", "remote version\n");
		await plugin.tick();
		await writeFile(join(rustVault, "race.md"), "local version typed just now\n");
		await converge("race settled");
		// Whichever side the race went to, both devices agree and nothing is torn.
		const final = await readFile(join(rustVault, "race.md"), "utf8");
		expect(["remote version\n", "local version typed just now\n"]).toContain(final);
	}, 60_000);

	test("first run on a stale copy pushes nothing and catches up", async () => {
		await converge("before stale snapshot");
		const staleVault = join(workDir, "stale-vault");
		await cp(rustVault, staleVault, { recursive: true });
		await rm(join(staleVault, `${PLUGIN_DIR}/state`), { recursive: true, force: true });
		const client = await addClient("stale-client");
		const staleRevision = await serverRevision();
		const data = await readData(staleVault);
		await writeFile(
			join(staleVault, DATA_PATH),
			JSON.stringify({ ...data, clientName: "stale-client", clientSecret: client.secret, revision: staleRevision }),
		);

		// The server moves on after the copy was taken.
		await plugin.write("Notes/Ideas.md", "newer than the stale copy\n");
		await plugin.delete("offline-new.md");
		await plugin.write("newer-file.md", "only on the server\n");
		await plugin.tick();

		// Lost locally and never deleted on purpose. Must not become a tombstone.
		await rm(join(staleVault, "pixel.bin"));
		const tip = await serverRevision();

		const stale = await startRust([], staleVault);
		await waitFor(
			async () => (await readData(staleVault)).revision === tip,
			{ timeoutMs: 20_000, label: "stale client caught up" },
		);
		await sleep(4000);
		await stopRust(stale);

		expect(await pushesBy(client.id)).toBe(0);
		expect(await serverRevision()).toBe(tip);
		const server = await readServerSnapshot(stack);
		expect(server.files["pixel.bin"]).toBeDefined();
		expect(await readFile(join(staleVault, "Notes/Ideas.md"), "utf8")).toBe(
			"newer than the stale copy\n",
		);
		expect(await readFile(join(staleVault, "newer-file.md"), "utf8")).toBe(
			"only on the server\n",
		);
		expect(await collectVault(staleVault)).not.toHaveProperty("offline-new.md");
		const log = await readFile(stale.logPath, "utf8");
		expect(log).toContain("startup.first_run_baseline");
		expect(log).toContain("pushed=0");
		await converge("main clients still converged");
	}, 90_000);

	test("a mass delete is held until approved", async () => {
		await stopRust();
		await startRust(["--max-deletes", "5"]);
		await mkdir(join(rustVault, "bulk"), { recursive: true });
		for (let i = 0; i < 8; i++) {
			await writeFile(join(rustVault, `bulk/${i}.md`), `${i}\n`);
		}
		await converge("bulk files synced");
		const revision = await serverRevision();
		await rm(join(rustVault, "bulk"), { recursive: true });
		await waitFor(async () => (await currentLog()).includes("mass_push.halted"), {
			timeoutMs: 15_000,
			label: "guard tripped",
		});
		await sleep(4000);
		expect(await serverRevision()).toBe(revision);
		expect(Object.keys((await readServerSnapshot(stack)).files)).toContain("bulk/0.md");

		const approve = Bun.spawn(
			[BINARY, "approve-mass-push", "--vault", rustVault],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(await approve.exited).toBe(0);
		await converge("approved deletes", 60_000);
		expect(Object.keys((await readServerSnapshot(stack)).files)).not.toContain("bulk/0.md");
	}, 120_000);

	test("pauses while Obsidian runs and picks up what it did", async () => {
		await stopRust();
		await startRust();
		await converge("before fake Obsidian");
		const fake = join(workDir, "obsidian");
		await copyFile("/bin/sleep", fake);
		await chmod(fake, 0o755);
		const obsidian = Bun.spawn([fake, "60"]);
		await waitFor(async () => (await currentLog()).includes("obsidian.running"), {
			timeoutMs: 10_000,
			label: "pause",
		});
		const revisionAtPause = (await readData()).revision;

		// While paused the journals belong to the plugin. Disk edits are its job.
		await writeFile(join(rustVault, "edited-in-obsidian.md"), "the plugin pushes this\n");
		await plugin.write("arrives-after-pause.md", "from the phone\n");
		await plugin.tick();
		const tipDuringPause = await serverRevision();
		await sleep(4000);
		expect((await readData()).revision).toBe(revisionAtPause);
		expect(await serverRevision()).toBe(tipDuringPause);
		expect(await collectVault(rustVault)).not.toHaveProperty("arrives-after-pause.md");
		expect((await readServerSnapshot(stack)).files["edited-in-obsidian.md"]).toBeUndefined();

		obsidian.kill();
		await obsidian.exited;
		await waitFor(
			async () =>
				(await readFile(join(rustVault, "arrives-after-pause.md"), "utf8").catch(() => "")) ===
				"from the phone\n",
			{ timeoutMs: 20_000, label: "resumed after Obsidian exit" },
		);
		// The handover pushes nothing: that edit was the plugin's responsibility.
		await sleep(3000);
		expect((await readServerSnapshot(stack)).files["edited-in-obsidian.md"]).toBeUndefined();
		// Clean up so the convergence check below is about real differences.
		await rm(join(rustVault, "edited-in-obsidian.md"));
		await converge("after handover");
	}, 90_000);

	test("rename-client keeps auth working where a bare data.json edit would not", async () => {
		await stopRust();
		await plugin.tick();
		const revision = await serverRevision();
		const before = await readData();

		// A bare edit of data.json breaks /auth: name and secret must both match.
		await writeFile(
			join(rustVault, DATA_PATH),
			JSON.stringify({ ...before, clientName: "crabcake" }),
		);
		const broken = await $`${BINARY} status --vault ${rustVault}`.text();
		expect(broken).toContain("auth:            FAILED");
		await writeFile(join(rustVault, DATA_PATH), JSON.stringify(before));

		const renamed = await $`${BINARY} rename-client crabcake --vault ${rustVault}`.text();
		expect(renamed).toContain("crabcake");
		expect((await readData()).clientName).toBe("crabcake");
		const status = await $`${BINARY} status --vault ${rustVault}`.text();
		expect(status).toContain("client name:     crabcake");
		expect(status).toContain("auth:            ok");
		expect(await serverRevision()).toBe(revision);
		await startRust();
		await converge("after rename");
	}, 60_000);

	test("verify agrees with the server and secrets stay out of the logs", async () => {
		await converge("before verify");
		const verify = await $`${BINARY} verify --vault ${rustVault}`.text();
		expect(verify).toContain("missing on disk: 0");
		expect(verify).toContain("differ on disk:  0");
		const single = await $`${BINARY} verify --vault ${rustVault} --path ${"Crabcake/Hello World.md"}`.text();
		expect(single).toContain("in sync:         true");
		await stopRust();
		for (const path of logPaths) {
			const log = await readFile(path, "utf8").catch(() => "");
			for (const secret of secrets) {
				expect(log).not.toContain(secret);
			}
		}
		// data.json keeps its mode through every rewrite.
		const mode = (await $`stat -c %a ${join(rustVault, DATA_PATH)}`.text()).trim();
		expect(mode).toBe("600");
	}, 60_000);
});
