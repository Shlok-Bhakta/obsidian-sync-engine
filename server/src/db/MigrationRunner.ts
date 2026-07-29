import { sql } from "bun";
import migration0001 from "./migrations/0001_init.sql" with { type: "file" };
import migration0002 from "./migrations/0002_bytea_content.sql" with { type: "file" };
// import migration0003 from "./migrations/0003_bootstrap_blob_staging.sql" with { type: "file" };
// import migration0004 from "./migrations/0004_yjs_compaction_index.sql" with { type: "file" };
// import migration0005 from "./migrations/0005_blob_upload_staging.sql" with { type: "file" };

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
        name: "0002_bytea_content",
        sql: migration0002,
    },
    // {
    //     name: "0003_bootstrap_blob_staging",
    //     sql: migration0003,
    // },
    // {
    //     name: "0004_yjs_compaction_index",
    //     sql: migration0004,
    // },
    // {
    //     name: "0005_blob_upload_staging",
    //     sql: migration0005,
    // }
]


export async function bootstrapDB() {
    await canConnect();
    await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext('obsidian-sync-migrations'))`;
        await tx`
            CREATE TABLE IF NOT EXISTS migrations (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `;
        const applied = await tx<MigrationRow[]>`SELECT name FROM migrations`;
        const appliedNames = new Set(applied.map(({ name }) => name));
        for (const migration of migrationsManifest) {
            if (appliedNames.has(migration.name)) {
                continue;
            }
            await tx.unsafe(await Bun.file(migration.sql).text());
            await tx`
                INSERT INTO migrations (name, created_at)
                VALUES (${migration.name}, NOW())
                ON CONFLICT (name) DO NOTHING
            `;
            console.log(`Applied migration ${migration.name}`);
        }
    });
}

async function canConnect() {
    let result = await sql`SELECT 1;`.values();
    // console.log(result[0][0]);
    if (result[0][0] === 1) {
    } else {
        throw new Error("something somewhere is goofed up. Could not run SELECT 1; on the db");
    }

}

type MigrationRow = { name: string };
