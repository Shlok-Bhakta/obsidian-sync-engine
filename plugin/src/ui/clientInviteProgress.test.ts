import { describe, expect, test } from "bun:test";
import { describeClientArchiveProgress } from "./clientInviteProgress";

describe("client archive progress copy", () => {
	test("describes preparation before an estimate is available", () => {
		expect(
			describeClientArchiveProgress({
				phase: "preparing",
				processedFiles: 0,
				totalFiles: 0,
				percent: 2,
				estimatedSecondsRemaining: null,
			}),
		).toEqual({
			summary: "Preparing archive",
			detail: "Counting vault files and estimating build time",
		});
	});

	test("shows exact file progress, percent, and rough time", () => {
		expect(
			describeClientArchiveProgress({
				phase: "archiving",
				processedFiles: 420,
				totalFiles: 1_200,
				percent: 34,
				estimatedSecondsRemaining: 75,
			}),
		).toEqual({
			summary: "Archiving 420 of 1,200 files · 34%",
			detail: "About 1 minute remaining",
		});
	});

	test("uses concise copy for finalization", () => {
		expect(
			describeClientArchiveProgress({
				phase: "finalizing",
				processedFiles: 10,
				totalFiles: 10,
				percent: 95,
				estimatedSecondsRemaining: null,
			}),
		).toEqual({ summary: "Finishing client package", detail: "Almost done" });
	});
});
