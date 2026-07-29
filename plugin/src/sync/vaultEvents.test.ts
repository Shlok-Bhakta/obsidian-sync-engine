import { describe, expect, test } from "bun:test";
import { isStaleFileDeletion } from "./vaultEvents";

const file = (ctime: number, mtime: number, size: number) => ({
	stat: { ctime, mtime, size },
});

describe("isStaleFileDeletion", () => {
	test("rejects an old delete after a replacement is already current", () => {
		expect(isStaleFileDeletion(file(1, 2, 3), file(4, 5, 6))).toBe(true);
	});

	test("keeps an ordinary delete when no replacement exists", () => {
		expect(isStaleFileDeletion(file(1, 2, 3), null)).toBe(false);
	});

	test("keeps the event while the same file snapshot is still cached", () => {
		expect(isStaleFileDeletion(file(1, 2, 3), file(1, 2, 3))).toBe(false);
	});
});
