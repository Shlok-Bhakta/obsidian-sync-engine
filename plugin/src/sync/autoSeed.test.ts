import { describe, expect, mock, test } from "bun:test";
import { FakeLogger } from "../logger";
import { seedVaultIfRevisionZero } from "./autoSeed";

describe("automatic vault seeding", () => {
	test("seeds when the last synced revision is zero", async () => {
		const seed = mock(async () => undefined);
		const logger = new FakeLogger();

		expect(await seedVaultIfRevisionZero(0, seed, logger)).toBe(true);
		expect(seed).toHaveBeenCalledTimes(1);
		const decision = logger.entries.find(({ event }) => event === "decision");
		expect(decision?.fields).toEqual({
			revision: 0,
			shouldSeed: true,
		});
	});

	test("does not seed when the last synced revision is greater than zero", async () => {
		const seed = mock(async () => undefined);
		const logger = new FakeLogger();

		expect(await seedVaultIfRevisionZero(1, seed, logger)).toBe(false);
		expect(await seedVaultIfRevisionZero(42, seed, logger)).toBe(false);
		expect(seed).not.toHaveBeenCalled();
		expect(
			logger.entries.filter(({ event }) => event === "decision"),
		).toHaveLength(2);
	});

	test("propagates a seed failure so startup can report it", async () => {
		const seed = mock(async () => {
			throw new Error("upload failed");
		});

		let failure: unknown;
		try {
			await seedVaultIfRevisionZero(0, seed);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("upload failed");
	});
});
