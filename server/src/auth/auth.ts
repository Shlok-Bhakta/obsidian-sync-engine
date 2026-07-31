import { sql } from "bun";
import { Context, Hono } from "hono";
import { deserialize, Message, MessageType } from "obsidian-sync-protocol";
import { serverLogger, type Logger } from "../logger";

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
	injectedLogger: Logger = serverLogger,
): Promise<AuthResult> {
	const logger = injectedLogger.child("auth");
	const startedAt = Date.now();
	logger.info("verification.started", { clientName });
	return sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(hashtext('obsidian-sync-first-client'))`;
		const existing = await tx`
			SELECT id FROM clients
			WHERE client_name = ${clientName} AND client_secret = ${clientSecret}
		`;
		if (existing.length > 0) {
			logger.info("verification.completed", {
				clientName,
				outcome: "verified",
				durationMs: Date.now() - startedAt,
			});
			return { authenticated: true, token: null };
		}
		const [{ count }] = await tx<{ count: string }[]>`
			SELECT COUNT(*)::text AS count FROM clients
		`;
		if (Number(count) > 0) {
			logger.warn("verification.completed", {
				clientName,
				outcome: "rejected",
				reason: "server_already_enrolled",
				durationMs: Date.now() - startedAt,
			});
			return { authenticated: false, token: null };
		}
		const [created] = await tx<{ client_secret: string }[]>`
			INSERT INTO clients (client_name)
			VALUES (${clientName})
			RETURNING client_secret
		`;
		logger.info("verification.completed", {
			clientName,
			outcome: "first_client_enrolled",
			durationMs: Date.now() - startedAt,
		});
		return { authenticated: true, token: created.client_secret };
	}) as Promise<AuthResult>;
}

export async function createClient(
	clientName: string,
	injectedLogger: Logger = serverLogger,
) {
	const logger = injectedLogger.child("auth");
	logger.info("client_create.started", { clientName });
    const client = await sql`INSERT INTO clients (client_name) VALUES (${clientName}) RETURNING client_secret`;
	logger.info("client_create.completed", { clientName });
    return client[0].client_secret;
}

export async function resetClientSecret(
	clientName: string,
	currentSecret: string,
	injectedLogger: Logger = serverLogger,
): Promise<string | null> {
	const logger = injectedLogger.child("auth");
	logger.info("client_secret_reset.started", { clientName });
	const [client] = await sql<{ client_secret: string }[]>`
		UPDATE clients
		SET client_secret = concat('obs_sync_', encode(gen_random_bytes(32), 'base64')),
			updated_at = NOW()
		WHERE client_name = ${clientName} AND client_secret = ${currentSecret}
		RETURNING client_secret
	`;
	const secret = client?.client_secret ?? null;
	logger.info("client_secret_reset.completed", {
		clientName,
		outcome: secret ? "reset" : "rejected",
	});
	return secret;
}

export async function resetClientName(
	clientName: string,
	token: string,
	injectedLogger: Logger = serverLogger,
): Promise<string> {
	const logger = injectedLogger.child("auth");
	logger.info("client_name_reset.started", { clientName });
    const [client] = await sql<{ client_name: string }[]>`
		UPDATE clients SET client_name = ${clientName}, updated_at = NOW()
		WHERE client_secret = ${token}
		RETURNING client_name
	`;
	if (!client) {
		logger.warn("client_name_reset.rejected", { clientName });
		throw new Error("Invalid authorization");
	}
	logger.info("client_name_reset.completed", { clientName: client.client_name });
    return client.client_name;
}

export async function getClientIdFromAuthorization(
	authorization: string,
	injectedLogger: Logger = serverLogger,
): Promise<string> {
	const logger = injectedLogger.child("auth");
    const client = await sql`SELECT id FROM clients WHERE client_secret = ${authorization}`;
	if (client.length === 0) {
		logger.warn("authorization.rejected");
		throw new Error("Invalid authorization");
	}
	const clientId = client[0].id as string;
	logger.debug("authorization.accepted", { clientId });
	return clientId;
}

export type ClientAuthorizer = (authorization: string) => Promise<string>;

/** Shared route guard with an injectable credential lookup for focused tests. */
export async function requireClientId(
	c: Context,
	authorize: ClientAuthorizer = getClientIdFromAuthorization,
	injectedLogger: Logger = serverLogger,
): Promise<string | Response> {
	const logger = injectedLogger.child("auth_guard");
	const authorization = c.req.header("Authorization");
	if (!authorization) {
		logger.warn("authorization.missing", {
			method: c.req.method,
			path: new URL(c.req.url).pathname,
		});
		return c.json({ error: "Unauthorized" }, 401);
	}
	try {
		const clientId = await authorize(authorization);
		logger.debug("authorization.accepted", {
			clientId,
			method: c.req.method,
			path: new URL(c.req.url).pathname,
		});
		return clientId;
	} catch (error) {
		logger.warn("authorization.rejected", {
			method: c.req.method,
			path: new URL(c.req.url).pathname,
			error,
		});
		return c.json({ error: "Unauthorized" }, 401);
	}
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
	logger: Logger,
) {
	return async (c: Context) => {
		let data: Message;
		try {
			data = deserialize(await c.req.text());
		} catch (error) {
			logger.warn("request.invalid_body", {
				method: c.req.method,
				path: new URL(c.req.url).pathname,
				error,
			});
			return c.json(errorMessage('Invalid request body'), 400);
		}
		if (data.type !== expectedType) {
			logger.warn("request.unexpected_message", {
				method: c.req.method,
				path: new URL(c.req.url).pathname,
				expectedType,
				actualType: data.type,
			});
			return c.json(errorMessage('Invalid request'), 400);
		}
		return handler(c, data as MessageOf<T>);
	};
}

export function registerAuthRoutes(
	app: Hono,
	injectedLogger: Logger = serverLogger,
) {
	const logger = injectedLogger.child("auth_routes");
	// First-client enrollment and reconnect verification over HTTP.
	app.post('/auth', withMessage(MessageType.AUTH_ACK, async (c, data) => {
		logger.info("auth.requested", { clientName: data.client_name });
		const authResult = await auth(data.client_name, data.token, logger);

		if (!authResult.authenticated) {
			logger.warn("auth.rejected", { clientName: data.client_name });
			return c.json({
				type: MessageType.AUTH_FAILED,
				reason: 'Invalid credentials',
			}, 401);
		}

		if (authResult.token) {
			logger.info("auth.enrolled", { clientName: data.client_name });
			return c.json({
				type: MessageType.AUTH_INIT,
				client_name: data.client_name,
				token: authResult.token,
			}, 200);
		}

		logger.info("auth.verified", { clientName: data.client_name });
		return c.json({
			type: MessageType.AUTH_SUCCESS,
		}, 200);
	}, logger));

	app.post('/reset-client-secret', withMessage(MessageType.AUTH_ACK, async (c, data) => {
		const newClientSecret = await resetClientSecret(
			data.client_name,
			data.token,
			logger,
		);
		if (!newClientSecret) {
			logger.warn("client_secret_reset.rejected", {
				clientName: data.client_name,
			});
			return c.json(errorMessage('Invalid token'), 401);
		}

		logger.info("client_secret_reset.completed", {
			clientName: data.client_name,
		});
		return c.json({
			type: MessageType.AUTH_INIT,
			client_name: data.client_name,
			token: newClientSecret,
		}, 200);
	}, logger));

	app.post('/reset-client-name', withMessage(MessageType.RESET_CLIENT_NAME, async (c, data) => {
		try {
			const newClientName = await resetClientName(
				data.new_client_name,
				data.token,
				logger,
			);
			logger.info("client_name_reset.completed", {
				clientName: newClientName,
			});
			return c.json({
				type: MessageType.AUTH_INIT,
				client_name: newClientName,
				token: data.token,
			}, 200);
		} catch (error) {
			if (error instanceof Error && error.message === "Invalid authorization") {
				logger.warn("client_name_reset.rejected", {
					clientName: data.new_client_name,
					reason: "invalid_token",
				});
				return c.json(errorMessage("Invalid token"), 401);
			}
			if (error && typeof error === "object" && "code" in error && error.code === "23505") {
				logger.warn("client_name_reset.rejected", {
					clientName: data.new_client_name,
					reason: "duplicate_name",
				});
				return c.json(errorMessage("Client name already exists"), 409);
			}
			logger.error("client_name_reset.failed", {
				clientName: data.new_client_name,
				error,
			});
			throw error;
		}
	}, logger));
}
