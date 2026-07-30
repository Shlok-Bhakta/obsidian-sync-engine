import { describe, expect, test } from "bun:test";
import { ancestorDirs, canonicalizeSyncPath, InvalidSyncPathError } from "./paths";

describe("ancestorDirs", () => {
	test("a root-level file has no ancestor directories", () => {
		expect(ancestorDirs("c.md")).toEqual([]);
	});

	test("a single nested file has one ancestor directory", () => {
		expect(ancestorDirs("a/c.md")).toEqual(["a"]);
	});

	test("a deeply nested file returns every ancestor, root-most first", () => {
		expect(ancestorDirs("a/b/c.md")).toEqual(["a", "a/b"]);
	});

	test("even deeper nesting keeps returning full accumulated paths in order", () => {
		expect(ancestorDirs("a/b/c/d.md")).toEqual(["a", "a/b", "a/b/c"]);
	});

	test("does not produce empty segments for a leading slash", () => {
		expect(ancestorDirs("/a/b/c.md")).toEqual(["a", "a/b"]);
	});
});

describe("canonicalizeSyncPath", () => {
	test("leaves an already-normalized path unchanged", () => {
		expect(canonicalizeSyncPath("a/b/c.md")).toBe("a/b/c.md");
	});

	test("wraps shared-policy failures in a client-specific error", () => {
		expect(() => canonicalizeSyncPath("a\\b\\c.md")).toThrow(InvalidSyncPathError);
	});

	test("rejects this plugin's per-client data.json", () => {
		const dataPath = [
			".",
			"obsidian/plugins/obsidian-sync-engine/data.json",
		].join("");
		expect(() => canonicalizeSyncPath(dataPath)).toThrow(
			InvalidSyncPathError,
		);
	});
});
