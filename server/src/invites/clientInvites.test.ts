import { sql } from "bun";
import { describe, expect, it } from "bun:test";
import { unzipSync } from "fflate";
import { Hono } from "hono";
import {
	CLIENT_DATA_PATH,
	clientConfigSchema,
	clientInviteBuildSchema,
	clientInviteSchema,
	clientInviteStatusSchema,
} from "obsidian-sync-protocol";
import { FakeLogger } from "../logger";
import { ObjectStore } from "../object/object_store";
import { createClientFixture, createTestApp } from "../test/fixtures";
import {
	CLIENT_INVITE_LIFETIME_MS,
	registerClientInviteRoutes,
} from "./clientInvites";
import { registerClientInviteBuildRoutes } from "./clientInviteBuilds";

const decoder = new TextDecoder();

async function createInvite(app: ReturnType<typeof createTestApp>, secret: string) {
	const response = await app.request("https://sync.example/client-invites", {
		method: "POST",
		headers: { Authorization: secret },
	});
	expect(response.status).toBe(201);
	return clientInviteSchema.parse(await response.json());
}

function inviteToken(inviteUrl: string): string {
	const token = new URL(inviteUrl).pathname.split("/").filter(Boolean).at(-1);
	if (!token) throw new Error("invite URL did not contain a token");
	return token;
}

async function requestInviteStatus(
	app: Hono,
	inviteUrl: string,
	secret?: string,
): Promise<Response> {
	const headers: Record<string, string> = {
		"X-Client-Invite-Token": inviteToken(inviteUrl),
	};
	if (secret) headers.Authorization = secret;
	return await app.request("https://sync.example/client-invite-status", { headers });
}

