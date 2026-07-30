import { describe, expect, test } from "bun:test";
import { MemorySyncFs } from "../test/sync";
import { readLines, writeLines } from "./jsonl";

describe("jsonl", () => {
	test("readLines returns empty array when file is missing", async () => {
		const fs = new MemorySyncFs();
		const lines = await readLines(fs, "missing.jsonl");
		expect(lines).toEqual([]);
	});

	test("writeLines/readLines round-trip objects", async () => {
		const fs = new MemorySyncFs();
		await writeLines(fs, "log.jsonl", [{ a: 1 }, { a: 2 }]);
		const raw = await fs.read("log.jsonl");
		expect(raw).toBe('{"a":1}\n{"a":2}\n');
		expect(await readLines<{ a: number }>(fs, "log.jsonl")).toEqual([
			{ a: 1 },
			{ a: 2 },
		]);
	});

	test("writeLines rewrites the whole file", async () => {
		const fs = new MemorySyncFs();
		await writeLines(fs, "log.jsonl", [{ a: 1 }]);
		await writeLines(fs, "log.jsonl", [{ a: 9 }]);
		expect(await readLines<{ a: number }>(fs, "log.jsonl")).toEqual([
			{ a: 9 },
		]);
	});

	test("readLines quarantines a corrupt final line and keeps valid lines", async () => {
		const fs = new MemorySyncFs();
		await fs.write("log.jsonl", '{"a":1}\n{"a":2}\n{"a":');
		const lines = await readLines<{ a: number }>(fs, "log.jsonl");
		expect(lines).toEqual([{ a: 1 }, { a: 2 }]);
		expect(await fs.exists("log.jsonl.corrupt")).toBe(true);
		expect(await fs.read("log.jsonl.corrupt")).toContain('{"a":');
		expect(await readLines<{ a: number }>(fs, "log.jsonl")).toEqual([
			{ a: 1 },
			{ a: 2 },
		]);
	});

	test("readLines refuses to skip a corrupt middle line", async () => {
		const fs = new MemorySyncFs();
		await fs.write("log.jsonl", '{"a":1}\n{"a":2\n{"a":3}\n');
		let error: unknown;
		try {
			await readLines(fs, "log.jsonl");
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/middle/);
	});
});
