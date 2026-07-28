import type { SyncFs } from "./fs";
import { readLines, writeLines } from "./jsonl";
import { mutexFor } from "./mutex";

export type OutboxOp = { op: "put" | "delete"; path: string; ts: number };

function sameOp(a: OutboxOp, b: OutboxOp): boolean {
	return a.op === b.op && a.path === b.path && a.ts === b.ts;
}

/**
 * Enqueue an op, coalescing consecutive "put" ops for the same path.
 *
 * Serialized per-outbox via a mutex so a concurrent `drain` can never
 * interleave its read-modify-write with this one and clobber the file.
 */
export async function enqueue(
	fs: SyncFs,
	outboxPath: string,
	op: OutboxOp,
): Promise<void> {
	return mutexFor(outboxPath).run(async () => {
		const lines = await readLines<OutboxOp>(fs, outboxPath);
		const last = lines[lines.length - 1];
		if (last && last.op === "put" && op.op === "put" && last.path === op.path) {
			lines[lines.length - 1] = op;
		} else {
			lines.push(op);
		}
		await writeLines(fs, outboxPath, lines);
	});
}

export async function list(fs: SyncFs, outboxPath: string): Promise<OutboxOp[]> {
	return readLines<OutboxOp>(fs, outboxPath);
}

export const peekAll = list;

/**
 * Process outbox lines in order via `handler`. Successfully handled lines are
 * removed from the front of the outbox. Processing stops at the first
 * failure, leaving it and all subsequent lines in the outbox.
 *
 * Concurrency: the whole drain (including every handler call) runs inside a
 * single mutex acquisition for this outbox path. This is the simplest robust
 * option — it fully serializes drain against `enqueue` (and against other
 * drains), so a caller enqueueing while a drain is in flight simply waits its
 * turn rather than racing a read-modify-write. The trade-off is that a slow
 * handler holds up any concurrent enqueue for that outbox until the whole
 * drain finishes or fails.
 *
 * On top of the mutex, we still re-read the file (rather than trusting the
 * in-memory `lines` array) before every rewrite and only drop the entry that
 * matches what we just handled. This is defense in depth in case `drain` is
 * ever called without holding the mutex (e.g. a future refactor) — with the
 * mutex held throughout, the head should always match.
 */
export async function drain(
	fs: SyncFs,
	outboxPath: string,
	handler: (op: OutboxOp) => Promise<void>,
): Promise<void> {
	return mutexFor(outboxPath).run(async () => {
		let lines = await readLines<OutboxOp>(fs, outboxPath);
		while (lines.length > 0) {
			const op = lines[0]!;
			try {
				await handler(op);
			} catch (error) {
				// Keep this line and everything after it; rethrow so callers
				// can report a failed tick instead of silent success.
				throw error;
			}

			const current = await readLines<OutboxOp>(fs, outboxPath);
			const head = current[0];
			lines = head && sameOp(head, op) ? current.slice(1) : current;
			await writeLines(fs, outboxPath, lines);
		}
	});
}
