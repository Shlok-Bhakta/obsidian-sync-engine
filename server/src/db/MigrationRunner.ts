import { sql } from "bun";



export async function bootstrapDB() {
    console.log("bootstrapping db");
    // if this boi runs then the db is ok to run;
    await canConnect();
    // check to see if our migrations db exists
    await setupDB();

}

async function canConnect() {
    let result = await sql`SELECT 1;`.values();
    // console.log(result[0][0]);
    if (result[0][0] === 1) {
        console.log("db is ready");
    } else {
        throw new Error("something somewhere is goofed up. Could not run SELECT 1; on the db");
    }
}

async function setupDB() {
    const migrationsTableName = "migrations";
    // check to see if migrations table exists
    let result = await sql`SELECT * FROM ${migrationsTableName};`.values();
    if (result.length > 0) {
        console.log("migrations table exists");
        return;
    }else{
        console.log("migrations table does not exist, either this is the first time running or something is wrong");
        await sql.unsafe(`CREATE TABLE ${migrationsTableName} (
            id SERIAL PRIMARY KEY, 
            name VARCHAR(255) NOT NULL,
            created_at TIMESTAMP NOT NULL);`
        );
    }

    
}

// export function isMigrationsSetup(db: sql.Database, migrations: string[]) {

// }