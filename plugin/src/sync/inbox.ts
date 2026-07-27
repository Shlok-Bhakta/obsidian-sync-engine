import type { SyncFs } from "./fs";
import { readLines, writeLines } from "./jsonl";
import { mutexFor } from "./mutex";

export type InboxOp = { rev: number; op: "put" | "delete"; path: string };

export async function writeInbox(
	fs: SyncFs,
	path: string,
	lines: InboxOp[],
): Promise<void> {
	await writeLines(fs, path, lines);
}

export async function readInbox(fs: SyncFs, path: string): Promise<InboxOp[]> {
	return readLines<InboxOp>(fs, path);
}

export type ApplyInboxOptions = {
	applyPut: (path: string) => Promise<void>;
	applyDelete: (path: string) => Promise<void>;
	getRevision: () => number | Promise<number>;
	setRevision: (rev: number) => void | Promise<void>;
	/** Paths that still have a local change pending outbound; inbound updates for them are skipped. */
	shouldSkipPath?: (path: string) => boolean;
};

/**
 * Apply inbox lines to the local vault, oldest revision first.
 *
 * Mirrors outbox's `drain`: the whole apply (including handler calls) runs
 * inside a single mutex acquisition for this inbox path, so a concurrent
 * fetch-and-append can never interleave its read-modify-write with this one.
 *
 * For each line, in ascending `rev` order:
 * - if it's already covered by the current revision, drop it without
 *   reapplying (defends against replaying an inbox left over from a prior run);
 * - else if `shouldSkipPath` matches its path, skip calling `applyPut`/
 *   `applyDelete` (a local edit is still pending outbound for that path) but
 *   still advance the revision past it and drop it;
 * - else call `applyPut`/`applyDelete`. On success, advance the revision and
 *   drop the line. On failure, STOP immediately, leaving that line and every
 *   line after it in the inbox file for the next attempt.
 */
export async function applyInbox(
	fs: SyncFs,
	inboxPath: string,
	options: ApplyInboxOptions,
): Promise<void> {
	return mutexFor(inboxPath).run(async () => {
		let lines = [...(await readInbox(fs, inboxPath))].sort(
			(a, b) => a.rev - b.rev,
		);
		let currentRevision = await options.getRevision();

		while (lines.length > 0) {
			const line = lines[0]!;

			if (line.rev <= currentRevision) {
				lines = lines.slice(1);
				await writeInbox(fs, inboxPath, lines);
				continue;
			}

			try {
				if (options.shouldSkipPath?.(line.path)) {
					// Leave the local (still-pending-outbound) version alone.
				} else if (line.op === "put") {
					await options.applyPut(line.path);
				} else {
					await options.applyDelete(line.path);
				}
			} catch {
				return;
			}

			await options.setRevision(line.rev);
			currentRevision = line.rev;
			lines = lines.slice(1);
			await writeInbox(fs, inboxPath, lines);
		}
	});
}
