import type { SyncFs } from "./fs";
import { readLines, writeLines } from "./jsonl";

export type OutboxOp = { op: "put" | "delete"; path: string; ts: number };

/** Enqueue an op, coalescing consecutive "put" ops for the same path. */
export async function enqueue(
	fs: SyncFs,
	outboxPath: string,
	op: OutboxOp,
): Promise<void> {
	const lines = await readLines<OutboxOp>(fs, outboxPath);
	const last = lines[lines.length - 1];
	if (last && last.op === "put" && op.op === "put" && last.path === op.path) {
		lines[lines.length - 1] = op;
	} else {
		lines.push(op);
	}
	await writeLines(fs, outboxPath, lines);
}

export async function list(fs: SyncFs, outboxPath: string): Promise<OutboxOp[]> {
	return readLines<OutboxOp>(fs, outboxPath);
}

export const peekAll = list;

/**
 * Process outbox lines in order via `handler`. Successfully handled lines are
 * removed from the front of the outbox. Processing stops at the first
 * failure, leaving it and all subsequent lines in the outbox.
 */
export async function drain(
	fs: SyncFs,
	outboxPath: string,
	handler: (op: OutboxOp) => Promise<void>,
): Promise<void> {
	let lines = await readLines<OutboxOp>(fs, outboxPath);
	while (lines.length > 0) {
		const op = lines[0]!;
		try {
			await handler(op);
		} catch {
			return;
		}
		lines = lines.slice(1);
		await writeLines(fs, outboxPath, lines);
	}
}
