import { Hono } from "hono";
import { cors } from "hono/cors";
import { upgradeWebSocket, websocket } from "hono/bun";
import { BootstrapStatus, opType, wsPacket } from "../../shared/types";
import { decodePacket, decodeUpdateBatchJsonl, encodePacket, PROTOCOL_VERSION } from "../../shared/protocol";
import { buildBootstrapZip, BootstrapBuildResult } from "./bootstrap";
import { bootstrapDB } from "./db/MigrationRunner";
import { rotateClientKey, validateClientKey } from "./security";
import {
  acceptMutations,
  getBlobMetadata,
  getServerRevision,
  handleDocSync,
  handlePull,
  putBlobFile,
  registerClient,
  streamBlobFile,
} from "./sync/engine";

await bootstrapDB();

const app = new Hono();
app.use("/*", cors());

app.get("/", c => c.text("Hello Hono!"));
app.get("/health", c => c.text("OK"));

const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;

type AuthenticatedSocket = {
  send: (data: string) => void;
};

type BootstrapLink = {
  token: string;
  vaultName: string;
  expiresAt: number;
  zipPath: string;
  cleanup: () => Promise<void>;
  timeout: Timer;
};

const authenticatedSockets = new Set<AuthenticatedSocket>();
const bootstrapLinks = new Map<string, BootstrapLink>();
let latestBootstrapStatus: BootstrapStatus | null = null;
let countdownTimer: Timer | null = null;

function remainingMs(expiresAt?: number): number | undefined {
  return expiresAt === undefined ? undefined : Math.max(0, expiresAt - Date.now());
}

function publishBootstrapStatus(status: Omit<BootstrapStatus, "type" | "remainingMs"> & { remainingMs?: number }): void {
  latestBootstrapStatus = {
    type: opType.BootstrapStatus,
    ...status,
    remainingMs: status.remainingMs ?? remainingMs(status.expiresAt),
  };
  const encoded = encodePacket(latestBootstrapStatus);
  for (const ws of authenticatedSockets) {
    try {
      ws.send(encoded);
    } catch (error) {
      console.error("failed to broadcast bootstrap status:", error);
    }
  }
}

function stopCountdown(): void {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function startCountdown(token: string): void {
  stopCountdown();
  countdownTimer = setInterval(() => {
    const link = bootstrapLinks.get(token);
    if (!link) {
      stopCountdown();
      return;
    }
    publishBootstrapStatus({
      status: "ready",
      vaultName: link.vaultName,
      downloadUrl: latestBootstrapStatus?.downloadUrl,
      expiresAt: link.expiresAt,
    });
  }, 1000);
}

async function expireBootstrapLink(token: string): Promise<void> {
  const link = bootstrapLinks.get(token);
  if (!link) {
    return;
  }
  bootstrapLinks.delete(token);
  clearTimeout(link.timeout);
  stopCountdown();
  await link.cleanup().catch(error => {
    console.error("failed to clean expired bootstrap zip:", error);
  });
  publishBootstrapStatus({
    status: "expired",
    vaultName: link.vaultName,
    message: "Bootstrap link expired",
  });
}

async function consumeBootstrapLink(token: string): Promise<BootstrapLink | null> {
  const link = bootstrapLinks.get(token);
  if (!link) {
    return null;
  }
  if (Date.now() >= link.expiresAt) {
    await expireBootstrapLink(token);
    return null;
  }
  bootstrapLinks.delete(token);
  clearTimeout(link.timeout);
  stopCountdown();
  return link;
}

function makeDownloadUrl(request: Request, token: string): string {
  const url = new URL(request.url);
  url.pathname = `/v1/bootstrap/${encodeURIComponent(token)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function registerBootstrapLink(
  request: Request,
  token: string,
  vaultName: string,
  build: BootstrapBuildResult,
): Promise<void> {
  for (const existing of bootstrapLinks.keys()) {
    await expireBootstrapLink(existing);
  }
  const expiresAt = Date.now() + BOOTSTRAP_TTL_MS;
  const timeout = setTimeout(() => {
    void expireBootstrapLink(token);
  }, BOOTSTRAP_TTL_MS);
  bootstrapLinks.set(token, {
    token,
    vaultName,
    expiresAt,
    zipPath: build.zipPath,
    cleanup: build.cleanup,
    timeout,
  });
  publishBootstrapStatus({
    status: "ready",
    vaultName,
    downloadUrl: makeDownloadUrl(request, token),
    expiresAt,
  });
  startCountdown(token);
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

function blobPath(token: string): string {
  return new TextDecoder().decode(base64UrlToBytes(decodeURIComponent(token)));
}

function authHeaderKey(request: Request): string {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return request.headers.get("X-Client-Key") ?? "";
}

async function requireBlobAuth(request: Request): Promise<Response | null> {
  const key = authHeaderKey(request);
  if (!await validateClientKey(key)) {
    return new Response("Client key is invalid", { status: 401 });
  }
  return null;
}

app.put("/v1/blobs/:path", async c => {
  const denied = await requireBlobAuth(c.req.raw);
  if (denied) {
    return denied;
  }
  const path = blobPath(c.req.param("path"));
  const body = c.req.raw.body;
  if (!body) {
    return c.text("Blob body is required", 400);
  }
  const metadata = await putBlobFile(path, body, c.req.header("X-Content-Sha256") ?? null);
  return c.json({
    path: metadata.path,
    byteSize: metadata.byteSize,
    contentSha256: metadata.contentSha256,
    revision: metadata.revision,
  });
});

app.get("/v1/blobs/:path", async c => {
  const denied = await requireBlobAuth(c.req.raw);
  if (denied) {
    return denied;
  }
  const metadata = await getBlobMetadata(blobPath(c.req.param("path")));
  if (!metadata) {
    return c.text("Blob not found", 404);
  }
  return new Response(streamBlobFile(metadata), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(metadata.byteSize ?? 0),
      "X-Content-Sha256": metadata.contentSha256 ?? "",
      "X-Revision": metadata.revision,
    },
  });
});

app.get("/v1/bootstrap/:token", async c => {
  const token = c.req.param("token");
  const link = await consumeBootstrapLink(token);
  if (!link) {
    return c.text("Bootstrap link is invalid or expired", 404);
  }

  try {
    const bytes = await Bun.file(link.zipPath).arrayBuffer();
    await link.cleanup();
    publishBootstrapStatus({
      status: "downloaded",
      vaultName: link.vaultName,
      message: "Bootstrap link was downloaded",
    });
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(link.vaultName)}.zip"`,
      },
    });
  } catch (error) {
    await link.cleanup().catch(cleanupError => {
      console.error("failed to clean bootstrap zip after failed download:", cleanupError);
    });
    console.error("bootstrap download failed:", error);
    return c.text("Bootstrap download failed", 500);
  }
});

