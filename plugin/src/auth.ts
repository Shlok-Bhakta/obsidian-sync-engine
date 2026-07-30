import { requestUrl } from 'obsidian';
import { deserialize, MessageType, serialize } from 'obsidian-sync-protocol';
import type ObsidianSyncPlugin from './main';

/**
 * HTTP handshake that replaces the old websocket-only first-client auth.
 * On an empty server, creates this client and persists the issued secret.
 * On an existing server, verifies the current secret.
 */
export async function ensureAuthenticated(plugin: ObsidianSyncPlugin): Promise<void> {
	if (plugin.isSyncSuspended()) {
		throw new Error("Reload Obsidian before reconnecting to the new server");
	}
	const response = await requestUrl({
		url: `${plugin.settings.serverUrl}/auth`,
		method: 'POST',
		contentType: 'application/json',
		body: serialize({
			type: MessageType.AUTH_ACK,
			client_name: plugin.settings.clientName,
			token: plugin.settings.clientSecret,
		}),
		throw: false,
	});

	const raw = typeof response.json === 'string' ? response.json : response.text;
	let message;
	try {
		message = deserialize(raw);
	} catch (error) {
		throw new Error(
			`Auth failed (${response.status}): could not parse response: ${String(error)}`,
		);
	}

	if (message.type === MessageType.AUTH_INIT) {
		plugin.settings.clientSecret = message.token;
		plugin.settings.clientName = message.client_name;
		await plugin.saveSettings();
		return;
	}

	if (message.type === MessageType.AUTH_SUCCESS) {
		return;
	}

	if (message.type === MessageType.AUTH_FAILED) {
		throw new Error(`Auth failed: ${message.reason}`);
	}

	throw new Error(`Auth failed (${response.status}): unexpected response ${message.type}`);
}