describe("client invite packages", () => {
	it("requires an authenticated client to create an invite", async () => {
		const app = createTestApp();
		const response = await app.request("https://sync.example/client-invites", {
			method: "POST",
		});
		expect(response.status).toBe(401);
	});

	it("builds an archive in the background and exposes authenticated progress", async () => {
		const owner = await createClientFixture({ client_name: "polling-owner" });
		const other = await createClientFixture({ client_name: "other-client" });
		const store = new ObjectStore();
		await store.upload({
			path: "notes/safety-check.md",
			content: "archive preserves this note",
			id: owner.id,
		});
		const createArchive = store.createClientArchive.bind(store);
		let releaseArchive!: () => void;
		const archiveReleased = new Promise<void>((resolve) => {
			releaseArchive = resolve;
		});
		let reportProgress!: () => void;
		const progressReported = new Promise<void>((resolve) => {
			reportProgress = resolve;
		});
		let currentTimeMs = 1_000;
		store.createClientArchive = async (options) => {
			currentTimeMs = 5_000;
			options.onProgress?.({
				phase: "archiving",
				processedFiles: 25,
				totalFiles: 100,
			});
			reportProgress();
			await archiveReleased;
			return createArchive(options);
		};
		const app = registerClientInviteRoutes(new Hono(), store);
		registerClientInviteBuildRoutes(
			app,
			store,
			undefined,
			undefined,
			undefined,
			() => currentTimeMs,
		);
		const unauthorized = await app.request(
			"https://sync.example/client-invite-builds",
			{ method: "POST" },
		);
		expect(unauthorized.status).toBe(401);

		const start = await app.request("https://sync.example/client-invite-builds", {
			method: "POST",
			headers: { Authorization: owner.client_secret },
		});
		expect(start.status).toBe(202);
		const started = clientInviteBuildSchema.parse(await start.json());
		expect(started.status).toBe("building");
		await progressReported;

		const active = await app.request(
			`https://sync.example/client-invite-builds/${started.buildId}`,
			{ headers: { Authorization: owner.client_secret } },
		);
		const building = clientInviteBuildSchema.parse(await active.json());
		expect(building).toMatchObject({
			status: "building",
			progress: {
				phase: "archiving",
				processedFiles: 25,
				totalFiles: 100,
				percent: 26,
			},
		});
		expect(building.progress.estimatedSecondsRemaining).toBeGreaterThan(0);

		const duplicateStart = await app.request(
			"https://sync.example/client-invite-builds",
			{ method: "POST", headers: { Authorization: owner.client_secret } },
		);
		expect((await duplicateStart.json() as { buildId: string }).buildId).toBe(
			started.buildId,
		);
		const hidden = await app.request(
			`https://sync.example/client-invite-builds/${started.buildId}`,
			{ headers: { Authorization: other.client_secret } },
		);
		expect(hidden.status).toBe(404);

		releaseArchive();
		let readyResponse: Response | undefined;
		for (let attempt = 0; attempt < 50; attempt++) {
			readyResponse = await app.request(
				`https://sync.example/client-invite-builds/${started.buildId}`,
				{ headers: { Authorization: owner.client_secret } },
			);
			const body = clientInviteBuildSchema.parse(await readyResponse.clone().json());
			if (body.status === "ready") break;
			await Bun.sleep(10);
		}
		const ready = clientInviteBuildSchema.parse(await readyResponse?.json());
		expect(ready.status).toBe("ready");
		if (ready.status !== "ready") throw new Error("archive did not become ready");
		expect(ready.progress).toMatchObject({
			phase: "finalizing",
			percent: 100,
			estimatedSecondsRemaining: 0,
		});
		expect(new URL(ready.invite.url).origin).toBe("https://sync.example");
		const unauthorizedStatus = await requestInviteStatus(app, ready.invite.url);
		expect(unauthorizedStatus.status).toBe(401);
		const missingTokenStatus = await app.request(
			"https://sync.example/client-invite-status",
			{ headers: { Authorization: owner.client_secret } },
		);
		expect(missingTokenStatus.status).toBe(400);
		const availableStatusResponse = await requestInviteStatus(
			app,
			ready.invite.url,
			owner.client_secret,
		);
		expect(availableStatusResponse.status).toBe(200);
		const availableStatus = clientInviteStatusSchema.parse(
			await availableStatusResponse.json(),
		);
		expect(availableStatus.status).toBe("available");
		expect(availableStatus.remainingSeconds).toBeGreaterThanOrEqual(299);
		expect(availableStatus.remainingSeconds).toBeLessThanOrEqual(300);
		const download = await app.request(`${ready.invite.url}/download`, {
			method: "POST",
		});
		expect(download.status).toBe(200);
		const archive = unzipSync(new Uint8Array(await download.arrayBuffer()));
		expect(decoder.decode(archive["notes/safety-check.md"])).toBe(
			"archive preserves this note",
		);
		const config = clientConfigSchema.parse(
			JSON.parse(decoder.decode(archive[CLIENT_DATA_PATH])),
		);
		expect(config.revision).toBe(1);
		expect(config.serverUrl).toBe("https://sync.example");
		const consumedStatusResponse = await requestInviteStatus(
			app,
			ready.invite.url,
			owner.client_secret,
		);
		expect(
			clientInviteStatusSchema.parse(await consumedStatusResponse.json()),
		).toEqual({ status: "unavailable", remainingSeconds: 0 });
	});

	it("reports background archive failures without leaking details or orphaning a client", async () => {
		const owner = await createClientFixture({ client_name: "failed-build-owner" });
		const store = new ObjectStore();
		store.createClientArchive = async () => {
			throw new Error("private archive failure detail");
		};
		const app = registerClientInviteBuildRoutes(new Hono(), store);
		const start = await app.request("https://sync.example/client-invite-builds", {
			method: "POST",
			headers: { Authorization: owner.client_secret },
		});
		const started = clientInviteBuildSchema.parse(await start.json());

		let failed: ReturnType<typeof clientInviteBuildSchema.parse> | undefined;
		for (let attempt = 0; attempt < 50; attempt++) {
			const response = await app.request(
				`https://sync.example/client-invite-builds/${started.buildId}`,
				{ headers: { Authorization: owner.client_secret } },
			);
			failed = clientInviteBuildSchema.parse(await response.json());
			if (failed.status === "failed") break;
			await Bun.sleep(10);
		}
		expect(failed).toMatchObject({
			status: "failed",
			error: "Archive build failed. Try again.",
		});
		expect(JSON.stringify(failed)).not.toContain("private archive failure detail");
		const [{ count }] = await sql<{ count: string }[]>`
			SELECT COUNT(*)::text AS count FROM clients
		`;
		expect(Number(count)).toBe(1);
	});

	it("creates a five-minute preview-safe link and consumes its ZIP once", async () => {
		const owner = await createClientFixture({ client_name: "owner" });
		const app = createTestApp();
		await app.request("https://sync.example/files", {
			method: "POST",
			headers: {
				Authorization: owner.client_secret,
				"X-Obsidian-Path": encodeURIComponent("note.md"),
			},
			body: "hello",
		});
		await app.request("https://sync.example/files", {
			method: "POST",
			headers: {
				Authorization: owner.client_secret,
				"X-Obsidian-Path": encodeURIComponent(".obsidian/workspace.json"),
			},
			body: '{"layout":"owner"}',
		});

		const invite = await createInvite(app, owner.client_secret);
		expect(new URL(invite.url).origin).toBe("https://sync.example");
		const lifetime = new Date(invite.expiresAt).getTime() - Date.now();
		expect(lifetime).toBeGreaterThan(299_000);
		expect(lifetime).toBeLessThanOrEqual(300_000);

		for (let preview = 0; preview < 2; preview++) {
			const landing = await app.request(invite.url);
			expect(landing.status).toBe(200);
			expect(landing.headers.get("Content-Type")).toContain("text/html");
			expect(await landing.text()).toContain("Download ZIP");
		}

		const download = await app.request(`${invite.url}/download`, {
			method: "POST",
		});
		expect(download.status).toBe(200);
		expect(download.headers.get("Content-Type")).toContain("application/zip");
		const archive = unzipSync(new Uint8Array(await download.arrayBuffer()));
		expect(decoder.decode(archive["note.md"])).toBe("hello");
		expect(decoder.decode(archive[".obsidian/workspace.json"])).toBe(
			'{"layout":"owner"}',
		);
		const settings = clientConfigSchema.parse(
			JSON.parse(decoder.decode(archive[CLIENT_DATA_PATH])),
		);
		expect(settings.serverUrl).toBe("https://sync.example");
		expect(settings.clientName).not.toBe(owner.client_name);
		expect(settings.clientSecret).toStartWith("obs_sync_");
		expect(settings.revision).toBe(2);

		const authenticated = await app.request(
			"https://sync.example/files?path=note.md",
			{ headers: { Authorization: settings.clientSecret } },
		);
		expect(authenticated.status).toBe(200);

		const replay = await app.request(`${invite.url}/download`, {
			method: "POST",
		});
		expect(replay.status).toBe(410);
	});

	it("starts the five-minute lifetime after the archive finishes building", async () => {
		const owner = await createClientFixture({ client_name: "slow-vault-owner" });
		const buildStartedAt = Date.parse("2026-08-11T00:00:00.000Z");
		const archiveCompletedAt = buildStartedAt + 4 * 60 * 1000;
		const clockReadings = [buildStartedAt, archiveCompletedAt];
		let statusTime = archiveCompletedAt;
		const now = () => new Date(clockReadings.shift() ?? statusTime);
		const logger = new FakeLogger();
		const app = registerClientInviteRoutes(
			new Hono(),
			new ObjectStore(logger),
			undefined,
			logger,
			now,
		);

		const response = await app.request("https://sync.example/client-invites", {
			method: "POST",
			headers: { Authorization: owner.client_secret },
		});
		expect(response.status).toBe(201);
		const invite = clientInviteSchema.parse(await response.json());

		expect(new Date(invite.expiresAt).getTime()).toBe(
			archiveCompletedAt + CLIENT_INVITE_LIFETIME_MS,
		);
		expect(new Date(invite.expiresAt).getTime() - buildStartedAt).toBe(
			9 * 60 * 1000,
		);
		expect(clockReadings).toHaveLength(0);

		statusTime += 2 * 60 * 1000;
		const activeStatus = clientInviteStatusSchema.parse(
			await (await requestInviteStatus(
				app,
				invite.url,
				owner.client_secret,
			)).json(),
		);
		expect(activeStatus).toMatchObject({
			status: "available",
			remainingSeconds: 180,
		});

		statusTime = archiveCompletedAt + CLIENT_INVITE_LIFETIME_MS;
		const expiredStatus = clientInviteStatusSchema.parse(
			await (await requestInviteStatus(
				app,
				invite.url,
				owner.client_secret,
			)).json(),
		);
		expect(expiredStatus).toEqual({
			status: "unavailable",
			remainingSeconds: 0,
		});
	});

	it("allows only one concurrent download", async () => {
		const owner = await createClientFixture({ client_name: "owner" });
		const app = createTestApp();
		const invite = await createInvite(app, owner.client_secret);

		const responses = await Promise.all([
			app.request(`${invite.url}/download`, { method: "POST" }),
			app.request(`${invite.url}/download`, { method: "POST" }),
		]);
		expect(responses.map(({ status }) => status).sort()).toEqual([200, 410]);
	});

	it("deletes an expired package and its unused client credential", async () => {
		const owner = await createClientFixture({ client_name: "owner" });
		const app = createTestApp();
		const invite = await createInvite(app, owner.client_secret);
		const [pending] = await sql<{ client_id: string }[]>`
			SELECT client_id FROM client_invites
		`;
		await sql`UPDATE client_invites SET expires_at = NOW() - INTERVAL '1 second'`;

		const landing = await app.request(invite.url);
		expect(landing.status).toBe(410);
		expect(
			Number((await sql<{ count: string }[]>`
				SELECT COUNT(*)::text AS count FROM client_invites
			`)[0].count),
		).toBe(0);
		expect(
			Number((await sql<{ count: string }[]>`
				SELECT COUNT(*)::text AS count FROM clients WHERE id = ${pending.client_id}
			`)[0].count),
		).toBe(0);
	});
});
