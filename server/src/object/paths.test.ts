import { describe, expect, it } from "bun:test";
import { canonicalizePath, InvalidPathError, isValidPath } from "./paths";

describe("canonicalizePath", () => {
	it("accepts a simple vault-relative path", () => {
		expect(canonicalizePath("notes/foo.md")).toBe("notes/foo.md");
	});

	it("wraps shared-policy failures in a server-specific error", () => {
		expect(() => canonicalizePath("../x")).toThrow(InvalidPathError);
	});

	it("isValidPath returns false instead of throwing", () => {
		expect(isValidPath("../x")).toBe(false);
		expect(isValidPath("notes/foo.md")).toBe(true);
	});
});
