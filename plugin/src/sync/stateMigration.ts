import type { DataAdapter } from "obsidian";
import { readLines } from "./jsonl";

const JOURNALS = ["outbox.jsonl", "inbox.jsonl", "dead-letter.jsonl"] as const;

type StateAdapter = Pick<
	DataAdapter,
	"append" | "exists" | "read" | "write" | "rename" | "remove" | "rmdir"
>;

async function mergeJournal(
	adapter: StateAdapter,
	source: string,
	target: string,
): Promise<void> {
	if (!(await adapter.exists(source))) return;
	if (!(await adapter.exists(target))) {
		await adapter.rename(source, target);
		return;
	}

	const tmp = `${target}.migration.tmp`;
	const backup = `${target}.migration.bak`;
	if (await adapter.exists(tmp)) await adapter.remove(tmp);
	if (await adapter.exists(backup)) {
		if (!(await adapter.exists(target))) await adapter.rename(backup, target);
		else await adapter.remove(backup);
	}
	// Parsing first preserves jsonl's recoverable-tail quarantine behavior.
	// Exact serialized-entry deduplication makes a restart after target
	// replacement idempotent even if the source has not yet been removed.
	const older = await readLines<unknown>(adapter, source);
	const newer = await readLines<unknown>(adapter, target);
	const sourceQuarantine = `${source}.corrupt`;
	if (await adapter.exists(sourceQuarantine)) {
		const targetQuarantine = `${target}.legacy.corrupt`;
		const existing = (await adapter.exists(targetQuarantine))
			? await adapter.read(targetQuarantine)
			: "";
		const recovered = await adapter.read(sourceQuarantine);
		const separator =
			existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
		await adapter.write(
			targetQuarantine,
			`${existing}${separator}${recovered}`,
		);
	}
	const merged = new Map<string, unknown>();
	for (const entry of [...older, ...newer]) {
		merged.set(JSON.stringify(entry), entry);
	}
	const lines = [...merged.values()].map((entry) => JSON.stringify(entry));
	await adapter.write(tmp, lines.length > 0 ? `${lines.join("\n")}\n` : "");
	await adapter.rename(target, backup);
	try {
		await adapter.rename(tmp, target);
		await adapter.remove(backup);
	} catch (error) {
		if (!(await adapter.exists(target)) && (await adapter.exists(backup))) {
			await adapter.rename(backup, target);
		}
		throw error;
	}
}

/**
 * Moves durable journals from the legacy identity namespace before the sync
 * engine starts. If a prior migration already created the destination, the
 * older journal is prepended so operation order remains stable.
 */
export async function migrateServerState(
	adapter: StateAdapter,
	stateRoot: string,
	previousIdentity: string,
	nextIdentity: string,
): Promise<void> {
	if (!previousIdentity || previousIdentity === nextIdentity) return;
	const sourceDir = `${stateRoot}/${previousIdentity}`;
	if (!(await adapter.exists(sourceDir))) return;
	const targetDir = `${stateRoot}/${nextIdentity}`;
	if (!(await adapter.exists(targetDir))) {
		await adapter.rename(sourceDir, targetDir);
		return;
	}
	for (const journal of JOURNALS) {
		await mergeJournal(
			adapter,
			`${sourceDir}/${journal}`,
			`${targetDir}/${journal}`,
		);
	}
	await adapter.rmdir(sourceDir, true);
}
