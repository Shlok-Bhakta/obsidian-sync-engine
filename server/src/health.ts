import { sql } from "bun";
import type { Hono } from "hono";
import { serverLogger, type Logger } from "./logger";

export type HealthCheck = () => Promise<void>;

async function checkDatabase(): Promise<void> {
	await sql`SELECT 1`;
}

export function registerHealthRoute(
	app: Hono,
	healthCheck: HealthCheck = checkDatabase,
	injectedLogger: Logger = serverLogger,
): Hono {
	const logger = injectedLogger.child("health");
	return app.get("/health", async (c) => {
		try {
			await healthCheck();
			logger.debug("check.passed");
			return c.json({ status: "ok" });
		} catch (error) {
			logger.error("check.failed", { error });
			return c.json({ status: "unhealthy" }, 503);
		}
	});
}
