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

import { isCanonicalSyncPath } from "obsidian-sync-protocol";

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
			"path must be canonical user-vault content (excluding .obsidian)",
		);
	}
	/*
	 * Keep the detailed checks below for useful server diagnostics. The shared
	 * predicate above is the authoritative product boundary used by clients,
	 * wire schemas, and the server.
	 */
	if (typeof path !== "string" || path.length === 0) {
		throw new InvalidPathError(String(path ?? ""), "path must not be empty");
	}
	if (path.includes("\0")) {
		throw new InvalidPathError(path, "path must not contain a NUL byte");
	}
	if (path.includes("\\")) {
		throw new InvalidPathError(path, "path must not contain a backslash");
	}
	if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
		throw new InvalidPathError(path, "path must be vault-relative, not absolute");
	}
	if (path.endsWith("/")) {
		throw new InvalidPathError(path, "path must not end with a trailing slash");
	}

	const segments = path.split("/");
	for (const segment of segments) {
		if (segment.length === 0) {
			throw new InvalidPathError(path, "path must not contain empty segments (e.g. \"a//b\")");
		}
		if (segment === "." || segment === "..") {
			throw new InvalidPathError(path, `path must not contain a "${segment}" segment`);
		}
	}
	if (segments[0] === ".obsidian") {
		throw new InvalidPathError(path, "Obsidian configuration is private");
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
