import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { FakeLogger } from "./logger";
import {
	ObjectStore,
	registerObjectStoreRoutes,
} from "./object/object_store";

describe("FakeLogger", () => {
	it("captures structured child logs", () => {
		const logger = new FakeLogger();
		logger.child("object_store").info("upload.completed", {
			path: "note.md",
			revision: 1,
		});

		expect(logger.entries).toEqual([
			{
				level: "info",
				component: "server:object_store",
				event: "upload.completed",
				fields: { path: "note.md", revision: 1 },
			},
		]);
	});

	it("can be injected through server routes", async () => {
		const logger = new FakeLogger();
		const app = registerObjectStoreRoutes(
			new Hono(),
			new ObjectStore(logger),
			async () => "client-id",
			logger,
		);
		const response = await app.request("/files", { method: "POST" });

		expect(response.status).toBe(400);
		expect(logger.entries).toContainEqual({
			level: "warn",
			component: "server:object_routes",
			event: "upload.rejected",
			fields: { reason: "path_missing" },
		});
	});
});
