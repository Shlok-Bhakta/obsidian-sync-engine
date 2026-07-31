import { sql } from "bun";
import { rm } from "node:fs/promises";
import { DEFAULT_OBJECT_STORE_DIR } from "../object/object_store";
import { mkdir } from "node:fs/promises";

const TEST_DB_MARKER = "test_db";

/** Refuse to wipe anything that isn't the dedicated test database. */
export function assertTestDatabase() {
	const url = process.env.DATABASE_URL ?? "";
	if (!url.includes(TEST_DB_MARKER)) {
		throw new Error(
			`Refusing to wipe DB: DATABASE_URL must contain "${TEST_DB_MARKER}" (got ${url || "(unset)"})`,
		);
	}
}

/**
 * Delete all rows from every public table except `migrations`,
 * and restart sequences so revision counters start clean.
 */
export async function cleanDatabase() {
	assertTestDatabase();

	const tables = await sql<{ tablename: string }[]>`
		SELECT tablename
		FROM pg_tables
		WHERE schemaname = 'public'
			AND tablename <> 'migrations'
		ORDER BY tablename
	`;

	if (tables.length > 0) {
		const names = tables.map((t) => `"${t.tablename}"`).join(", ");
		await sql.unsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
	}

	// Standalone sequences (e.g. global_revision) are not owned by identity columns.
	await sql.unsafe(`
		DO $$
		DECLARE
			seq RECORD;
		BEGIN
			FOR seq IN
				SELECT c.relname AS sequencename
				FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE c.relkind = 'S'
					AND n.nspname = 'public'
					AND c.relname <> 'migrations_id_seq'
			LOOP
				EXECUTE format('ALTER SEQUENCE %I RESTART WITH 1', seq.sequencename);
			END LOOP;
		END $$;
	`);
}


export async function cleanObjectStore() {
	try{
		await rm(DEFAULT_OBJECT_STORE_DIR, { recursive: true }); 
	} catch (e) {
		console.log("Object store directory does not exist, creating it");
	} finally {
		try {
			await mkdir(DEFAULT_OBJECT_STORE_DIR, { recursive: true });
		} catch (e) {
			console.error("Object store directory could not be created", e);
		}
	}
}

export async function deleteObjectStore() {
	try {
		await rm(DEFAULT_OBJECT_STORE_DIR, { recursive: true });
	} catch (e) {
		console.log("Object store directory does not exist, skipping deletion");
	}
}