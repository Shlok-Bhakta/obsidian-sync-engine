import { sql } from "bun";

// this file is supposed to figure some stuff out
// 1. if the client exists then see if the client secret is correct
// 2. if the client does not exist then:
// 2.1. if no client exists then we make the client and return the client secret
// 2.2  if even a single client exists then we reject the auth

// Auth Entrypoint

export type AuthResult = {
    authenticated: boolean;
    token: string | null;
}
export async function auth(clientName: string, clientSecret: string): Promise<AuthResult> {
    // check if any client exists if not make one
    const client_count = await sql`SELECT * FROM clients`.values();
    console.log(clientSecret);
    console.log(client_count);
    if(client_count.count > 0){
        console.log('client exists');
        return { 
            authenticated: await checkClientExists(clientName, clientSecret), 
            token: null 
        };
    }else{
        console.log('client does not exist');
        const new_client_secret = await createClient(clientName);
        console.log(new_client_secret);
        return { authenticated: true, token: new_client_secret };
    }
}

export async function checkClientExists(clientName: string, clientSecret: string) {
    const client_info = await sql`SELECT * FROM clients WHERE client_name = ${clientName} AND client_secret = ${clientSecret}`.values();
    return client_info.length > 0;
}
async function createClient(clientName: string) {
    const client = await sql`INSERT INTO clients (client_name) VALUES (${clientName}) RETURNING client_secret`;
    return client[0].client_secret;
}

export async function resetClientSecret(clientName: string) {
    const client = await sql`UPDATE clients SET client_secret = concat('obs_sync_', encode(gen_random_bytes(32), 'base64')) WHERE client_name = ${clientName} RETURNING client_secret`;
    return client[0].client_secret;
}