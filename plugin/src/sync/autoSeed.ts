/**
 * Seed only clients that have never consumed a server revision.
 *
 * A revision of zero is the bootstrap sentinel. Once a client has synced any
 * server revision, startup must leave its existing vault and outbox alone.
 */
export async function seedVaultIfRevisionZero(
	revision: number,
	seed: () => Promise<void>,
	injectedLogger: Logger = new NoopLogger(),
): Promise<boolean> {
	const logger = injectedLogger.child("auto_seed");
	if (revision !== 0) {
		logger.info("decision", {
			revision,
			shouldSeed: false,
			reason: "revision_not_zero",
		});
		return false;
	}

	logger.info("decision", { revision, shouldSeed: true });
	await seed();
	logger.info("callback.completed", { revision });
	return true;
}
import { NoopLogger, type Logger } from "../logger";
