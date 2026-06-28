import { sql } from "bun";

// this file is supposed to figure some stuff out
// 1. if the client exists then see if the client secret is correct
// 2. if the client does not exist then:
// 2.1. if no client exists then we make the client and return the client secret
// 2.2  if even a single client exists then we reject the auth

// Auth Entrypoint
export async function auth(clientName: string, clientSecret: string) {
    // check if any client exists
    const client_count = await sql`SELECT COUNT(*) FROM clients`.values();
    console.log(clientSecret);
    console.log(client_count);
    if(client_count.count > 0){
        console.log('client exists');
        const client_info = await sql`SELECT * FROM clients WHERE client_name = ${clientName} AND client_secret = ${clientSecret}`.values();
        if(client_info.length > 0){
            return { authenticated: true };
        }else{
            return { authenticated: false };
        }

    }else{
        console.log('client does not exist');
        const new_client = await createClient(clientName);
        console.log(new_client);
        return { authenticated: true, client_id: new_client.id };
    }
}

async function createClient(clientName: string) {
    const client = await sql`INSERT INTO clients (client_name) VALUES (${clientName}) RETURNING client_secret`;
    return client[0].client_secret;
}