import { describe, it, expect } from "bun:test";
import { sql } from "bun";
import { bootstrapDB } from "./MigrationRunner";

describe("MigrationRunner env", () => {
	it("uses the test database url", () => {
		expect(process.env.DATABASE_URL).toContain("test_db");
	});

	it("repairs a legacy migrations table without a unique name constraint", async () => {
		await sql`ALTER TABLE migrations DROP CONSTRAINT IF EXISTS migrations_name_key`;
		await sql`DROP INDEX IF EXISTS migrations_name_unique`;
		await sql`
			INSERT INTO migrations (name, created_at)
			VALUES ('legacy-marker', NOW()), ('legacy-marker', NOW())
		`;
		await bootstrapDB();
		const [{ count }] = await sql<{ count: string }[]>`
			SELECT COUNT(*)::text AS count
			FROM migrations WHERE name = 'legacy-marker'
		`;
		expect(Number(count)).toBe(1);
	});

	it("validates the invite-owner foreign key with restrictive deletion", async () => {
		const [constraint] = await sql<{
			validated: boolean;
			deleteAction: string;
		}[]>`
			SELECT convalidated AS validated, confdeltype AS "deleteAction"
			FROM pg_constraint
			WHERE conname = 'client_invites_owner_client_id_fkey'
		`;
		expect(constraint).toEqual({ validated: true, deleteAction: "r" });
	});
});
