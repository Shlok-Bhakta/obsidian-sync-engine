import type { SyncFs } from "./fs";
import { readLines, writeLines } from "./jsonl";
import { mutexFor } from "./mutex";
import { NoopLogger, type Logger } from "../logger";

export type OutboxOp = {
	op: "put" | "delete";
	path: string;
	ts: number;
	baseRevision?: number;
};

function sameOp(a: OutboxOp, b: OutboxOp): boolean {
	return a.op === b.op && a.path === b.path && a.ts === b.ts;
}

function coalesce(ops: OutboxOp[]): OutboxOp[] {
	const result: OutboxOp[] = [];
	for (const op of ops) {
		const last = result[result.length - 1];
		if (last?.op === "put" && op.op === "put" && last.path === op.path) {
			result[result.length - 1] = op;
		} else {
			result.push(op);
		}
	}
	return result;
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
	injectedLogger: Logger = new NoopLogger(),
): Promise<void> {
	const logger = injectedLogger.child("outbox");
	logger.debug("enqueue.waiting_for_lock", {
		outboxPath,
		path: op.path,
		operation: op.op,
	});
	return mutexFor(outboxPath).run(async () => {
		logger.debug("enqueue.lock_acquired", {
			outboxPath,
			path: op.path,
			operation: op.op,
		});
		await fs.append(outboxPath, JSON.stringify(op) + "\n");
		logger.info("enqueue.appended", {
			outboxPath,
			path: op.path,
			operation: op.op,
			baseRevision: op.baseRevision,
		});
	});
}

export async function list(
	fs: SyncFs,
	outboxPath: string,
	injectedLogger: Logger = new NoopLogger(),
): Promise<OutboxOp[]> {
	const logger = injectedLogger.child("outbox");
	const raw = await readLines<OutboxOp>(fs, outboxPath, logger);
	const coalesced = coalesce(raw);
	logger.debug("list.completed", {
		outboxPath,
		rawOperations: raw.length,
		coalescedOperations: coalesced.length,
	});
	return coalesced;
}

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
	injectedLogger: Logger = new NoopLogger(),
	onQueueChanged?: () => void,
): Promise<void> {
	const logger = injectedLogger.child("outbox");
	logger.debug("drain.snapshot_waiting_for_lock", { outboxPath });
	const snapshot = await mutexFor(outboxPath).run(() =>
		readLines<OutboxOp>(fs, outboxPath, logger),
	);
	logger.info("drain.started", {
		outboxPath,
		operationCount: snapshot.length,
	});
	for (const op of snapshot) {
		logger.debug("drain.handler_started", {
			path: op.path,
			operation: op.op,
		});
		await handler(op);
		logger.debug("drain.handler_completed", {
			path: op.path,
			operation: op.op,
		});
		await mutexFor(outboxPath).run(async () => {
			const current = await readLines<OutboxOp>(fs, outboxPath, logger);
			const index = current.findIndex((candidate) => sameOp(candidate, op));
			if (index >= 0) {
				current.splice(index, 1);
				await writeLines(fs, outboxPath, current, logger);
				onQueueChanged?.();
				logger.info("drain.acknowledged", {
					path: op.path,
					operation: op.op,
					remainingOperations: current.length,
				});
			} else {
				logger.warn("drain.acknowledgement_missing", {
					path: op.path,
					operation: op.op,
					remainingOperations: current.length,
				});
			}
		});
	}
	logger.info("drain.completed", {
		outboxPath,
		processedOperations: snapshot.length,
	});
}
