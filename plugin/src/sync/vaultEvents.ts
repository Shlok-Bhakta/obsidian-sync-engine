type FileSnapshot = {
	stat: { ctime: number; mtime: number; size: number };
};

/** True when a delete notification describes an older file than the live one. */
export function isStaleFileDeletion(
	deleted: FileSnapshot,
	current: FileSnapshot | null,
): boolean {
	return (
		current !== null &&
		(current.stat.ctime !== deleted.stat.ctime ||
			current.stat.mtime !== deleted.stat.mtime ||
			current.stat.size !== deleted.stat.size)
	);
}
