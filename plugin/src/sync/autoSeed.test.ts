import { describe, expect, mock, test } from "bun:test";
import { seedVaultIfRevisionZero } from "./autoSeed";

describe("automatic vault seeding", () => {
	test("seeds when the last synced revision is zero", async () => {
		const seed = mock(async () => undefined);

		expect(await seedVaultIfRevisionZero(0, seed)).toBe(true);
		expect(seed).toHaveBeenCalledTimes(1);
	});

	test("does not seed when the last synced revision is greater than zero", async () => {
		const seed = mock(async () => undefined);

		expect(await seedVaultIfRevisionZero(1, seed)).toBe(false);
		expect(await seedVaultIfRevisionZero(42, seed)).toBe(false);
		expect(seed).not.toHaveBeenCalled();
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
