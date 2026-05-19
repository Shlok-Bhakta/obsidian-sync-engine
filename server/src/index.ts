import { Hono } from "hono";
import { cors } from "hono/cors";
import { upgradeWebSocket, websocket } from "hono/bun";
import { opType, wsPacket } from "../../shared/types";
import { decodePacket, decodeUpdateBatchJsonl, encodePacket, PROTOCOL_VERSION } from "../../shared/protocol";
import { bootstrapDB } from "./db/MigrationRunner";
import { rotateClientKey } from "./security";
import {
  acceptMutations,
  getServerRevision,
  handleDocSync,
  handlePull,
  registerClient,
} from "./sync/engine";

await bootstrapDB();

const app = new Hono();
app.use("/*", cors());

app.get("/", c => c.text("Hello Hono!"));
app.get("/health", c => c.text("OK"));

type Client = {
  isAuthenticated: boolean;
  clientId: string;
  clientName: string;
};

app.get(
  "/worker",
  upgradeWebSocket(() => {
    const client: Client = {
      isAuthenticated: false,
      clientId: "",
      clientName: "",
    };
    return {
      async onMessage(event, ws) {
        try {
        let raw = event.data;
        if (raw instanceof Uint8Array) {
          raw = new TextDecoder().decode(raw);
        }
        if (typeof raw !== "string") {
          raw = String(raw);
        }

        const data: wsPacket = decodePacket(raw);

        if (!client.isAuthenticated) {
          if (data.type !== opType.Auth) {
            const deny: wsPacket = { type: opType.Deny, message: "Client is not authenticated" };
            ws.send(encodePacket(deny));
            ws.close(1008, "Authenticate first");
            return;
          }
          if (data.protocolVersion !== PROTOCOL_VERSION) {
            const direction = data.protocolVersion > PROTOCOL_VERSION ? "newer" : "older";
            const target = data.protocolVersion > PROTOCOL_VERSION ? "server" : "client";
            const deny: wsPacket = {
              type: opType.Deny,
              message: `Client is on a ${direction} protocol version than the server (update the ${target} or rollback)`,
            };
            ws.send(encodePacket(deny));
            return;
          }

          const auth = await rotateClientKey(data.clientKey);
          if (!auth.authenticated || !auth.clientKey) {
            const deny: wsPacket = { type: opType.Deny, message: "Client key is invalid" };
            ws.send(encodePacket(deny));
            return;
          }

          await registerClient(
            data.clientId,
            data.clientName,
            auth.currentKeyId,
            auth.previousKeyId,
            data.lastPulledRevision,
          );
          client.isAuthenticated = true;
          client.clientId = data.clientId;
          client.clientName = data.clientName;

          const ack: wsPacket = {
            type: opType.AuthAck,
            newClientKey: auth.clientKey,
            serverRevision: await getServerRevision(),
          };
          ws.send(encodePacket(ack));
          return;
        }

        if (data.type === opType.PullSince) {
          ws.send(encodePacket(await handlePull(data)));
          return;
        }

        if (data.type === opType.DocSync) {
          ws.send(encodePacket(await handleDocSync(data.paths)));
          return;
        }

        if (data.type === opType.UpdateBatch) {
          const revision = await acceptMutations(client.clientId, decodeUpdateBatchJsonl(data.jsonl));
          const ack: wsPacket = { type: opType.BatchAck, segmentId: data.segmentId, revision };
          ws.send(encodePacket(ack));
          return;
        }

        if (data.type === opType.InitUploadBatch) {
          const revision = await acceptMutations(client.clientId, data.changes);
          const ack: wsPacket = { type: opType.BatchAck, segmentId: data.segmentId, revision };
          ws.send(encodePacket(ack));
          return;
        }

        if (data.type === opType.Update) {
          const deny: wsPacket = {
            type: opType.Deny,
            message: "Legacy Update packets are not supported; use DocSync and UpdateBatch",
          };
          ws.send(encodePacket(deny));
          return;
        }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("websocket handler error:", error);
          const deny: wsPacket = { type: opType.Deny, message };
          ws.send(encodePacket(deny));
          if (!client.isAuthenticated) {
            ws.close(1008, "Protocol error");
          }
        }
      },
      onClose: () => {
      },
    };
  }),
);

export default {
  fetch: app.fetch,
  websocket,
};
