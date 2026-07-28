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
