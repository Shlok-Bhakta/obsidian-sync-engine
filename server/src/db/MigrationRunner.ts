import { sql } from "bun";
import migration0001 from "./migrations/0001_init.sql" with { type: "file" };
import migration0002 from "./migrations/0002_blob_storage.sql" with { type: "file" };
import migration0003 from "./migrations/0003_bootstrap_blob_staging.sql" with { type: "file" };
import { log } from "../logger";

const migrationsManifest = [
    {
        name: "0001_init",
        sql: migration0001,
    },
    {
        name: "0002_blob_storage",
        sql: migration0002,
    },
    {
        name: "0003_bootstrap_blob_staging",
        sql: migration0003,
    }
]


export async function bootstrapDB() {
    log.info("bootstrapping db");
    // if this boi runs then the db is ok to run;
    await canConnect();
    // check and create our migrations table
    await setupDB();
    // check to see if there are any migrations to run
    await applyMigrations();


}

async function canConnect() {
    let result = await sql`SELECT 1;`.values();
    // console.log(result[0][0]);
    if (result[0][0] === 1) {
        log.info("db is ready");
    } else {
        throw new Error("something somewhere is goofed up. Could not run SELECT 1; on the db");
    }

}

async function setupDB() {
    const migrationsTableName = "migrations";
    // check to see if migrations table exists
    log.debug("checking if migrations table exists");
    let exists = false;
    try {
    await sql.unsafe(`SELECT * FROM ${migrationsTableName};`).values();
    exists = true;
    } catch (e) {
        exists = false;
    }
    if (exists) {
        log.debug("migrations table exists");
        return;
    }else{
        log.info("migrations table missing; creating");
        await sql.unsafe(`CREATE TABLE ${migrationsTableName} (
            id SERIAL PRIMARY KEY, 
            name VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL);`
        );
    } 
}

type MigrationRow = { name: string };
async function applyMigrations() {
    log.info("checking migrations");

    // get all migrations that have already been run
    let migrations = await sql<MigrationRow[]>`SELECT name FROM migrations;`;
    let migrationsNames: string[] = migrations.map(m => m.name);
    log.debug("applied migrations loaded", { migrations: migrationsNames });

    for (const migration of migrationsManifest) {
        // first check to see if the migration has already been applied
        if (migrations.find(m => m.name === migration.name)) {
            log.debug("migration already applied", { migration: migration.name });
            continue;
        }
        log.info("applying migration", { migration: migration.name });
        await sql.unsafe(await Bun.file(migration.sql).text());
        log.info("applied migration", { migration: migration.name });
        await sql`INSERT INTO migrations (name, created_at) VALUES (${migration.name}, NOW());`;
        log.debug("inserted migration row", { migration: migration.name });
    }
}
// export function isMigrationsSetup(db: sql.Database, migrations: string[]) {

// }
