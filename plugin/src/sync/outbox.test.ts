import { describe, expect, test } from "bun:test";
import { MemorySyncFs } from "./fs";
import { drain, enqueue, list, type OutboxOp } from "./outbox";

const OUTBOX = "outbox.jsonl";

describe("outbox", () => {
	test("enqueue coalesces consecutive puts to the same path", async () => {
		const fs = new MemorySyncFs();
		await enqueue(fs, OUTBOX, { op: "put", path: "a.md", ts: 1 });
		await enqueue(fs, OUTBOX, { op: "put", path: "a.md", ts: 2 });
		const ops = await list(fs, OUTBOX);
		expect(ops).toEqual([{ op: "put", path: "a.md", ts: 2 }]);
	});

	test("enqueue does not coalesce different paths", async () => {
		const fs = new MemorySyncFs();
		await enqueue(fs, OUTBOX, { op: "put", path: "a.md", ts: 1 });
		await enqueue(fs, OUTBOX, { op: "put", path: "b.md", ts: 2 });
		const ops = await list(fs, OUTBOX);
		expect(ops).toEqual([
			{ op: "put", path: "a.md", ts: 1 },
			{ op: "put", path: "b.md", ts: 2 },
		]);
	});

	test("enqueue does not coalesce put after delete for the same path", async () => {
		const fs = new MemorySyncFs();
		await enqueue(fs, OUTBOX, { op: "delete", path: "a.md", ts: 1 });
		await enqueue(fs, OUTBOX, { op: "put", path: "a.md", ts: 2 });
		const ops = await list(fs, OUTBOX);
		expect(ops).toEqual([
			{ op: "delete", path: "a.md", ts: 1 },
			{ op: "put", path: "a.md", ts: 2 },
		]);
	});

	test("drain calls handler in order and removes succeeded lines", async () => {
		const fs = new MemorySyncFs();
		await enqueue(fs, OUTBOX, { op: "put", path: "a.md", ts: 1 });
		await enqueue(fs, OUTBOX, { op: "put", path: "b.md", ts: 2 });
		await enqueue(fs, OUTBOX, { op: "delete", path: "c.md", ts: 3 });

		const seen: OutboxOp[] = [];
		await drain(fs, OUTBOX, async (op) => {
			seen.push(op);
		});

		expect(seen).toEqual([
			{ op: "put", path: "a.md", ts: 1 },
			{ op: "put", path: "b.md", ts: 2 },
			{ op: "delete", path: "c.md", ts: 3 },
		]);
		expect(await list(fs, OUTBOX)).toEqual([]);
	});

	test("drain stops on first failure and keeps remaining lines", async () => {
		const fs = new MemorySyncFs();
		await enqueue(fs, OUTBOX, { op: "put", path: "a.md", ts: 1 });
		await enqueue(fs, OUTBOX, { op: "put", path: "b.md", ts: 2 });
		await enqueue(fs, OUTBOX, { op: "delete", path: "c.md", ts: 3 });

		const seen: OutboxOp[] = [];
		await drain(fs, OUTBOX, async (op) => {
			seen.push(op);
			if (op.path === "b.md") {
				throw new Error("upload failed");
			}
		});

		expect(seen).toEqual([
			{ op: "put", path: "a.md", ts: 1 },
			{ op: "put", path: "b.md", ts: 2 },
		]);
		expect(await list(fs, OUTBOX)).toEqual([
			{ op: "put", path: "b.md", ts: 2 },
			{ op: "delete", path: "c.md", ts: 3 },
		]);
	});
});
