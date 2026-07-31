import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { registerHealthRoute } from "./health";
import { FakeLogger } from "./logger";

describe("health route", () => {
	it("reports healthy when the database responds", async () => {
		const app = registerHealthRoute(new Hono(), async () => undefined);

		const response = await app.request("/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	it("reports unhealthy without exposing database errors", async () => {
		const logger = new FakeLogger();
		const app = registerHealthRoute(
			new Hono(),
			async () => {
				throw new Error("database credentials leaked here");
			},
			logger,
		);

		const response = await app.request("/health");

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ status: "unhealthy" });
		expect(logger.entries).toHaveLength(1);
		expect(logger.entries[0]?.event).toBe("check.failed");
	});
});
