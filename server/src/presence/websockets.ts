import { upgradeWebSocket } from "hono/bun";
import { sql } from "bun";
import type { Hono } from "hono";
import type { WSContext } from "hono/ws";
import {
  MessageType,
  PROTOCOL_VERSION,
  deserialize,
  serialize,
  type WebSocketMessage,
} from "obsidian-sync-protocol";
import { authenticateClient } from "../auth/auth";
import { createDownloadBootstrap, expireBootstrapLinks } from "../sync/bootstrap";
import { syncEngine, type SyncEngine } from "../sync/engine";

type Connection = {
  ws: WSContext;
  clientId: string;
  clientName: string;
  lastSeen: number;
  bootstrapLink?: { capabilityHash: string; expiresAt: number };
};

const connections = new Map<string, Connection>();
const presence = new Map<string, Extract<WebSocketMessage, { type: MessageType.PRESENCE_UPDATE }>>();

function send(ws: WSContext, message: WebSocketMessage): void {
  try { ws.send(serialize(message)); } catch { /* socket closed between checks */ }
}

function broadcast(message: WebSocketMessage, exceptClientId?: string): void {
  const encoded = serialize(message);
  for (const connection of connections.values()) {
    if (connection.clientId !== exceptClientId) {
      try { connection.ws.send(encoded); } catch { /* stale socket is cleaned by close/timeout */ }
    }
  }
}

function leave(clientId: string): void {
  if (presence.delete(clientId)) broadcast({ type: MessageType.PRESENCE_LEAVE, clientId }, clientId);
}

function error(ws: WSContext, code: string, safeMessage: string): void {
  send(ws, { type: MessageType.ERROR, code, safeMessage });
}

export function registerWebSocketRoutes(app: Hono, engine: SyncEngine = syncEngine): void {
  engine.onRevision((latestServerRevision) => broadcast({ type: MessageType.REVISION_AVAILABLE, latestServerRevision }));

  app.get("/ws", upgradeWebSocket((c) => {
    let connection: Connection | null = null;
    return {
      async onMessage(event, ws) {
        let message: WebSocketMessage;
        try { message = deserialize(String(event.data)); }
        catch { error(ws, "INVALID_MESSAGE", "The WebSocket message is malformed"); return; }

        if (!connection) {
          if (message.type !== MessageType.AUTH) {
            error(ws, "AUTH_REQUIRED", "Authenticate before sending other messages");
            ws.close(1008, "authentication required");
            return;
          }
          if (message.protocolVersion !== PROTOCOL_VERSION) {
            error(ws, "PROTOCOL_MISMATCH", `Protocol mismatch: client ${message.protocolVersion}, server ${PROTOCOL_VERSION}. Update the older component.`);
            ws.close(1002, "protocol mismatch");
            return;
          }
          const client = await authenticateClient(message.clientId, message.credential, message.clientName);
          if (!client) {
            error(ws, "AUTH_INVALID", "The client credential is invalid or revoked");
            ws.close(1008, "invalid credential");
            return;
          }
          const previous = connections.get(client.id);
          if (previous) {
            leave(client.id);
            previous.ws.close(4001, "client replaced");
          }
          connection = { ws, clientId: client.id, clientName: client.displayName, lastSeen: Date.now() };
          connections.set(client.id, connection);
          send(ws, {
            type: MessageType.AUTH_SUCCESS,
            clientId: client.id,
            currentServerRevision: await engine.currentRevision(),
            bootstrapRequired: await engine.bootstrapRequired(),
          });
          for (const state of presence.values()) send(ws, state);
          return;
        }

        connection.lastSeen = Date.now();
        if (message.type === MessageType.PRESENCE_UPDATE) {
          const state = { ...message, clientId: connection.clientId, name: connection.clientName };
          presence.set(connection.clientId, state);
          broadcast(state, connection.clientId);
          return;
        }
        if (message.type === MessageType.PRESENCE_LEAVE) {
          if (message.clientId === connection.clientId) leave(connection.clientId);
          return;
        }
        if (message.type === MessageType.BOOTSTRAP_CREATE) {
          send(ws, { type: MessageType.BOOTSTRAP_STATUS, status: "building" });
          try {
            const result = await createDownloadBootstrap({
              vaultId: message.vaultId,
              configDir: message.configDir,
              pluginId: message.pluginId,
              serverUrl: new URL(c.req.url).origin,
            });
            connection.bootstrapLink = { capabilityHash: result.capabilityHash, expiresAt: new Date(result.expiresAt).getTime() };
            send(ws, { type: MessageType.BOOTSTRAP_STATUS, status: "ready", url: result.url, expiresAt: result.expiresAt });
          } catch {
            send(ws, { type: MessageType.BOOTSTRAP_STATUS, status: "failed", safeMessage: "The bootstrap zip could not be built" });
          }
          return;
        }
        error(ws, "UNEXPECTED_MESSAGE", "That message is not valid in the authenticated client state");
      },
      onClose(_event, _ws) {
        if (!connection) return;
        if (connections.get(connection.clientId)?.ws === connection.ws) connections.delete(connection.clientId);
        leave(connection.clientId);
      },
      onError(_event, _ws) {
        if (connection) leave(connection.clientId);
      },
    };
  }));

  const timer = setInterval(() => {
    void (async () => {
    const cutoff = Date.now() - 30_000;
    for (const connection of connections.values()) {
      if (connection.lastSeen < cutoff) {
        leave(connection.clientId);
      }
      const link = connection.bootstrapLink;
      if (link) {
        const [row] = await sql<{ consumed_at: Date | null }[]>`
          SELECT consumed_at FROM bootstrap_links WHERE capability_hash = ${link.capabilityHash}
        `;
        if (row?.consumed_at) {
          send(connection.ws, { type: MessageType.BOOTSTRAP_STATUS, status: "downloaded" });
          connection.bootstrapLink = undefined;
        } else if (!row || link.expiresAt <= Date.now()) {
          send(connection.ws, { type: MessageType.BOOTSTRAP_STATUS, status: "expired" });
          connection.bootstrapLink = undefined;
        }
      }
    }
    await expireBootstrapLinks();
    })();
  }, 10_000);
  timer.unref?.();
}
