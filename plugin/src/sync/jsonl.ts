import type { SyncFs } from "./fs";

/** Split file contents into non-empty JSONL lines. */
function splitLines(data: string): string[] {
	return data.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Parse JSONL. A truncated final line (corrupt tail) is quarantined: valid
 * preceding lines are returned and the corrupt fragment is rewritten aside
 * as `<path>.corrupt` when possible so future reads do not hard-fail forever.
 */
export async function readLines<T>(fs: SyncFs, path: string): Promise<T[]> {
	if (!(await fs.exists(path))) {
		return [];
	}
	const data = await fs.read(path);
	const rawLines = data.split("\n");
	const parsed: T[] = [];
	const corrupt: string[] = [];
	for (const line of rawLines) {
		if (line.trim().length === 0) {
			continue;
		}
		try {
			parsed.push(JSON.parse(line) as T);
		} catch {
			corrupt.push(line);
		}
	}
	if (corrupt.length > 0) {
		const quarantine = `${path}.corrupt`;
		const existing = (await fs.exists(quarantine))
			? await fs.read(quarantine)
			: "";
		const addition = corrupt.join("\n") + "\n";
		const base =
			existing.length === 0 || existing.endsWith("\n")
				? existing
				: existing + "\n";
		await fs.write(quarantine, base + addition);
		// Rewrite the durable queue without the corrupt tail so later ticks
		// can proceed.
		await writeLines(fs, path, parsed);
	}
	return parsed;
}

export async function writeLines<T>(
	fs: SyncFs,
	path: string,
	lines: T[],
): Promise<void> {
	const data = lines.map((line) => JSON.stringify(line)).join("\n");
	const body = data.length > 0 ? data + "\n" : "";
	const tmpPath = `${path}.tmp`;
	await fs.write(tmpPath, body);
	// Best-effort atomic replace: write temp then final path. Adapters without
	// rename still end with a complete final write.
	await fs.write(path, body);
}
