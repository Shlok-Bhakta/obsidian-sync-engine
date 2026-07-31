import type { InboxOp } from "obsidian-sync-protocol";
import type { SyncFs } from "./fs";
import { readLines, writeLines } from "./jsonl";
import { mutexFor } from "./mutex";
import { NoopLogger, type Logger } from "../logger";

export type { InboxOp } from "obsidian-sync-protocol";

export async function writeInbox(
	fs: SyncFs,
	path: string,
	lines: InboxOp[],
	logger: Logger = new NoopLogger(),
): Promise<void> {
	await writeLines(fs, path, lines, logger);
}

export async function readInbox(
	fs: SyncFs,
	path: string,
	logger: Logger = new NoopLogger(),
): Promise<InboxOp[]> {
	return readLines<InboxOp>(fs, path, logger);
}

/**
 * Append freshly-fetched ops onto the inbox file.
 *
 * The read-modify-write runs inside `mutexFor(path)`, the same mutex key
 * `applyInbox` uses for this path, so a fetch-and-append can never interleave
 * with (or race) a concurrent apply or another append and lose lines.
 */
export async function appendInbox(
	fs: SyncFs,
	path: string,
	ops: InboxOp[],
	injectedLogger: Logger = new NoopLogger(),
): Promise<void> {
	const logger = injectedLogger.child("inbox");
	if (ops.length === 0) {
		logger.debug("append.skipped", {
			inboxPath: path,
			reason: "empty_batch",
		});
		return;
	}
	logger.debug("append.waiting_for_lock", {
		inboxPath: path,
		operationCount: ops.length,
		firstRevision: ops[0]?.rev,
		lastRevision: ops.at(-1)?.rev,
	});
	return mutexFor(path).run(async () => {
		const existing = await readInbox(fs, path, logger);
		await writeInbox(fs, path, [...existing, ...ops], logger);
		logger.info("append.completed", {
			inboxPath: path,
			appendedOperations: ops.length,
			totalOperations: existing.length + ops.length,
			firstRevision: ops[0]?.rev,
			lastRevision: ops.at(-1)?.rev,
		});
	});
}

export type ApplyInboxOptions = {
	applyPut: (path: string) => Promise<void>;
	applyDelete: (path: string) => Promise<void>;
	getRevision: () => number | Promise<number>;
	setRevision: (rev: number) => void | Promise<void>;
	/**
	 * Called for each line before it would be applied. Return true to skip the
	 * vault mutation (`applyPut`/`applyDelete` is not called) while still
	 * advancing the revision past it and dropping the line. Used both for
	 * paths with a pending local edit and for self-echoed revisions.
	 */
	shouldSkipApply?: (op: InboxOp) => boolean;
	/** Leave this line and all later lines durable for a later tick. */
	shouldDeferApply?: (op: InboxOp) => boolean;
	logger?: Logger;
};

/**
 * Apply inbox lines to the local vault, oldest revision first.
 *
 * Mirrors outbox's `drain`: the whole apply (including handler calls) runs
 * inside a single mutex acquisition for this inbox path, so a concurrent
 * fetch-and-append (`appendInbox`) can never interleave its read-modify-write
 * with this one.
 *
 * For each line, in ascending `rev` order:
 * - if it's already covered by the current revision, drop it without
 *   reapplying (defends against replaying an inbox left over from a prior run);
 * - else if `shouldSkipApply` matches, skip calling `applyPut`/`applyDelete`
 *   but still advance the revision past it and drop it;
 * - else call `applyPut`/`applyDelete`. On success, advance the revision and
 *   drop the line. On failure, STOP immediately, leaving that line and every
 *   line after it in the inbox file for the next attempt.
 */
export async function applyInbox(
	fs: SyncFs,
	inboxPath: string,
	options: ApplyInboxOptions,
): Promise<void> {
	const logger = (options.logger ?? new NoopLogger()).child("inbox");
	logger.debug("apply.waiting_for_lock", { inboxPath });
	return mutexFor(inboxPath).run(async () => {
		let lines = [...(await readInbox(fs, inboxPath, logger))].sort(
			(a, b) => a.rev - b.rev,
		);
		let currentRevision = await options.getRevision();
		logger.info("apply.started", {
			inboxPath,
			operationCount: lines.length,
			currentRevision,
		});

		while (lines.length > 0) {
			const line = lines[0]!;
			logger.debug("apply.operation_evaluating", {
				path: line.path,
				operation: line.op,
				revision: line.rev,
				currentRevision,
			});

			if (line.rev <= currentRevision) {
				lines = lines.slice(1);
				await writeInbox(fs, inboxPath, lines, logger);
				logger.info("apply.operation_dropped", {
					path: line.path,
					operation: line.op,
					revision: line.rev,
					reason: "already_applied",
					remainingOperations: lines.length,
				});
				continue;
			}

			if (options.shouldDeferApply?.(line)) {
				logger.info("apply.deferred", {
					path: line.path,
					operation: line.op,
					revision: line.rev,
					currentRevision,
					remainingOperations: lines.length,
				});
				return;
			}

			if (options.shouldSkipApply?.(line)) {
				// Leave the vault alone (pending local edit, or our own echo).
				logger.info("apply.mutation_skipped", {
					path: line.path,
					operation: line.op,
					revision: line.rev,
				});
			} else if (line.op === "put") {
				await options.applyPut(line.path);
			} else {
				await options.applyDelete(line.path);
			}

			await options.setRevision(line.rev);
			currentRevision = line.rev;
			lines = lines.slice(1);
			await writeInbox(fs, inboxPath, lines, logger);
			logger.info("apply.operation_committed", {
				path: line.path,
				operation: line.op,
				revision: line.rev,
				remainingOperations: lines.length,
			});
		}
		logger.info("apply.completed", {
			inboxPath,
			currentRevision,
		});
	});
}
