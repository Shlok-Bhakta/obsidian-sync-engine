import { describe, expect, test } from "bun:test";
import { MemorySyncFs } from "./fs";
import { appendLine, dropFirst, readLines, writeLines } from "./jsonl";

describe("jsonl", () => {
	test("readLines returns empty array when file is missing", async () => {
		const fs = new MemorySyncFs();
		const lines = await readLines(fs, "missing.jsonl");
		expect(lines).toEqual([]);
	});

	test("appendLine writes one JSON object per line", async () => {
		const fs = new MemorySyncFs();
		await appendLine(fs, "log.jsonl", { a: 1 });
		await appendLine(fs, "log.jsonl", { a: 2 });
		const raw = await fs.read("log.jsonl");
		expect(raw).toBe('{"a":1}\n{"a":2}\n');
	});

	test("readLines parses each line back into an object", async () => {
		const fs = new MemorySyncFs();
		await appendLine(fs, "log.jsonl", { a: 1 });
		await appendLine(fs, "log.jsonl", { a: 2 });
		const lines = await readLines<{ a: number }>(fs, "log.jsonl");
		expect(lines).toEqual([{ a: 1 }, { a: 2 }]);
	});

	test("writeLines rewrites the whole file", async () => {
		const fs = new MemorySyncFs();
		await appendLine(fs, "log.jsonl", { a: 1 });
		await writeLines(fs, "log.jsonl", [{ a: 9 }]);
		const lines = await readLines<{ a: number }>(fs, "log.jsonl");
		expect(lines).toEqual([{ a: 9 }]);
	});

	test("dropFirst removes the first line and keeps the rest", async () => {
		const fs = new MemorySyncFs();
		await writeLines(fs, "log.jsonl", [{ a: 1 }, { a: 2 }, { a: 3 }]);
		await dropFirst(fs, "log.jsonl");
		const lines = await readLines<{ a: number }>(fs, "log.jsonl");
		expect(lines).toEqual([{ a: 2 }, { a: 3 }]);
	});

	test("appendLine onto a file missing its trailing newline stays parseable", async () => {
		const fs = new MemorySyncFs();
		// Simulate content written by something other than appendLine, without
		// a trailing newline.
		await fs.write("log.jsonl", '{"a":1}');
		await appendLine(fs, "log.jsonl", { a: 2 });

		const raw = await fs.read("log.jsonl");
		expect(raw).toBe('{"a":1}\n{"a":2}\n');

		const lines = await readLines<{ a: number }>(fs, "log.jsonl");
		expect(lines).toEqual([{ a: 1 }, { a: 2 }]);
	});
});
