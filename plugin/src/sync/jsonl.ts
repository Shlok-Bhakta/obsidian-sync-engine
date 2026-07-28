import type { SyncFs } from "./fs";

/**
 * Parse JSONL. Only a truncated/corrupt *final* non-empty line is quarantined.
 * Corrupt lines in the middle throw so we do not silently drop durable ops and
 * continue past them (FIFO must not skip).
 */
export async function readLines<T>(fs: SyncFs, path: string): Promise<T[]> {
	if (!(await fs.exists(path))) {
		return [];
	}
	const data = await fs.read(path);
	const rawLines = data.split("\n");
	const nonEmpty = rawLines
		.map((line, index) => ({ line, index }))
		.filter(({ line }) => line.trim().length > 0);

	const parsed: T[] = [];
	for (let i = 0; i < nonEmpty.length; i++) {
		const { line } = nonEmpty[i]!;
		const isLast = i === nonEmpty.length - 1;
		try {
			parsed.push(JSON.parse(line) as T);
		} catch (error) {
			if (!isLast) {
				throw new Error(
					`Corrupt JSONL line in the middle of ${path}; refusing to skip durable ops`,
					{ cause: error },
				);
			}
			const quarantine = `${path}.corrupt`;
			const existing = (await fs.exists(quarantine))
				? await fs.read(quarantine)
				: "";
			const base =
				existing.length === 0 || existing.endsWith("\n")
					? existing
					: existing + "\n";
			await fs.write(quarantine, base + line + "\n");
			await writeLines(fs, path, parsed);
			return parsed;
		}
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
	await fs.write(path, body);
}
