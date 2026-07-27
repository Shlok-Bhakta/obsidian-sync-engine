import type { SyncFs } from "./fs";

/** Split file contents into non-empty JSONL lines. */
function splitLines(data: string): string[] {
	return data.split("\n").filter((line) => line.trim().length > 0);
}

export async function readLines<T>(fs: SyncFs, path: string): Promise<T[]> {
	if (!(await fs.exists(path))) {
		return [];
	}
	const data = await fs.read(path);
	return splitLines(data).map((line) => JSON.parse(line) as T);
}

export async function writeLines<T>(
	fs: SyncFs,
	path: string,
	lines: T[],
): Promise<void> {
	const data = lines.map((line) => JSON.stringify(line)).join("\n");
	await fs.write(path, data.length > 0 ? data + "\n" : "");
}

export async function appendLine<T>(
	fs: SyncFs,
	path: string,
	lineObj: T,
): Promise<void> {
	const existing = await fs.exists(path) ? await fs.read(path) : "";
	const serialized = JSON.stringify(lineObj);
	const data = existing.length > 0 ? existing + serialized + "\n" : serialized + "\n";
	await fs.write(path, data);
}

/** Drop the first line of the file (used to pop a processed outbox entry). */
export async function dropFirst<T>(fs: SyncFs, path: string): Promise<void> {
	const lines = await readLines<T>(fs, path);
	await writeLines(fs, path, lines.slice(1));
}

/** Drop all lines matching the predicate. */
export async function dropWhere<T>(
	fs: SyncFs,
	path: string,
	predicate: (line: T) => boolean,
): Promise<void> {
	const lines = await readLines<T>(fs, path);
	await writeLines(
		fs,
		path,
		lines.filter((line) => !predicate(line)),
	);
}
