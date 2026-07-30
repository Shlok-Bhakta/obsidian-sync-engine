import { describe, expect, it } from "bun:test";
import { canonicalizePath, InvalidPathError, isValidPath } from "./paths";

describe("canonicalizePath", () => {
	it("accepts a simple vault-relative path", () => {
		expect(canonicalizePath("notes/foo.md")).toBe("notes/foo.md");
	});

	it("accepts a root-level file", () => {
		expect(canonicalizePath("foo.md")).toBe("foo.md");
	});

	it("accepts Obsidian configuration except per-client data.json", () => {
		expect(canonicalizePath(".obsidian/workspace.json")).toBe(
			".obsidian/workspace.json",
		);
		expect(() =>
			canonicalizePath(
				".obsidian/plugins/obsidian-sync-engine/data.json",
			),
		).toThrow(InvalidPathError);
	});

	it("rejects an empty path", () => {
		expect(() => canonicalizePath("")).toThrow(InvalidPathError);
	});

	it("rejects an absolute unix path", () => {
		expect(() => canonicalizePath("/etc/passwd")).toThrow(InvalidPathError);
	});

	it("rejects a windows drive-letter path", () => {
		expect(() => canonicalizePath("C:/Windows/system32")).toThrow(InvalidPathError);
	});

	it("rejects a parent-directory traversal segment", () => {
		expect(() => canonicalizePath("../x")).toThrow(InvalidPathError);
	});

	it("rejects a nested parent-directory traversal segment", () => {
		expect(() => canonicalizePath("a/../../etc/passwd")).toThrow(InvalidPathError);
	});

	it("rejects a current-directory segment", () => {
		expect(() => canonicalizePath("a/./b")).toThrow(InvalidPathError);
	});

	it("rejects a backslash", () => {
		expect(() => canonicalizePath("a\\b")).toThrow(InvalidPathError);
	});

	it("rejects a NUL byte", () => {
		expect(() => canonicalizePath("a\0b")).toThrow(InvalidPathError);
	});

	it("rejects a trailing slash", () => {
		expect(() => canonicalizePath("a/b/")).toThrow(InvalidPathError);
	});

	it("rejects duplicated separators", () => {
		expect(() => canonicalizePath("a//b")).toThrow(InvalidPathError);
	});

	it("isValidPath returns false instead of throwing", () => {
		expect(isValidPath("../x")).toBe(false);
		expect(isValidPath("notes/foo.md")).toBe(true);
	});
});
