import { describe, expect, test } from "bun:test";
import {
	CLIENT_DATA_PATH,
	clientConfigSchema,
	clientInviteSchema,
	deserializeInboxNdjson,
	isCanonicalSyncPath,
	serializeInboxNdjson,
} from "./index";

describe("canonical sync paths", () => {
	test.each([
		"notes/foo.md",
		"foo.md",
		".obsidian/workspace.json",
	])("accepts %s", (path) => {
		expect(isCanonicalSyncPath(path)).toBe(true);
	});

	test.each([
		"",
		"/etc/passwd",
		"C:/Windows/system32",
		"../x",
		"a/../../etc/passwd",
		"a/./b",
		"a\\b",
		"a\0b",
		"a/b/",
		"a//b",
		CLIENT_DATA_PATH,
	])("rejects %s", (path) => {
		expect(isCanonicalSyncPath(path)).toBe(false);
	});
});

describe("HTTP contracts", () => {
	test("round-trips inbox operations as newline-terminated NDJSON", () => {
		const operations = [
			{ rev: 1, op: "put" as const, path: "a.md" },
			{ rev: 2, op: "delete" as const, path: "b.md" },
		];
		expect(deserializeInboxNdjson(serializeInboxNdjson(operations))).toEqual(
			operations,
		);
		expect(serializeInboxNdjson([])).toBe("");
	});

	test("rejects malformed inbox operations", () => {
		expect(() =>
			deserializeInboxNdjson('{"rev":-1,"op":"put","path":"a.md"}\n'),
		).toThrow();
		expect(() =>
			deserializeInboxNdjson(
				`{"rev":1,"op":"put","path":${JSON.stringify(CLIENT_DATA_PATH)}}\n`,
			),
		).toThrow();
	});

	test("validates invite and packaged-client boundaries", () => {
		expect(
			clientInviteSchema.parse({
				url: "https://sync.example/client-invites/abc",
				expiresAt: "2030-01-01T00:05:00.000Z",
			}),
		).toBeDefined();
		expect(() =>
			clientInviteSchema.parse({
				url: "ftp://sync.example/client-invites/abc",
				expiresAt: "not-a-date",
			}),
		).toThrow();
		expect(
			clientConfigSchema.parse({
				serverUrl: "https://sync.example",
				clientName: "laptop",
				clientSecret: "obs_sync_secret",
				revision: 4,
			}),
		).toBeDefined();
		expect(() =>
			clientConfigSchema.parse({
				serverUrl: "https://sync.example",
				clientName: "laptop",
				clientSecret: "obs_sync_secret",
				revision: -1,
			}),
		).toThrow();
	});
});
