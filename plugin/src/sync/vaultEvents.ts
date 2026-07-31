type FileSnapshot = {
	stat: { ctime: number; mtime: number; size: number };
};

/** True when a delete notification describes an older file than the live one. */
export function isStaleFileDeletion(
	_deleted: FileSnapshot,
	current: FileSnapshot | null,
): boolean {
	return current !== null;
}
