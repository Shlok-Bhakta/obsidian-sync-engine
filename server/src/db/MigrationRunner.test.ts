import { describe, it, expect } from "bun:test";

describe("MigrationRunner env", () => {
	it("uses the test database url", () => {
		expect(process.env.DATABASE_URL).toContain("test_db");
	});
});
