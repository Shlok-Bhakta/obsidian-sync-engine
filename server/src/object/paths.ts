import { isCanonicalSyncPath } from "obsidian-sync-protocol";

/**
 * Server-side canonicalization for client-supplied vault-relative paths.
 *
 * This is intentionally stricter than mere traversal-prevention: it rejects
 * anything that isn't already a normalized, forward-slash, vault-relative
 * path so the object store never has to guess what a weird path "meant".
 */
export class InvalidPathError extends Error {
	constructor(
		readonly path: string,
		readonly reason: string,
	) {
		super(`Invalid path "${path}": ${reason}`);
		this.name = "InvalidPathError";
	}
}

/**
 * Validates and returns `path` unchanged if it is an already-normalized,
 * vault-relative path. Throws `InvalidPathError` otherwise.
 *
 * Rejects: empty paths, absolute paths (leading `/` or a Windows drive
 * letter), NUL bytes, backslashes, `.`/`..` segments, a trailing slash, and
 * non-normalized duplicate separators (e.g. `a//b`).
 */
export function canonicalizePath(path: string): string {
	if (!isCanonicalSyncPath(path)) {
		throw new InvalidPathError(
			String(path ?? ""),
			"path must be canonical vault content (excluding client data.json)",
		);
	}
	return path;
}

/** Non-throwing variant for call sites that want a boolean check. */
export function isValidPath(path: string): boolean {
	try {
		canonicalizePath(path);
		return true;
	} catch {
		return false;
	}
}
