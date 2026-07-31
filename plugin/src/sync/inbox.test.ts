import { describe, expect, test } from "bun:test";
import { createRevisionStore, MemorySyncFs } from "../test/sync";
import {
	appendInbox,
	applyInbox,
	readInbox,
	writeInbox,
	type InboxOp,
} from "./inbox";

const INBOX = "inbox.jsonl";

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

		const revision = createRevisionStore(0);
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

		const revision = createRevisionStore(0);
		const applied: string[] = [];

		let applyError: unknown;
		try {
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
		} catch (error) {
			applyError = error;
		}
		expect(applyError).toBeInstanceOf(Error);
		expect((applyError as Error).message).toBe("write failed");

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

		const revision = createRevisionStore(0);
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
			shouldSkipApply: (op) => op.path === "pending.md",
		});

		// pending.md's content was never applied...
		expect(applied).toEqual(["a.md", "c.md"]);
		// ...but its revision was still consumed, and the line dropped.
		expect(revision.get()).toBe(3);
		expect(await readInbox(fs, INBOX)).toEqual([]);
	});

	test("applyInbox defers a pending local path without advancing or dropping it", async () => {
		const fs = new MemorySyncFs();
		await writeInbox(fs, INBOX, [{ rev: 2, op: "put", path: "a.md" }]);
		let revision = 1;
		await applyInbox(fs, INBOX, {
			applyPut: async () => {
				throw new Error("must not apply");
			},
			applyDelete: async () => {},
			getRevision: () => revision,
			setRevision: (next) => {
				revision = next;
			},
			shouldDeferApply: () => true,
		});
		expect(revision).toBe(1);
		expect(await readInbox(fs, INBOX)).toEqual([
			{ rev: 2, op: "put", path: "a.md" },
		]);
	});

	test("applyInbox skips by rev via shouldSkipApply (self-echo) but still advances revision, drops the line, and consumes it", async () => {
		const fs = new MemorySyncFs();
		await writeInbox(fs, INBOX, [
			{ rev: 1, op: "put", path: "a.md" },
			{ rev: 2, op: "put", path: "echoed.md" },
			{ rev: 3, op: "put", path: "c.md" },
		]);

		const revision = createRevisionStore(0);
		const applied: string[] = [];
		const echoRevs = new Set([2]);

		await applyInbox(fs, INBOX, {
			applyPut: async (path) => {
				applied.push(path);
			},
			applyDelete: async (path) => {
				applied.push(path);
			},
			getRevision: revision.get,
			setRevision: revision.set,
			shouldSkipApply: (op) => echoRevs.delete(op.rev),
		});

		// echoed.md's content was never (re-)applied to the vault...
		expect(applied).toEqual(["a.md", "c.md"]);
		// ...but its revision was still consumed, the line dropped, and the
		// echo entry itself consumed so a later reused rev isn't misread.
		expect(revision.get()).toBe(3);
		expect(echoRevs.size).toBe(0);
		expect(await readInbox(fs, INBOX)).toEqual([]);
	});

	test("applyInbox drops lines already covered by the current revision without reapplying", async () => {
		const fs = new MemorySyncFs();
		await writeInbox(fs, INBOX, [
			{ rev: 1, op: "put", path: "a.md" },
			{ rev: 2, op: "put", path: "b.md" },
		]);

		const revision = createRevisionStore(1); // a.md already applied in a prior run
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

	test("appendInbox serializes concurrent fetch-and-append calls so no lines are lost", async () => {
		const fs = new MemorySyncFs();
		let releaseFirstWrite = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve;
		});
		let writeCount = 0;
		const originalWrite = fs.write.bind(fs);
		fs.write = async (path: string, data: string) => {
			writeCount++;
			if (writeCount === 1) {
				// Hold the first append's write open so a naive (non-mutexed)
				// second append would read stale data and clobber it.
				await gate;
			}
			await originalWrite(path, data);
		};

		const first = appendInbox(fs, INBOX, [{ rev: 1, op: "put", path: "a.md" }]);
		const second = appendInbox(fs, INBOX, [
			{ rev: 2, op: "put", path: "b.md" },
		]);

		releaseFirstWrite();
		await Promise.all([first, second]);

		expect(await readInbox(fs, INBOX)).toEqual([
			{ rev: 1, op: "put", path: "a.md" },
			{ rev: 2, op: "put", path: "b.md" },
		]);
	});

	test("appendInbox is a no-op for an empty batch", async () => {
		const fs = new MemorySyncFs();
		await writeInbox(fs, INBOX, [{ rev: 1, op: "put", path: "a.md" }]);
		await appendInbox(fs, INBOX, []);
		expect(await readInbox(fs, INBOX)).toEqual([
			{ rev: 1, op: "put", path: "a.md" },
		]);
	});
});
