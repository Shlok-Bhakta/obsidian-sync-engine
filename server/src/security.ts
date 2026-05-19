import { sql } from "bun";

export function generateClientKey(): string {
    return "obs_sync_" + crypto.randomUUID();
}


type ClientKeyRow = {
    id: string;
    clientKey: string;
    valid: boolean;
}

type ClientKeyCount = {
    count: string;
}

export type ClientKeyRotationResult = {
    authenticated: boolean;
    clientKey?: string;
    currentKeyId?: string;
    previousKeyId?: string | null;
};

function isClientKeyShape(clientKey: string): boolean {
    return clientKey.startsWith("obs_sync_");
}

export async function validateClientKey(clientKey: string): Promise<boolean> {
    return isClientKeyAccepted(clientKey);
}

export async function rotateClientKey(clientKey: string): Promise<ClientKeyRotationResult> {
    if(!isClientKeyShape(clientKey)){
        return { authenticated: false };
    }

    return sql.begin(async tx => {
        await tx`SELECT pg_advisory_xact_lock(918342781);`;
        const zerocheck = await tx<ClientKeyCount[]>`SELECT COUNT(valid) FROM client_keys`;
        const rowcount = parseInt(zerocheck[0]?.count ?? "0", 10);
        if(rowcount === 0){
            const inserted = await tx<ClientKeyRow[]>`
                INSERT INTO client_keys (client_key, previous_key_id, valid)
                VALUES (${clientKey}, NULL, TRUE)
                RETURNING id, client_key AS "clientKey", valid;
            `;
            return { authenticated: true, clientKey, currentKeyId: inserted[0].id, previousKeyId: null };
        }

        const existing = await tx<ClientKeyRow[]>`
            SELECT id, client_key AS "clientKey", valid
            FROM client_keys
            WHERE client_key = ${clientKey}
            FOR UPDATE;
        `;
        if(existing.length === 0){
            return { authenticated: false };
        }

        const keyRow = existing[0];
        if(keyRow.valid){
            const key = generateClientKey();
            const inserted = await tx<ClientKeyRow[]>`
                INSERT INTO client_keys (client_key, previous_key_id, valid)
                VALUES (${key}, ${keyRow.id}, TRUE)
                RETURNING id, client_key AS "clientKey", valid;
            `;
            await tx`UPDATE client_keys SET valid = FALSE WHERE id = ${keyRow.id};`;
            return { authenticated: true, clientKey: key, currentKeyId: inserted[0].id, previousKeyId: keyRow.id };
        }

        const current = await tx<ClientKeyRow[]>`
            WITH RECURSIVE descendants AS (
                SELECT id, client_key, valid, created_at, 1 AS depth
                FROM client_keys
                WHERE previous_key_id = ${keyRow.id}

                UNION ALL

                SELECT child.id, child.client_key, child.valid, child.created_at, descendants.depth + 1
                FROM client_keys child
                JOIN descendants ON child.previous_key_id = descendants.id
            )
            SELECT id, client_key AS "clientKey", valid
            FROM descendants
            WHERE valid = TRUE
            ORDER BY depth DESC, created_at DESC
            LIMIT 1;
        `;
        if(current.length === 0){
            return { authenticated: false };
        }

        return { authenticated: true, clientKey: current[0].clientKey, currentKeyId: current[0].id, previousKeyId: keyRow.id };
    });
}

async function isClientKeyAccepted(clientKey: string): Promise<boolean> {
    if(!isClientKeyShape(clientKey)){
        return false;
    }
    // check length of table, if size is 0 this means it is init time and we can just return valid
    const zerocheck = await sql<ClientKeyCount[]>`SELECT COUNT(valid) FROM client_keys`;
    const rowcount = parseInt(zerocheck[0].count, 10);
    if(rowcount === 0){
        // this means there is no keys at all so this is part of the init bootstrap process
        return true;
    }
    


    // check in db to see if the client key is valid
    const result = await sql<ClientKeyRow[]>`
    SELECT valid FROM client_keys WHERE client_key = ${clientKey};`;
    if(result.length === 0){
        return false;
    }
    return result[0].valid;

}

export async function invalidateClientKey(clientKey: string): Promise<void> {
    await sql`UPDATE client_keys SET valid = FALSE WHERE client_key = ${clientKey};`;
}

export async function mintNewClientKey(previousClientKey?: string): Promise<string> {
    const key = generateClientKey();
    if(previousClientKey){
        const previous = await sql<ClientKeyRow[]>`
            SELECT id, client_key AS "clientKey", valid
            FROM client_keys
            WHERE client_key = ${previousClientKey};
        `;
        const previousKeyId = previous[0]?.id ?? null;
        await sql`INSERT INTO client_keys (client_key, previous_key_id, valid) VALUES (${key}, ${previousKeyId}, TRUE);`;
        return key;
    }
    await sql`INSERT INTO client_keys (client_key, previous_key_id, valid) VALUES (${key}, NULL, TRUE);`;
    return key;
}
