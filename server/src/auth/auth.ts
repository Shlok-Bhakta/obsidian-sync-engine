import { sql } from "bun";
import { Context, Hono } from "hono";
import { deserialize, Message, MessageType } from "obsidian-sync-protocol";
import { assertBootstrapAuthorized } from "./bootstrapToken";

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
export async function auth(
	clientName: string,
	clientSecret: string,
	allowFirstEnrollment = false,
): Promise<AuthResult> {
	return sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(hashtext('obsidian-sync-first-client'))`;
		const existing = await tx`
			SELECT id FROM clients
			WHERE client_name = ${clientName} AND client_secret = ${clientSecret}
		`;
		if (existing.length > 0) {
			return { authenticated: true, token: null };
		}
		const [{ count }] = await tx<{ count: string }[]>`
			SELECT COUNT(*)::text AS count FROM clients
		`;
		if (Number(count) > 0 || !allowFirstEnrollment) {
			return { authenticated: false, token: null };
		}
		const [created] = await tx<{ client_secret: string }[]>`
			INSERT INTO clients (client_name)
			VALUES (${clientName})
			RETURNING client_secret
		`;
		return { authenticated: true, token: created.client_secret };
	}) as Promise<AuthResult>;
}

export async function checkClientExists(clientName: string, clientSecret: string) {
    const client_info = await sql`SELECT id FROM clients WHERE client_name = ${clientName} AND client_secret = ${clientSecret}`;
    return client_info.length > 0;
}
export async function createClient(clientName: string) {
    const client = await sql`INSERT INTO clients (client_name) VALUES (${clientName}) RETURNING client_secret`;
    return client[0].client_secret;
}

export async function resetClientSecret(clientName: string): Promise<string> {
    const client = await sql`UPDATE clients SET client_secret = concat('obs_sync_', encode(gen_random_bytes(32), 'base64')) WHERE client_name = ${clientName} RETURNING client_secret`;
    return client[0].client_secret;
}

export async function resetClientName(clientName: string, token: string): Promise<string> {
    const [client] = await sql<{ client_name: string }[]>`
		UPDATE clients SET client_name = ${clientName}, updated_at = NOW()
		WHERE client_secret = ${token}
		RETURNING client_name
	`;
	if (!client) {
		throw new Error("Invalid authorization");
	}
    return client.client_name;
}

export async function getClientIdFromAuthorization(authorization: string): Promise<string> {
    const client = await sql`SELECT id FROM clients WHERE client_secret = ${authorization}`;
	if (client.length === 0) {
		throw new Error("Invalid authorization");
	}
	return client[0].id as string;
}

function errorMessage(reason: string): Message {
	return {
		type: MessageType.ERROR,
		reason,
	};
}

type MessageOf<T extends MessageType> = Extract<Message, { type: T }>;
function withMessage<T extends MessageType>(
	expectedType: T,
	handler: (c: Context, data: MessageOf<T>) => Promise<Response> | Response,
) {
	return async (c: Context) => {
		let data: Message;
		try {
			data = deserialize(await c.req.text());
		} catch (error) {
			console.error(error);
			return c.json(errorMessage('Invalid request body'), 400);
		}
		if (data.type !== expectedType) {
			return c.json(errorMessage('Invalid request'), 400);
		}
		return handler(c, data as MessageOf<T>);
	};
}

export function registerAuthRoutes(app: Hono) {
	// First-client enrollment and reconnect verification over HTTP.
	app.post('/auth', withMessage(MessageType.AUTH_ACK, async (c, data) => {
		const enrollment = assertBootstrapAuthorized({
			authorizationHeader: c.req.header("Authorization"),
			queryToken: undefined,
		});
		const authResult = await auth(data.client_name, data.token, enrollment.ok);

		if (!authResult.authenticated) {
			return c.json({
				type: MessageType.AUTH_FAILED,
				reason: 'Invalid credentials',
			}, 401);
		}

		if (authResult.token) {
			return c.json({
				type: MessageType.AUTH_INIT,
				client_name: data.client_name,
				token: authResult.token,
			}, 200);
		}

		return c.json({
			type: MessageType.AUTH_SUCCESS,
		}, 200);
	}));

	app.post('/reset-client-secret', withMessage(MessageType.AUTH_ACK, async (c, data) => {
		const authResult = await checkClientExists(data.client_name, data.token);

		if (!authResult) {
			return c.json(errorMessage('Invalid token'), 401);
		}

		const newClientSecret = await resetClientSecret(data.client_name);

		return c.json({
			type: MessageType.AUTH_INIT,
			client_name: data.client_name,
			token: newClientSecret,
		}, 200);
	}));

	app.post('/reset-client-name', withMessage(MessageType.RESET_CLIENT_NAME, async (c, data) => {
		try {
			const newClientName = await resetClientName(data.new_client_name, data.token);
			return c.json({
				type: MessageType.AUTH_INIT,
				client_name: newClientName,
				token: data.token,
			}, 200);
		} catch (error) {
			if (error instanceof Error && error.message === "Invalid authorization") {
				return c.json(errorMessage("Invalid token"), 401);
			}
			if (error && typeof error === "object" && "code" in error && error.code === "23505") {
				return c.json(errorMessage("Client name already exists"), 409);
			}
			throw error;
		}
	}));
}
