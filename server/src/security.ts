import { sql } from "bun";

export function generateClientKey(): string {
    return "obs_sync_" + crypto.randomUUID();
}


type ClientKeyRow = {
    valid: boolean;
}
export async function validateClientKey(clientKey: string): Promise<boolean> {
    if(!clientKey.startsWith("obs_sync_")){
        return false;
    }
    // check in db to see if the client key is valid
    const result = await sql<ClientKeyRow[]>`
    SELECT valid FROM client_keys WHERE client_key = ${clientKey};`;
    if(result.length === 0){
        return false;
    }
    console.log("result", result[0].valid);
    // return result[0].valid;
    return clientKey.startsWith("obs_sync_");

}

export async function invalidateClientKey(clientKey: string): Promise<void> {
    await sql`UPDATE client_keys SET valid = FALSE WHERE client_key = ${clientKey};`;
}

export async function mintNewClientKey(): Promise<string> {
    const key = generateClientKey();
    await sql`INSERT INTO client_keys (client_key, valid) VALUES (${key}, TRUE);`;
    return key;
}