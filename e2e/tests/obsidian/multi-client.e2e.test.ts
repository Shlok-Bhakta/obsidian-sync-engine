import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { $ } from "bun";
import { ObsidianClient } from "../../src/obsidian-client";
import { startStack, type Stack } from "../../src/stack";
import {
	SAMPLE_CONTENT_PATHS,
	installPlugin,
	writeObsidianConfig,
} from "../../src/fixtures";
import { waitFor, waitForFile, sleep } from "../../src/wait";

const RUN_ROOT = join(import.meta.dir, "../../.run");

/**
 * Full multi-client e2e against real Obsidian (linuxserver image) driven only
 * via `obsidian-cli` — no Playwright / GUI automation.
 */
describe("obsidian multi-client e2e", () => {
	let stack: Stack;
	let clientA: ObsidianClient;
	let clientB: ObsidianClient;

	beforeAll(async () => {
		await mkdir(RUN_ROOT, { recursive: true });
		stack = await startStack({ wipe: true });

		const stamp = Date.now();
		const aConfig = join(RUN_ROOT, `client-a-${stamp}`);
		const bConfig = join(RUN_ROOT, `client-b-${stamp}`);

		clientA = new ObsidianClient({
			name: "vault-a",
			configHostDir: aConfig,
			httpPort: 13100,
			httpsPort: 13101,
		});
		clientB = new ObsidianClient({
			name: "vault-b",
			configHostDir: bConfig,
			httpPort: 13200,
			httpsPort: 13201,
		});

		await clientA.prepareFreshSampleVault();
		await clientA.start();
		await clientA.configurePlugin({
			serverUrl: stack.serverUrl,
			clientName: "e2e-client-a",
			setupToken: stack.bootstrapToken,
		});
	}, 300_000);

	afterAll(async () => {
		await clientB?.stop().catch(() => undefined);
		await clientA?.stop().catch(() => undefined);
		await stack?.stopServer().catch(() => undefined);
	}, 120_000);
	test("E1: fresh server auth + seed uploads vault content", async () => {
		await clientA.authenticate();
		const settings = await clientA.readSettings();
		expect(settings.clientSecret).not.toBe("Made by server");
		expect(settings.clientSecret.length).toBeGreaterThan(8);

		await clientA.seed();

		await waitFor(
			async () => {
				await clientA.forceTick();
				const s = await clientA.readSettings();
				const outbox = Bun.file(clientA.outboxPath());
				const depth = (await outbox.exists())
					? (await outbox.text()).split("\n").filter(Boolean).length
					: 0;
				return s.revision > 0 && depth === 0 ? s : false;
			},
			{
				timeoutMs: 120_000,
				intervalMs: 1000,
				label: "client A outbox drained after seed",
			},
		);

		const auth = (await clientA.readSettings()).clientSecret;
		for (const path of SAMPLE_CONTENT_PATHS) {
			const res = await fetch(
				`${stack.serverUrlLocal}/files?path=${encodeURIComponent(path)}`,
				{ headers: { Authorization: auth } },
			);
			expect(res.status).toBe(200);
			expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
		}
	}, 180_000);

	test("E2: bootstrap.zip opens as client B at tip with empty first poll", async () => {
		const zipPath = join(RUN_ROOT, "bootstrap.zip");
		const denied = await fetch(`${stack.serverUrlLocal}/bootstrap.zip`);
		expect(denied.status).toBe(401);

		const res = await fetch(`${stack.serverUrlLocal}/bootstrap.zip`, {
			headers: { Authorization: `Bearer ${stack.bootstrapToken}` },
		});
		expect(res.ok).toBe(true);
		await writeFile(zipPath, Buffer.from(await res.arrayBuffer()));

		await rm(clientB.vaultHostDir, { recursive: true, force: true });
		await mkdir(clientB.vaultHostDir, { recursive: true });
		await mkdir(clientB.configHostDir, { recursive: true });
		await $`unzip -qo ${zipPath} -d ${clientB.vaultHostDir}`;

		// Ensure plugin binaries exist; preserve bootstrap-stamped data.json.
		const stamped = await readFile(clientB.pluginDataPath(), "utf8").catch(
			() => null,
		);
		await installPlugin(clientB.vaultHostDir);
		if (stamped) {
			await writeFile(clientB.pluginDataPath(), stamped);
		}

		await writeObsidianConfig(
			clientB.configHostDir,
			clientB.vaultContainerPath,
			clientB.name,
		);

		const bootData = JSON.parse(
			await readFile(clientB.pluginDataPath(), "utf8"),
		) as { revision: number; clientSecret: string; clientName: string };
		expect(bootData.revision).toBeGreaterThan(0);
		expect(bootData.clientSecret).toBeTruthy();

		await clientB.start();
		await clientB.configurePlugin({
			serverUrl: stack.serverUrl,
			clientName: bootData.clientName,
			clientSecret: bootData.clientSecret,
			revision: bootData.revision,
		});

		const before = await clientB.readSettings();
		await clientB.forceTick();
		await sleep(500);
		await clientB.forceTick();
		const after = await clientB.readSettings();

		expect(after.revision).toBeGreaterThanOrEqual(before.revision);
		for (const path of SAMPLE_CONTENT_PATHS) {
			expect(await Bun.file(clientB.vaultPath(path)).exists()).toBe(true);
		}
	}, 180_000);

	test("E3: edit on A appears on B within poll window", async () => {
		await clientA.createNote("SharedNote", "# Shared\\nfrom A");
		await sleep(1200);
		await clientA.forceTick();
		await clientA.forceTick();

		await waitFor(
			async () => {
				await clientB.forceTick();
				const file = Bun.file(clientB.vaultPath("SharedNote.md"));
				if (!(await file.exists())) return false;
				const text = await file.text();
				return text.includes("from A") ? text : false;
			},
			{ timeoutMs: 60_000, intervalMs: 1000, label: "SharedNote.md on B" },
		);
	}, 120_000);

	test("E4: delete on A removes file on B", async () => {
		await clientA.createNote("ToDelete", "temporary");
		await sleep(1200);
		await clientA.forceTick();
		await clientA.forceTick();
		await waitFor(
			async () => {
				await clientB.forceTick();
				return (await Bun.file(clientB.vaultPath("ToDelete.md")).exists())
					? true
					: false;
			},
			{ timeoutMs: 60_000, intervalMs: 1000, label: "ToDelete.md on B" },
		);

		await clientA.deleteNote("ToDelete.md");
		await sleep(1200);
		await clientA.forceTick();
		await clientA.forceTick();

		await waitFor(
			async () => {
				await clientB.forceTick();
				return !(await Bun.file(clientB.vaultPath("ToDelete.md")).exists());
			},
			{ timeoutMs: 60_000, label: "ToDelete.md gone on B" },
		);
	}, 120_000);

	test("E5: self-echo does not duplicate content on A", async () => {
		await clientA.appendNote("Welcome.md", "\\n<!-- e5 -->");
		await sleep(1200);
		await clientA.forceTick();
		await clientA.forceTick();
		await sleep(2000);
		await clientA.forceTick();

		const after = await Bun.file(clientA.vaultPath("Welcome.md")).text();
		expect(after).toContain("<!-- e5 -->");
		expect(after.split("<!-- e5 -->").length - 1).toBe(1);
		await waitFor(
			async () => {
				await clientB.forceTick();
				const remote = await Bun.file(clientB.vaultPath("Welcome.md")).text();
				return remote.includes("<!-- e5 -->");
			},
			{ timeoutMs: 60_000, label: "self-echo edit converged to B" },
		);
	}, 90_000);

	test("E6: offline edits drain after reconnect", async () => {
		await stack.stopServer();

		await clientA.createNote("OfflineNote", "written while offline");
		await sleep(1500);

		stack = await startStack({ wipe: false, reuse: stack });

		const s = await clientA.readSettings();
		await clientA.configurePlugin({
			serverUrl: stack.serverUrl,
			clientName: s.clientName,
			clientSecret: s.clientSecret,
			revision: s.revision,
		});

		await sleep(1200);
		await clientA.forceTick();
		await clientA.forceTick();

		await waitFor(
			async () => {
				await clientB.forceTick();
				return Bun.file(clientB.vaultPath("OfflineNote.md")).exists();
			},
			{
				timeoutMs: 90_000,
				label: "OfflineNote.md synced to B after reconnect",
			},
		);
	}, 180_000);

	test("E7: binary + html + nested paths round-trip to B", async () => {
		for (const path of SAMPLE_CONTENT_PATHS) {
			const aBytes = await Bun.file(clientA.vaultPath(path)).arrayBuffer();
			const bBytes = await Bun.file(clientB.vaultPath(path)).arrayBuffer();
			expect(new Uint8Array(bBytes)).toEqual(new Uint8Array(aBytes));
		}
	}, 30_000);

	test("E8: rapid put then delete does not permanently stall B", async () => {
		await clientA.createNote("RaceFile", "will delete soon");
		await sleep(200);
		await clientA.deleteNote("RaceFile.md");
		await sleep(1200);
		await clientA.forceTick();
		await clientA.forceTick();

		const revBefore = (await clientB.readSettings()).revision;
		await waitFor(
			async () => {
				await clientB.forceTick();
				const s = await clientB.readSettings();
				const missing = !(await Bun.file(
					clientB.vaultPath("RaceFile.md"),
				).exists());
				return missing && s.revision >= revBefore ? s : false;
			},
			{ timeoutMs: 90_000, label: "B advances past race put/delete" },
		);

		expect(await Bun.file(clientB.vaultPath("RaceFile.md")).exists()).toBe(
			false,
		);
	}, 120_000);

	test("E9: remote directory and file shape transitions converge", async () => {
		const auth = (await clientA.readSettings()).clientSecret;
		const upload = async (path: string, body: string) => {
			const response = await fetch(`${stack.serverUrlLocal}/files`, {
				method: "POST",
				headers: {
					Authorization: auth,
					"X-Obsidian-Path": encodeURIComponent(path),
				},
				body,
			});
			expect(response.status).toBe(200);
		};

		await upload("shape/child.md", "nested");
		await waitFor(
			async () => {
				await clientB.forceTick();
				return Bun.file(clientB.vaultPath("shape/child.md")).exists();
			},
			{ timeoutMs: 60_000, label: "nested shape reaches B" },
		);

		await upload("shape", "now a file");
		await waitFor(
			async () => {
				await clientB.forceTick();
				const file = Bun.file(clientB.vaultPath("shape"));
				return (await file.exists()) && (await file.text()) === "now a file";
			},
			{ timeoutMs: 60_000, label: "directory becomes file on B" },
		);
		expect(await Bun.file(clientB.vaultPath("shape/child.md")).exists()).toBe(
			false,
		);

		await upload("shape/child.md", "nested again");
		await waitFor(
			async () => {
				await clientB.forceTick();
				const child = Bun.file(clientB.vaultPath("shape/child.md"));
				return (await child.exists()) && (await child.text()) === "nested again";
			},
			{ timeoutMs: 60_000, label: "file becomes directory on B" },
		);
	}, 180_000);
});
