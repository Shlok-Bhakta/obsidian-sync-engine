import type { DataAdapter } from "obsidian";

const JOURNALS = ["outbox.jsonl", "inbox.jsonl", "dead-letter.jsonl"] as const;

type StateAdapter = Pick<
	DataAdapter,
	"exists" | "read" | "write" | "rename" | "remove" | "rmdir"
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
	const older = await adapter.read(source);
	const newer = await adapter.read(target);
	await adapter.write(tmp, `${older}${newer}`);
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
