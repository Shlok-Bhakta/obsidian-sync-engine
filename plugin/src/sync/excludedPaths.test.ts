/* eslint-disable obsidianmd/hardcoded-config-path -- verifies configurable path inputs */
import { describe, expect, test } from "bun:test";
import { isSyncExcludedPath } from "./excludedPaths";

const options = {
	configDir: ".obsidian",
	pluginDir: ".obsidian/plugins/obsidian-sync-engine",
	serverIdentity: "server-a",
};

describe("isSyncExcludedPath", () => {
	test("keeps this client's data.json local", () => {
		expect(isSyncExcludedPath({
			...options,
			path: ".obsidian/plugins/obsidian-sync-engine/data.json",
		})).toBe(true);
	});

	test("keeps durable sync journals local", () => {
		expect(isSyncExcludedPath({
			...options,
			path: ".obsidian/plugins/obsidian-sync-engine/state/server-a/outbox.jsonl",
		})).toBe(true);
	});

	test("syncs the rest of Obsidian configuration", () => {
		for (const path of [
			".obsidian/workspace.json",
			".obsidian/app.json",
			".obsidian/plugins/another-plugin/data.json",
			".obsidian/plugins/obsidian-sync-engine/main.js",
		]) {
			expect(isSyncExcludedPath({ ...options, path })).toBe(false);
		}
	});
});
