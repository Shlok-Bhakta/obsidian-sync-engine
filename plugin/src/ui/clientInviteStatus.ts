export function formatClientInviteRemainingTime(seconds: number): string {
	const safeSeconds = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(safeSeconds / 60);
	const remainingSeconds = safeSeconds % 60;
	return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}
