import { upgradeWebSocket } from 'hono/bun';
import { Context, Hono, Next } from 'hono';
import { auth } from '../auth/auth';
import {
	PROTOCOL_VERSION,
	Message,
	MessageType,
	serialize,
	deserialize,
} from 'obsidian-sync-protocol';

async function wsVersionMiddleware(c: Context, next: Next) {
	const version = c.req.query('version');
	if (!version) {
		return c.json(
			{ type: MessageType.ERROR, reason: 'Version is required' } satisfies Message,
			400,
		);
	}
	if (version !== PROTOCOL_VERSION) {
		return c.json(
			{ type: MessageType.ERROR, reason: 'Unsupported protocol version' } satisfies Message,
			400,
		);
	}
	await next();
}

const wsUpgradeHandler = upgradeWebSocket((_c) => {
	let authed = false;
	return {
		onOpen(_event, ws) {
			ws.send(serialize({ type: MessageType.AUTH_REQUIRED }));
		},
		async onMessage(event, ws) {
			console.log(`Message from client: ${event.data}`);
			if (!authed) {
				const data = deserialize(event.data.toString());
				if (data.type === MessageType.AUTH_ACK) {
					const authResult = await auth(data.client_name, data.token);
					if (authResult.token !== null) {
						const message: Message = {
							type: MessageType.AUTH_INIT,
							client_name: data.client_name,
							token: authResult.token,
						};
						ws.send(serialize(message));
					}
					if (authResult.authenticated) {
						authed = true;
						ws.send(serialize({ type: MessageType.AUTH_SUCCESS }));
					} else {
						ws.send(serialize({
							type: MessageType.AUTH_FAILED,
							reason: 'Invalid token',
						}));
						ws.close(1000, 'Invalid token');
					}
				}
			} else {
				ws.send(serialize({
					type: MessageType.MESSAGE,
					payload: event.data.toString(),
				}));
			}
		},
		onClose() {
			console.log('Connection closed');
		},
	};
});

export function registerWebSocketRoutes(app: Hono) {
	app.get('/ws', wsVersionMiddleware, wsUpgradeHandler);
}
