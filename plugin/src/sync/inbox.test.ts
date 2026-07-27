import { describe, expect, test } from "bun:test";
import { MemorySyncFs } from "./fs";
import { applyInbox, readInbox, writeInbox, type InboxOp } from "./inbox";

const INBOX = "inbox.jsonl";

function makeRevisionStore(initial = 0) {
	let revision = initial;
	return {
		get: () => revision,
		set: (rev: number) => {
			revision = rev;
		},
	};
}

describe("inbox", () => {
	test("readInbox returns empty array when file is missing", async () => {
		const fs = new MemorySyncFs();
		expect(await readInbox(fs, INBOX)).toEqual([]);
	});

	test("writeInbox/readInbox round-trips lines", async () => {
		const fs = new MemorySyncFs();
		const lines: InboxOp[] = [
			{ rev: 1, op: "put", path: "a.md" },
			{ rev: 2, op: "delete", path: "b.md" },
		];
		await writeInbox(fs, INBOX, lines);
		expect(await readInbox(fs, INBOX)).toEqual(lines);
	});

	test("applyInbox processes ascending by rev, bumps revision, and drops lines", async () => {
		const fs = new MemorySyncFs();
		// Written out of order to exercise the sort.
		await writeInbox(fs, INBOX, [
			{ rev: 3, op: "put", path: "c.md" },
			{ rev: 1, op: "put", path: "a.md" },
			{ rev: 2, op: "delete", path: "b.md" },
		]);

		const revision = makeRevisionStore(0);
		const applied: InboxOp[] = [];

		await applyInbox(fs, INBOX, {
			applyPut: async (path) => {
				applied.push({ rev: -1, op: "put", path });
			},
			applyDelete: async (path) => {
				applied.push({ rev: -1, op: "delete", path });
			},
			getRevision: revision.get,
			setRevision: revision.set,
		});

		expect(applied.map((a) => a.path)).toEqual(["a.md", "b.md", "c.md"]);
		expect(revision.get()).toBe(3);
		expect(await readInbox(fs, INBOX)).toEqual([]);
	});

	test("applyInbox stops on first failure, leaving remaining lines and revision unadvanced past it", async () => {
		const fs = new MemorySyncFs();
		await writeInbox(fs, INBOX, [
			{ rev: 1, op: "put", path: "a.md" },
			{ rev: 2, op: "put", path: "b.md" },
			{ rev: 3, op: "delete", path: "c.md" },
		]);

		const revision = makeRevisionStore(0);
		const applied: string[] = [];

		await applyInbox(fs, INBOX, {
			applyPut: async (path) => {
				applied.push(path);
				if (path === "b.md") {
					throw new Error("write failed");
				}
			},
			applyDelete: async (path) => {
				applied.push(path);
			},
			getRevision: revision.get,
			setRevision: revision.set,
		});

		expect(applied).toEqual(["a.md", "b.md"]);
		expect(revision.get()).toBe(1);
		expect(await readInbox(fs, INBOX)).toEqual([
			{ rev: 2, op: "put", path: "b.md" },
			{ rev: 3, op: "delete", path: "c.md" },
		]);
	});

	test("applyInbox skips a path pending outbound but still advances revision and drops the line", async () => {
		const fs = new MemorySyncFs();
		await writeInbox(fs, INBOX, [
			{ rev: 1, op: "put", path: "a.md" },
			{ rev: 2, op: "put", path: "pending.md" },
			{ rev: 3, op: "put", path: "c.md" },
		]);

		const revision = makeRevisionStore(0);
		const applied: string[] = [];

		await applyInbox(fs, INBOX, {
			applyPut: async (path) => {
				applied.push(path);
			},
			applyDelete: async (path) => {
				applied.push(path);
			},
			getRevision: revision.get,
			setRevision: revision.set,
			shouldSkipPath: (path) => path === "pending.md",
		});

		// pending.md's content was never applied...
		expect(applied).toEqual(["a.md", "c.md"]);
		// ...but its revision was still consumed, and the line dropped.
		expect(revision.get()).toBe(3);
		expect(await readInbox(fs, INBOX)).toEqual([]);
	});

	test("applyInbox drops lines already covered by the current revision without reapplying", async () => {
		const fs = new MemorySyncFs();
		await writeInbox(fs, INBOX, [
			{ rev: 1, op: "put", path: "a.md" },
			{ rev: 2, op: "put", path: "b.md" },
		]);

		const revision = makeRevisionStore(1); // a.md already applied in a prior run
		const applied: string[] = [];

		await applyInbox(fs, INBOX, {
			applyPut: async (path) => {
				applied.push(path);
			},
			applyDelete: async () => {},
			getRevision: revision.get,
			setRevision: revision.set,
		});

		expect(applied).toEqual(["b.md"]);
		expect(revision.get()).toBe(2);
		expect(await readInbox(fs, INBOX)).toEqual([]);
	});
});
