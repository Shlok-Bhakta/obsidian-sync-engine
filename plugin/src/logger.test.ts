import { describe, expect, test } from "bun:test";
import { FakeLogger } from "./logger";

describe("FakeLogger", () => {
	test("captures child context and serializes errors without logging secrets", () => {
		const logger = new FakeLogger();
		logger.child("sync").error("tick.failed", {
			path: "note.md",
			error: new Error("offline"),
		});

		expect(logger.entries).toHaveLength(1);
		expect(logger.entries[0]).toMatchObject({
			level: "error",
			component: "client:sync",
			event: "tick.failed",
			fields: {
				path: "note.md",
				error: { name: "Error", message: "offline" },
			},
		});
	});
});
