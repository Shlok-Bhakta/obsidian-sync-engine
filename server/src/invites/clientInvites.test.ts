import { sql } from "bun";
import { describe, expect, it } from "bun:test";
import { unzipSync } from "fflate";
import {
	CLIENT_DATA_PATH,
	clientConfigSchema,
	clientInviteSchema,
} from "obsidian-sync-protocol";
import { createClientFixture, createTestApp } from "../test/fixtures";

const decoder = new TextDecoder();

async function createInvite(app: ReturnType<typeof createTestApp>, secret: string) {
	const response = await app.request("https://sync.example/client-invites", {
		method: "POST",
		headers: { Authorization: secret },
	});
	expect(response.status).toBe(201);
	return clientInviteSchema.parse(await response.json());
}

describe("client invite packages", () => {
	it("requires an authenticated client to create an invite", async () => {
		const app = createTestApp();
		const response = await app.request("https://sync.example/client-invites", {
			method: "POST",
		});
		expect(response.status).toBe(401);
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
