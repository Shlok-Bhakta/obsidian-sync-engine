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

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;

/**
 * Validates and returns `path` unchanged if it is an already-normalized,
 * vault-relative path. Throws `InvalidPathError` otherwise.
 *
 * Rejects: empty paths, absolute paths (leading `/` or a Windows drive
 * letter), NUL bytes, backslashes, `.`/`..` segments, a trailing slash, and
 * non-normalized duplicate separators (e.g. `a//b`).
 */
export function canonicalizePath(path: string): string {
	if (typeof path !== "string" || path.length === 0) {
		throw new InvalidPathError(String(path ?? ""), "path must not be empty");
	}
	if (path.includes("\0")) {
		throw new InvalidPathError(path, "path must not contain a NUL byte");
	}
	if (path.includes("\\")) {
		throw new InvalidPathError(path, "path must not contain a backslash");
	}
	if (path.startsWith("/") || WINDOWS_DRIVE_RE.test(path)) {
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
