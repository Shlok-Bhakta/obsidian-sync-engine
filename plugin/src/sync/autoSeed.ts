/**
 * Seed only clients that have never consumed a server revision.
 *
 * A revision of zero is the bootstrap sentinel. Once a client has synced any
 * server revision, startup must leave its existing vault and outbox alone.
 */
export async function seedVaultIfRevisionZero(
	revision: number,
	seed: () => Promise<void>,
): Promise<boolean> {
	if (revision !== 0) return false;

	await seed();
	return true;
}
