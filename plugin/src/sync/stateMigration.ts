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
	const tmp = `${target}.migration.tmp`;
	const backup = `${target}.migration.bak`;
	const marker = `${target}.migration.json`;

	// An explicit marker distinguishes a previously installed merge from a
	// coincidental source/target prefix. It contains the prepared body so any
	// crash point can resume without guessing from journal contents.
	if (await adapter.exists(marker)) {
		const { body } = JSON.parse(await adapter.read(marker)) as { body: string };
		if (
			!(await adapter.exists(target)) ||
			(await adapter.read(target)) !== body
		) {
			await adapter.write(tmp, body);
			if (await adapter.exists(target)) {
				if (await adapter.exists(backup)) await adapter.remove(backup);
				await adapter.rename(target, backup);
			}
			await adapter.rename(tmp, target);
		}
		if (await adapter.exists(source)) await adapter.remove(source);
		if (await adapter.exists(tmp)) await adapter.remove(tmp);
		if (await adapter.exists(backup)) await adapter.remove(backup);
		await adapter.remove(marker);
		return;
	}

	// Recover artifacts produced by versions that predate explicit markers.
	if (!(await adapter.exists(target))) {
		if (await adapter.exists(tmp)) {
			// Without a marker, the staged body's ownership is ambiguous; keep
			// the known committed backup and rebuild from the durable source.
			await adapter.remove(tmp);
		}
		if (await adapter.exists(backup)) {
			await adapter.rename(backup, target);
		}
	}
	if (!(await adapter.exists(source))) return;
	if (!(await adapter.exists(target))) {
		await adapter.rename(source, target);
		return;
	}
	if (await adapter.exists(tmp)) await adapter.remove(tmp);
	if (await adapter.exists(backup)) await adapter.remove(backup);
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
		const uniqueLines = new Set(
			`${existing}\n${recovered}`
				.split("\n")
				.filter((line) => line.length > 0),
		);
		await adapter.write(
			targetQuarantine,
			uniqueLines.size > 0 ? `${[...uniqueLines].join("\n")}\n` : "",
		);
	}
	const olderLines = older.map((entry) => JSON.stringify(entry));
	const newerLines = newer.map((entry) => JSON.stringify(entry));
	const lines = [...olderLines, ...newerLines];
	const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
	await adapter.write(tmp, body);
	await adapter.write(marker, JSON.stringify({ body }));
	await adapter.rename(target, backup);
	// If any step fails, marker/source/artifacts remain for startup recovery.
	await adapter.rename(tmp, target);
	await adapter.remove(source);
	await adapter.remove(backup);
	await adapter.remove(marker);
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
