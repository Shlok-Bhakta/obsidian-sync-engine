import type { SyncFs } from "./fs";
import { NoopLogger, type Logger } from "../logger";

/**
 * Parse JSONL. Only a truncated/corrupt *final* non-empty line is quarantined.
 * Corrupt lines in the middle throw so we do not silently drop durable ops and
 * continue past them (FIFO must not skip).
 */
export async function readLines<T>(
	fs: SyncFs,
	path: string,
	injectedLogger: Logger = new NoopLogger(),
): Promise<T[]> {
	const logger = injectedLogger.child("jsonl");
	logger.debug("read.started", { path });
	if (!(await fs.exists(path))) {
		logger.debug("read.completed", {
			path,
			lineCount: 0,
			reason: "file_missing",
		});
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
				logger.error("read.corrupt_middle_line", {
					path,
					lineNumber: i + 1,
					parsedLines: parsed.length,
					error,
				});
				throw new Error(
					`Corrupt JSONL line in the middle of ${path}; refusing to skip durable ops`,
					{ cause: error },
				);
			}
			const quarantine = `${path}.corrupt`;
			logger.warn("read.corrupt_tail", {
				path,
				quarantinePath: quarantine,
				lineNumber: i + 1,
				parsedLines: parsed.length,
				error,
			});
			const existing = (await fs.exists(quarantine))
				? await fs.read(quarantine)
				: "";
			const base =
				existing.length === 0 || existing.endsWith("\n")
					? existing
					: existing + "\n";
			await fs.write(quarantine, base + line + "\n");
			await writeLines(fs, path, parsed, logger);
			logger.info("read.tail_quarantined", {
				path,
				quarantinePath: quarantine,
				recoveredLines: parsed.length,
			});
			return parsed;
		}
	}
	logger.debug("read.completed", {
		path,
		lineCount: parsed.length,
		bytes: data.length,
	});
	return parsed;
}

export async function writeLines<T>(
	fs: SyncFs,
	path: string,
	lines: T[],
	injectedLogger: Logger = new NoopLogger(),
): Promise<void> {
	const logger = injectedLogger.child("jsonl");
	const data = lines.map((line) => JSON.stringify(line)).join("\n");
	const body = data.length > 0 ? data + "\n" : "";
	logger.debug("write.started", {
		path,
		lineCount: lines.length,
		bytes: body.length,
	});
	await fs.write(path, body);
	logger.debug("write.completed", {
		path,
		lineCount: lines.length,
		bytes: body.length,
	});
}
