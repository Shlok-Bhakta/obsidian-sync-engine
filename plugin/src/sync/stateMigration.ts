import type { DataAdapter } from "obsidian";

const JOURNALS = ["outbox.jsonl", "inbox.jsonl", "dead-letter.jsonl"] as const;

type StateAdapter = Pick<
	DataAdapter,
	"append" | "exists" | "read" | "write" | "rename" | "remove" | "rmdir"
>;

function parseJournal(
	body: string,
	path: string,
): { entries: unknown[]; corruptTail: string } {
	const lines = body
		.split("\n")
		.filter((line) => line.trim().length > 0);
	const entries: unknown[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		try {
			entries.push(JSON.parse(line) as unknown);
		} catch (error) {
			if (index !== lines.length - 1) {
				throw new Error(
					`Corrupt JSONL line in the middle of ${path}; refusing migration`,
					{ cause: error },
				);
			}
			return { entries, corruptTail: `${line}\n` };
		}
	}
	return { entries, corruptTail: "" };
}

function joinJournalFragments(...fragments: string[]): string {
	const present = fragments.filter((fragment) => fragment.length > 0);
	return present
		.map((fragment) => (fragment.endsWith("\n") ? fragment : `${fragment}\n`))
		.join("");
}

async function mergeJournal(
	adapter: StateAdapter,
	source: string,
	target: string,
): Promise<void> {
	const tmp = `${target}.migration.tmp`;
	const backup = `${target}.migration.bak`;
	const marker = `${target}.migration.json`;
	const quarantineTarget = `${target}.legacy.corrupt`;

	// An explicit marker distinguishes a previously installed merge from a
	// coincidental source/target prefix. It contains the prepared body so any
	// crash point can resume without guessing from journal contents.
	if (await adapter.exists(marker)) {
		const { body, quarantineBody = "" } = JSON.parse(
			await adapter.read(marker),
		) as { body: string; quarantineBody?: string };
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
		if (quarantineBody.length > 0) {
			await adapter.write(quarantineTarget, quarantineBody);
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
	// Parse without mutating either journal. The exact desired journal and
	// quarantine bytes are persisted together in the marker before install.
	const olderParsed = parseJournal(await adapter.read(source), source);
	const newerParsed = parseJournal(await adapter.read(target), target);
	const sourceQuarantine = `${source}.corrupt`;
	const existingQuarantine = (await adapter.exists(quarantineTarget))
		? await adapter.read(quarantineTarget)
		: "";
	const sourceQuarantineBody = (await adapter.exists(sourceQuarantine))
		? await adapter.read(sourceQuarantine)
		: "";
	const quarantineBody = joinJournalFragments(
		existingQuarantine,
		sourceQuarantineBody,
		olderParsed.corruptTail,
		newerParsed.corruptTail,
	);
	const olderLines = olderParsed.entries.map((entry) => JSON.stringify(entry));
	const newerLines = newerParsed.entries.map((entry) => JSON.stringify(entry));
	const lines = [...olderLines, ...newerLines];
	const body = lines.length > 0 ? `${lines.join("\n")}\n` : "";
	await adapter.write(tmp, body);
	await adapter.write(marker, JSON.stringify({ body, quarantineBody }));
	await adapter.rename(target, backup);
	// If any step fails, marker/source/artifacts remain for startup recovery.
	await adapter.rename(tmp, target);
	if (quarantineBody.length > 0) {
		await adapter.write(quarantineTarget, quarantineBody);
	}
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
