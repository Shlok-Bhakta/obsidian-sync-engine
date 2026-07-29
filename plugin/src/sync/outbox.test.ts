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
		let drainError: unknown;
		try {
			await drain(fs, OUTBOX, async (op) => {
				seen.push(op);
				if (op.path === "b.md") {
					throw new Error("upload failed");
				}
			});
		} catch (error) {
			drainError = error;
		}
		expect(drainError).toBeInstanceOf(Error);
		expect((drainError as Error).message).toBe("upload failed");

		expect(seen).toEqual([
			{ op: "put", path: "a.md", ts: 1 },
			{ op: "put", path: "b.md", ts: 2 },
		]);
		expect(await list(fs, OUTBOX)).toEqual([
			{ op: "put", path: "b.md", ts: 2 },
			{ op: "delete", path: "c.md", ts: 3 },
		]);
	});

	test("enqueue during a slow drain waits for the mutex and no ops are lost", async () => {
		const fs = new MemorySyncFs();
		await enqueue(fs, OUTBOX, { op: "put", path: "a.md", ts: 1 });

		let releaseHandler = () => {};
		const handlerGate = new Promise<void>((resolve) => {
			releaseHandler = resolve;
		});
		let handlerStarted = () => {};
		const handlerStartedPromise = new Promise<void>((resolve) => {
			handlerStarted = resolve;
		});

		const seen: OutboxOp[] = [];
		const drainPromise = drain(fs, OUTBOX, async (op) => {
			seen.push(op);
			handlerStarted();
			await handlerGate; // simulate a slow upload while holding the mutex
		});

		// Wait until drain has grabbed the mutex and is mid-handler.
		await handlerStartedPromise;

		let enqueueResolved = false;
		const enqueuePromise = enqueue(fs, OUTBOX, {
			op: "put",
			path: "b.md",
			ts: 2,
		}).then(() => {
			enqueueResolved = true;
		});

		// Enqueue durability must not wait for a slow network handler.
		for (let i = 0; i < 5; i++) {
			await Promise.resolve();
		}
		expect(enqueueResolved).toBe(true);

		releaseHandler();
		await drainPromise;
		await enqueuePromise;

		expect(enqueueResolved).toBe(true);
		expect(seen).toEqual([{ op: "put", path: "a.md", ts: 1 }]);
		// a.md was drained successfully and removed; b.md was enqueued after and
		// is still present — no op was lost or clobbered by the interleaving.
		expect(await list(fs, OUTBOX)).toEqual([
			{ op: "put", path: "b.md", ts: 2 },
		]);
	});
});