app.on("HEAD", "/v1/blobs/:path", async c => {
  const denied = await requireBlobAuth(c.req.raw);
  if (denied) {
    return denied;
  }
  const metadata = await getBlobMetadata(blobPath(c.req.param("path")));
  if (!metadata) {
    return new Response(null, { status: 404 });
  }
  return new Response(null, {
    headers: {
      "Content-Length": String(metadata.byteSize ?? 0),
      "X-Content-Sha256": metadata.contentSha256 ?? "",
      "X-Revision": metadata.revision,
    },
  });
});

type Client = {
  isAuthenticated: boolean;
  clientId: string;
  clientName: string;
  socket: AuthenticatedSocket | null;
};

app.get(
  "/worker",
  upgradeWebSocket(() => {
    const client: Client = {
      isAuthenticated: false,
      clientId: "",
      clientName: "",
      socket: null,
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
          client.socket = ws;
          authenticatedSockets.add(client.socket);

          const ack: wsPacket = {
            type: opType.AuthAck,
            newClientKey: auth.clientKey,
            serverRevision: await getServerRevision(),
          };
          ws.send(encodePacket(ack));
          if (latestBootstrapStatus && latestBootstrapStatus.status === "ready" && latestBootstrapStatus.expiresAt) {
            ws.send(encodePacket({
              ...latestBootstrapStatus,
              remainingMs: remainingMs(latestBootstrapStatus.expiresAt),
            }));
          }
          return;
        }

        if (data.type === opType.BootstrapCreate) {
          publishBootstrapStatus({
            status: "building",
            vaultName: data.vaultName,
            message: "Building vault zip",
          });
          try {
            const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
            const build = await buildBootstrapZip({
              vaultName: data.vaultName,
              backendUrl: data.backendUrl,
              configDir: data.configDir,
              pluginId: data.pluginId,
            });
            try {
              await registerBootstrapLink(new Request(data.backendUrl), token, data.vaultName, build);
            } catch (error) {
              await build.cleanup().catch(cleanupError => {
                console.error("failed to clean bootstrap zip after registration failure:", cleanupError);
              });
              throw error;
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            publishBootstrapStatus({
              status: "failed",
              vaultName: data.vaultName,
              message,
            });
          }
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
        if (client.socket) {
          authenticatedSockets.delete(client.socket);
        }
      },
    };
  }),
);

export default {
  fetch: app.fetch,
  websocket,
};
