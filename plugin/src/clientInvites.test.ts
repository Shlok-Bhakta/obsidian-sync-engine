import { describe, expect, test } from "bun:test";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { requestClientInvite } from "./clientInvites";
import { FakeLogger } from "./logger";

describe("requestClientInvite", () => {
	test("creates an authenticated invite and returns its five-minute link", async () => {
		let captured: RequestUrlParam | undefined;
		const logger = new FakeLogger();
		const invite = await requestClientInvite({
			serverUrl: "https://sync.example/",
			clientSecret: "obs_sync_secret",
			request: async (options) => {
				captured = options;
				return {
					status: 201,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: {
						url: "https://sync.example/client-invites/abc",
						expiresAt: "2030-01-01T00:05:00.000Z",
					},
					text: "",
				} satisfies RequestUrlResponse;
			},
			logger,
		});

		expect(captured).toMatchObject({
			url: "https://sync.example/client-invites",
			method: "POST",
			headers: { Authorization: "obs_sync_secret" },
			throw: false,
		});
		expect(invite.url).toBe("https://sync.example/client-invites/abc");
		expect(logger.entries.map(({ event }) => event)).toEqual([
			"request.started",
			"request.completed",
			"response.validated",
		]);
		expect(JSON.stringify(logger.entries)).not.toContain("obs_sync_secret");
	});

	test("surfaces a rejected request without exposing the secret", async () => {
		let error: unknown;
		try {
			await requestClientInvite({
				serverUrl: "https://sync.example",
				clientSecret: "do-not-print-me",
				request: async () => ({
					status: 401,
					headers: {},
					arrayBuffer: new ArrayBuffer(0),
					json: { error: "Unauthorized" },
					text: '{"error":"Unauthorized"}',
				} satisfies RequestUrlResponse),
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			"Could not create client package (401)",
		);
	});
});
