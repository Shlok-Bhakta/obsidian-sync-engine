export function escapeLikePattern(path: string): string {
    return path.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function folderDescendantLike(path: string): string {
    return `${escapeLikePattern(path)}/%`;
}
