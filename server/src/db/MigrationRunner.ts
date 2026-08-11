import { sql } from "bun";
import migration0001 from "./migrations/0001_init.sql" with { type: "file" };
import migration0002 from "./migrations/0002_client_invite_owner.sql" with { type: "file" };
import { serverLogger, type Logger } from "../logger";

type Migration = {
    name: string;
    sql: string;
}

const migrationsManifest: Migration[] = [
    {
        name: "0001_init",
        sql: migration0001,
    },
	{
		name: "0002_client_invite_owner",
		sql: migration0002,
	},
]


export async function bootstrapDB(injectedLogger: Logger = serverLogger) {
	const logger = injectedLogger.child("migrations");
	const startedAt = Date.now();
	logger.info("bootstrap.started", { migrationCount: migrationsManifest.length });
    await canConnect(logger);
    await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('obsidian-sync-migrations'))`;
        await tx`
            CREATE TABLE IF NOT EXISTS migrations (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `;
		// Older releases created this table without UNIQUE(name). Repair that
		// schema under the migration lock before relying on target conflicts.
		await tx`
			DELETE FROM migrations older
			USING migrations newer
			WHERE older.name = newer.name AND older.id > newer.id
		`;
		await tx`
			CREATE UNIQUE INDEX IF NOT EXISTS migrations_name_unique
			ON migrations (name)
		`;
        const applied = await tx<MigrationRow[]>`SELECT name FROM migrations`;
        const appliedNames = new Set(applied.map(({ name }) => name));
		logger.info("manifest.loaded", {
			applied: [...appliedNames],
			pending: migrationsManifest
				.map(({ name }) => name)
				.filter((name) => !appliedNames.has(name)),
		});
        for (const migration of migrationsManifest) {
            if (appliedNames.has(migration.name)) {
				logger.debug("migration.skipped", {
					migration: migration.name,
					reason: "already_applied",
				});
                continue;
            }
			logger.info("migration.started", { migration: migration.name });
            await tx.unsafe(await Bun.file(migration.sql).text());
            await tx`
                INSERT INTO migrations (name, created_at)
                VALUES (${migration.name}, NOW())
                ON CONFLICT (name) DO NOTHING
            `;
            logger.info("migration.completed", { migration: migration.name });
        }
    });
	logger.info("bootstrap.completed", {
		durationMs: Date.now() - startedAt,
	});
}

async function canConnect(logger: Logger) {
	logger.debug("connection_check.started");
    let result = await sql`SELECT 1;`.values();
    if (result[0][0] === 1) {
		logger.info("connection_check.completed");
    } else {
		logger.error("connection_check.failed", { result });
        throw new Error("something somewhere is goofed up. Could not run SELECT 1; on the db");
    }

}

type MigrationRow = { name: string };
