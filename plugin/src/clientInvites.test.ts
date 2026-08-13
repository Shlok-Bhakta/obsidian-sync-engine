import { describe, expect, test } from "bun:test";
import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
	requestClientInvite,
	requestClientInviteStatus,
} from "./clientInvites";
import { FakeLogger } from "./logger";

const buildId = "550e8400-e29b-41d4-a716-446655440000";

function response(status: number, json: unknown): RequestUrlResponse {
	return {
		status,
		headers: {},
		arrayBuffer: new ArrayBuffer(0),
		json,
		text: JSON.stringify(json),
	};
}

describe("requestClientInvite", () => {
	test("starts a build, polls progress, and returns the ready link", async () => {
		const requests: RequestUrlParam[] = [];
		const progress: number[] = [];
		const statuses = [
			{
				buildId,
				status: "building",
				progress: {
					phase: "preparing",
					processedFiles: 0,
					totalFiles: 0,
					percent: 0,
					estimatedSecondsRemaining: null,
				},
			},
			{
				buildId,
				status: "building",
				progress: {
					phase: "archiving",
					processedFiles: 40,
					totalFiles: 100,
					percent: 39,
					estimatedSecondsRemaining: 8,
				},
			},
			{
				buildId,
				status: "ready",
				progress: {
					phase: "finalizing",
					processedFiles: 100,
					totalFiles: 100,
					percent: 100,
					estimatedSecondsRemaining: 0,
				},
				invite: {
					url: "https://sync.example/client-invites/abc",
					expiresAt: "2030-01-01T00:05:00.000Z",
				},
			},
		];
		let responseIndex = 0;
		const logger = new FakeLogger();
		const invite = await requestClientInvite({
			serverUrl: "https://sync.example/",
			clientSecret: "obs_sync_secret",
			request: async (options) => {
				requests.push(options);
				const status = responseIndex === 0 ? 202 : 200;
				return response(status, statuses[responseIndex++]);
			},
			logger,
			onProgress: (update) => progress.push(update.percent),
			pollIntervalMs: 0,
			sleep: async () => undefined,
		});

		expect(requests).toHaveLength(3);
		expect(requests[0]).toMatchObject({
			url: "https://sync.example/client-invite-builds",
			method: "POST",
			headers: { Authorization: "obs_sync_secret" },
			throw: false,
		});
		expect(requests[1]).toMatchObject({
			url: `https://sync.example/client-invite-builds/${buildId}`,
			method: "GET",
		});
		expect(requests[2]).toMatchObject({
			url: `https://sync.example/client-invite-builds/${buildId}`,
			method: "GET",
		});
		expect(progress).toEqual([0, 39, 100]);
		expect(invite.url).toBe("https://sync.example/client-invites/abc");
		expect(JSON.stringify(logger.entries)).not.toContain("obs_sync_secret");
	});

	test("surfaces a failed background build", async () => {
		const error = await requestClientInvite({
			serverUrl: "https://sync.example",
			clientSecret: "obs_sync_secret",
			request: async () =>
				response(202, {
					buildId,
					status: "failed",
					progress: {
						phase: "archiving",
						processedFiles: 2,
						totalFiles: 10,
						percent: 22,
						estimatedSecondsRemaining: null,
					},
					error: "Archive build failed. Try again.",
				}),
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Archive build failed. Try again.");
	});

	test("falls back to the synchronous route on an older server", async () => {
		const paths: string[] = [];
		const invite = await requestClientInvite({
			serverUrl: "https://sync.example/",
			clientSecret: "obs_sync_secret",
			request: async (options) => {
				paths.push(options.url);
				if (paths.length === 1) return response(404, { error: "Not found" });
				return response(201, {
					url: "https://sync.example/client-invites/legacy",
					expiresAt: "2030-01-01T00:05:00.000Z",
				});
			},
		});

		expect(paths).toEqual([
			"https://sync.example/client-invite-builds",
			"https://sync.example/client-invites",
		]);
		expect(invite.url).toEndWith("/legacy");
	});

	test("surfaces a rejected start without exposing the secret", async () => {
		const logger = new FakeLogger();
		const error = await requestClientInvite({
			serverUrl: "https://sync.example",
			clientSecret: "do-not-print-me",
			request: async () => response(401, { error: "Unauthorized" }),
			logger,
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			"Could not start client package (401)",
		);
		expect(JSON.stringify(logger.entries)).not.toContain("do-not-print-me");
	});
});

describe("requestClientInviteStatus", () => {
	test("pulls the remaining lifetime from the server", async () => {
		let requestOptions: RequestUrlParam | undefined;
		const status = await requestClientInviteStatus({
			invite: {
				url: "https://sync.example/client-invites/abc",
				expiresAt: "2030-01-01T00:05:00.000Z",
			},
			clientSecret: "obs_sync_secret",
			request: async (options) => {
				requestOptions = options;
				return response(200, {
					status: "available",
					expiresAt: "2030-01-01T00:05:00.000Z",
					remainingSeconds: 243,
				});
			},
		});

		expect(requestOptions).toMatchObject({
			url: "https://sync.example/client-invite-status",
			method: "GET",
			headers: {
				Authorization: "obs_sync_secret",
				"X-Client-Invite-Token": "abc",
			},
			throw: false,
		});
		expect(status).toEqual({
			status: "available",
			expiresAt: "2030-01-01T00:05:00.000Z",
			remainingSeconds: 243,
		});
	});

	test("reports a consumed or expired link as unavailable", async () => {
		const status = await requestClientInviteStatus({
			invite: {
				url: "https://sync.example/client-invites/abc",
				expiresAt: "2030-01-01T00:05:00.000Z",
			},
			clientSecret: "obs_sync_secret",
			request: async () =>
				response(200, { status: "unavailable", remainingSeconds: 0 }),
		});

		expect(status).toEqual({ status: "unavailable", remainingSeconds: 0 });
	});

	test("rejects invalid server status without logging the secret", async () => {
		const logger = new FakeLogger();
		const error = await requestClientInviteStatus({
			invite: {
				url: "https://sync.example/client-invites/abc",
				expiresAt: "2030-01-01T00:05:00.000Z",
			},
			clientSecret: "do-not-print-me",
			request: async () =>
				response(200, {
					status: "available",
					expiresAt: "not-a-date",
					remainingSeconds: -1,
				}),
			logger,
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe(
			"Server returned an invalid client link status",
		);
		expect(JSON.stringify(logger.entries)).not.toContain("do-not-print-me");
		expect(JSON.stringify(logger.entries)).not.toContain("abc");
	});
});
