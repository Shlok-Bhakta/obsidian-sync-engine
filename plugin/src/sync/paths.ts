/** Thrown by `canonicalizeSyncPath` when a path cannot be made safe to sync. */
export class InvalidSyncPathError extends Error {
	constructor(readonly path: string) {
		super(`Invalid sync path: ${path}`);
		this.name = "InvalidSyncPathError";
	}
}

/**
 * Normalizes a vault path before it is handed to the transport, mirroring
 * the server's stricter canonicalization (`server/src/object/paths.ts`) so
 * obviously-bad paths are rejected locally instead of round-tripping to the
 * server for a 400.
 *
 * Backslashes are converted to forward slashes, empty and `.` segments are
 * dropped (defends against a stray `a//b` or trailing slash), but a `..`
 * segment is always rejected rather than silently resolved, since Obsidian
 * vault paths should never need to escape a directory.
 */
export function canonicalizeSyncPath(path: string): string {
	if (!isCanonicalSyncPath(path)) {
		throw new InvalidSyncPathError(path);
	}
	return path;
}

/**
 * Returns the ancestor directory paths of `path`, root-most first, so a
 * caller can `mkdir` each one in turn. Obsidian's `DataAdapter.mkdir` is NOT
 * recursive, so writing `a/b/c.md` requires `mkdir("a")` then
 * `mkdir("a/b")` before the file itself can be written.
 *
 * Assumes `path` is already normalized (forward slashes, no leading or
 * trailing slash) — e.g. via Obsidian's `normalizePath`.
 */
export function ancestorDirs(path: string): string[] {
	const segments = path.split("/").slice(0, -1).filter((s) => s.length > 0);
	const dirs: string[] = [];
	let current = "";
	for (const segment of segments) {
		current = current ? `${current}/${segment}` : segment;
		dirs.push(current);
	}
	return dirs;
}
import { isCanonicalSyncPath } from "obsidian-sync-protocol";
