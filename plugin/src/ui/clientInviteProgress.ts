import type { ClientArchiveBuildProgress } from "obsidian-sync-protocol";

function formatEta(seconds: number | null): string {
	if (seconds === null) return "Estimating time remaining";
	if (seconds <= 5) return "A few seconds remaining";
	if (seconds < 60) return `About ${seconds} seconds remaining`;
	const minutes = Math.max(1, Math.round(seconds / 60));
	return `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} remaining`;
}

export function describeClientArchiveProgress(
	progress: ClientArchiveBuildProgress,
): { summary: string; detail: string } {
	if (progress.phase === "preparing") {
		return {
			summary: "Preparing archive",
			detail: "Counting vault files and estimating build time",
		};
	}
	if (progress.phase === "finalizing") {
		return {
			summary: "Finishing client package",
			detail: progress.percent === 100 ? "Package ready" : "Almost done",
		};
	}
	const fileCount =
		progress.totalFiles > 0
			? `${progress.processedFiles.toLocaleString()} of ${progress.totalFiles.toLocaleString()} files`
			: "No vault files to add";
	return {
		summary: `Archiving ${fileCount} · ${progress.percent}%`,
		detail: formatEta(progress.estimatedSecondsRemaining),
	};
}
