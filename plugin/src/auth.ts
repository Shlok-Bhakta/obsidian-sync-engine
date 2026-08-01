import { requestUrl } from 'obsidian';
import { deserialize, MessageType, serialize } from 'obsidian-sync-protocol';
import type { HttpRequestFn } from "./http";
import type { Logger } from "./logger";
import type ObsidianSyncPlugin from './main';

export type ClientAuthentication = {
	serverUrl: string;
	clientName: string;
	clientSecret: string;
};

type AuthenticateClientOptions = ClientAuthentication & {
	request: HttpRequestFn;
	logger: Logger;
};

/**
 * HTTP handshake that replaces the old websocket-only first-client auth.
 * On an empty server, creates this client and persists the issued secret.
 * On an existing server, verifies the current secret.
 */
export async function ensureAuthenticated(plugin: ObsidianSyncPlugin): Promise<void> {
	if (plugin.isSyncSuspended()) {
		throw new Error("The sync connection is changing");
	}
	const authentication = await authenticateClient({
		serverUrl: plugin.settings.serverUrl,
		clientName: plugin.settings.clientName,
		clientSecret: plugin.settings.clientSecret,
		request: requestUrl,
		logger: plugin.logger,
	});
	const changed =
		plugin.settings.clientSecret !== authentication.clientSecret ||
		plugin.settings.clientName !== authentication.clientName;
	plugin.settings.clientSecret = authentication.clientSecret;
	plugin.settings.clientName = authentication.clientName;
	if (changed) await plugin.saveSettings();
}

/** Runs the existing HTTP auth flow without mutating live plugin settings. */
export async function authenticateClient(
	options: AuthenticateClientOptions,
): Promise<ClientAuthentication> {
	const logger = options.logger.child("auth_http");
	const startedAt = Date.now();
	logger.debug("request.started", {
		method: "POST",
		route: "/auth",
		serverUrl: options.serverUrl,
		clientName: options.clientName,
	});
	let response;
	try {
		response = await options.request({
			url: `${options.serverUrl}/auth`,
			method: 'POST',
			contentType: 'application/json',
			body: serialize({
				type: MessageType.AUTH_ACK,
				client_name: options.clientName,
				token: options.clientSecret,
			}),
			throw: false,
		});
	} catch (error) {
		logger.error("request.failed", {
			method: "POST",
			route: "/auth",
			durationMs: Date.now() - startedAt,
			error,
		});
		throw error;
	}
	logger.info("request.completed", {
		method: "POST",
		route: "/auth",
		status: response.status,
		durationMs: Date.now() - startedAt,
	});

	const raw = typeof response.json === 'string' ? response.json : response.text;
	let message;
	try {
		message = deserialize(raw);
	} catch (error) {
		logger.error("response.invalid", {
			status: response.status,
			error,
		});
		throw new Error(
			`Auth failed (${response.status}): could not parse response: ${String(error)}`,
		);
	}

	if (message.type === MessageType.AUTH_INIT) {
		logger.info("client.enrolled", {
			clientName: message.client_name,
		});
		return {
			serverUrl: options.serverUrl,
			clientName: message.client_name,
			clientSecret: message.token,
		};
	}

	if (message.type === MessageType.AUTH_SUCCESS) {
		logger.info("client.verified", {
			clientName: options.clientName,
		});
		return {
			serverUrl: options.serverUrl,
			clientName: options.clientName,
			clientSecret: options.clientSecret,
		};
	}

	if (message.type === MessageType.AUTH_FAILED) {
		logger.warn("client.rejected", {
			clientName: options.clientName,
			reason: message.reason,
		});
		throw new Error(`Auth failed: ${message.reason}`);
	}

	throw new Error(`Auth failed (${response.status}): unexpected response ${message.type}`);
}
