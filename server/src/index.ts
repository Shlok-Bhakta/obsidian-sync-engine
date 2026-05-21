import { Hono } from "hono";
import { cors } from "hono/cors";
import { upgradeWebSocket, websocket } from "hono/bun";
import { BootstrapStatus, opType, wsPacket } from "../../shared/types";
import { decodePacket, decodePathToken, decodeUpdateBatchJsonl, encodePacket, PROTOCOL_VERSION } from "../../shared/protocol";
import { buildBootstrapZip, BootstrapBuildResult } from "./bootstrap";
import { bootstrapDB } from "./db/MigrationRunner";
import { rotateClientKey, validateClientKey } from "./security";
import { errorContext } from "../../shared/logger";
import { log } from "./logger";
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
app.use("/*", async (c, next) => {
  const startedAt = Date.now();
  await next();
  log.info("http request", {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  });
});

app.get("/", c => c.text("Hello Hono!"));
app.get("/health", c => c.text("OK"));

const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
export const MAX_REQUEST_BODY_SIZE = Number.parseInt(
  process.env.SYNC_MAX_REQUEST_BODY_BYTES ?? String(512 * 1024 * 1024),
  10,
);

type AuthenticatedSocket = {
  send: (data: string) => void;
  close?: (code?: number, reason?: string) => void;
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
      log.error("failed to broadcast bootstrap status", errorContext(error));
    }
  }
  log.info("bootstrap status published", latestBootstrapStatus);
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
    log.error("failed to clean expired bootstrap zip", errorContext(error));
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

async function getBootstrapLink(token: string): Promise<BootstrapLink | null> {
  const link = bootstrapLinks.get(token);
  if (!link) {
    return null;
  }
  if (Date.now() >= link.expiresAt) {
    await expireBootstrapLink(token);
    return null;
  }
  return link;
}

function makeDownloadUrl(request: Request, token: string): string {
  const url = new URL(request.url);
  url.pathname = `/v1/bootstrap/${encodeURIComponent(token)}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function makeBootstrapDownloadHref(request: Request, token: string): string {
  const url = new URL(request.url);
  url.searchParams.set("download", "1");
  return url.toString();
}

function bootstrapLandingPage(request: Request, link: BootstrapLink): string {
  const downloadHref = makeBootstrapDownloadHref(request, link.token);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Download ${escapeHtml(link.vaultName)}</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 40px; line-height: 1.4; }
      a { display: inline-block; padding: 10px 14px; background: #2563eb; color: white; border-radius: 6px; text-decoration: none; }
      p { color: #475569; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(link.vaultName)}</h1>
    <p>This one-time bootstrap link expires in ${Math.ceil(remainingMs(link.expiresAt)! / 1000)} seconds.</p>
    <a href="${escapeHtml(downloadHref)}">Download vault zip</a>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    log.warn("blob upload denied", { status: denied.status });
    return denied;
  }
  const path = decodePathToken(c.req.param("path"));
  const body = c.req.raw.body;
  if (!body) {
    return c.text("Blob body is required", 400);
  }
  const metadata = await putBlobFile(path, body, c.req.header("X-Content-Sha256") ?? null);
  log.info("blob uploaded", {
    path,
    byteSize: metadata.byteSize,
    contentSha256: metadata.contentSha256,
    revision: metadata.revision,
  });
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
    log.warn("blob download denied", { status: denied.status });
    return denied;
  }
  const path = decodePathToken(c.req.param("path"));
  const metadata = await getBlobMetadata(path);
  if (!metadata) {
    log.warn("blob download missing", { path });
    return c.text("Blob not found", 404);
  }
  log.info("blob download streaming", {
    path: metadata.path,
    byteSize: metadata.byteSize,
    contentSha256: metadata.contentSha256,
    revision: metadata.revision,
  });
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
  const link = await getBootstrapLink(token);
  if (!link) {
    return c.text("Bootstrap link is invalid or expired", 404);
  }

  if (c.req.query("download") !== "1") {
    return c.html(bootstrapLandingPage(c.req.raw, link));
  }

  try {
    const bytes = await Bun.file(link.zipPath).arrayBuffer();
    const consumed = await consumeBootstrapLink(token);
    if (!consumed) {
      return c.text("Bootstrap link is invalid or expired", 404);
    }
    await link.cleanup();
    publishBootstrapStatus({
      status: "downloaded",
      vaultName: link.vaultName,
      message: "Bootstrap link was downloaded",
    });
    return new Response(bytes, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="${encodeURIComponent(link.vaultName)}.zip"`,
      },
    });
  } catch (error) {
    await link.cleanup().catch(cleanupError => {
      log.error("failed to clean bootstrap zip after failed download", errorContext(cleanupError));
    });
    log.error("bootstrap download failed", errorContext(error));
    return c.text("Bootstrap download failed", 500);
  }
});

app.on("HEAD", "/v1/bootstrap/:token", async c => {
  const link = await getBootstrapLink(c.req.param("token"));
  if (!link) {
    return new Response(null, { status: 404 });
  }
  const file = Bun.file(link.zipPath);
  return new Response(null, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(file.size),
      "Content-Disposition": `attachment; filename="${encodeURIComponent(link.vaultName)}.zip"`,
    },
  });
});

app.on("HEAD", "/v1/blobs/:path", async c => {
  const denied = await requireBlobAuth(c.req.raw);
  if (denied) {
    return denied;
  }
  const metadata = await getBlobMetadata(decodePathToken(c.req.param("path")));
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
  lastPulledRevision: string;
  pushPromise: Promise<void>;
  socket: AuthenticatedSocket | null;
};

const authenticatedClients = new Set<Client>();

function revisionFromServerPacket(packet: wsPacket): string | null {
  if (packet.type === opType.ChangeBatch) {
    return packet.serverRevision;
  }
  if (packet.type === opType.SnapshotReset) {
    return packet.targetRevision;
  }
  return null;
}

function evictDuplicateClientConnection(client: Client): void {
  for (const existing of authenticatedClients) {
    if (existing === client || existing.clientId !== client.clientId) {
      continue;
    }
    authenticatedClients.delete(existing);
    if (existing.socket) {
      authenticatedSockets.delete(existing.socket);
      existing.socket.close?.(4000, "Client reconnected");
      existing.socket = null;
    }
    existing.isAuthenticated = false;
  }
}

async function pushChangesToOtherClients(sender: Client, revision: string): Promise<void> {
  const pushes: Promise<void>[] = [];
  for (const target of authenticatedClients) {
    if (target === sender || !target.socket || !target.isAuthenticated) {
      continue;
    }
    target.pushPromise = target.pushPromise.catch(() => {}).then(async () => {
      try {
        const fromRevision = target.lastPulledRevision;
        const packet = await handlePull({ type: opType.PullSince, revision: fromRevision });
        target.socket!.send(encodePacket(packet));
        const pushedRevision = revisionFromServerPacket(packet);
        if (pushedRevision && BigInt(pushedRevision) > BigInt(target.lastPulledRevision)) {
          target.lastPulledRevision = pushedRevision;
        }
        log.info("pushed changes to websocket client", {
          senderClientId: sender.clientId,
          targetClientId: target.clientId,
          targetClientName: target.clientName,
          fromRevision,
          acceptedRevision: revision,
          pushedRevision,
          packetType: packet.type,
        });
      } catch (error) {
        log.error("failed to push changes to websocket client", {
          senderClientId: sender.clientId,
          targetClientId: target.clientId,
          targetClientName: target.clientName,
          ...errorContext(error),
        });
      }
    });
    pushes.push(target.pushPromise);
  }
  await Promise.all(pushes);
}

app.get(
  "/worker",
  upgradeWebSocket(() => {
    const client: Client = {
      isAuthenticated: false,
      clientId: "",
      clientName: "",
      lastPulledRevision: "0",
      pushPromise: Promise.resolve(),
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
        log.debug("websocket packet received", {
          type: data.type,
          authenticated: client.isAuthenticated,
          clientId: client.clientId,
          clientName: client.clientName,
        });

        if (!client.isAuthenticated) {
          if (data.type !== opType.Auth) {
            log.warn("websocket rejected unauthenticated packet", { type: data.type });
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
            log.warn("websocket protocol mismatch", {
              clientProtocolVersion: data.protocolVersion,
              serverProtocolVersion: PROTOCOL_VERSION,
            });
            ws.close(1008, "Protocol mismatch");
            return;
          }

          const auth = await rotateClientKey(data.clientKey);
          if (!auth.authenticated || !auth.clientKey) {
            const deny: wsPacket = { type: opType.Deny, message: "Client key is invalid" };
            ws.send(encodePacket(deny));
            log.warn("websocket auth denied", { clientId: data.clientId, clientName: data.clientName });
            ws.close(1008, "Authentication denied");
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
          client.lastPulledRevision = data.lastPulledRevision;
          client.socket = ws;
          evictDuplicateClientConnection(client);
          authenticatedClients.add(client);
          authenticatedSockets.add(client.socket);
          log.info("websocket authenticated", {
            clientId: client.clientId,
            clientName: client.clientName,
            lastPulledRevision: data.lastPulledRevision,
            rotatedKey: auth.clientKey !== data.clientKey,
          });

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
          log.info("bootstrap create requested", {
            clientId: client.clientId,
            clientName: client.clientName,
            vaultName: data.vaultName,
            configDir: data.configDir,
          });
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
                log.error("failed to clean bootstrap zip after registration failure", errorContext(cleanupError));
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
          log.info("pull requested", {
            clientId: client.clientId,
            clientName: client.clientName,
            revision: data.revision,
          });
          const packet = await handlePull(data);
          ws.send(encodePacket(packet));
          client.lastPulledRevision = revisionFromServerPacket(packet) ?? client.lastPulledRevision;
          return;
        }

        if (data.type === opType.DocSync) {
          log.debug("DocSync requested", {
            clientId: client.clientId,
            paths: data.paths.map(path => path.path),
          });
          ws.send(encodePacket(await handleDocSync(data.paths)));
          return;
        }

        if (data.type === opType.UpdateBatch) {
          log.info("update batch received", {
            clientId: client.clientId,
            clientName: client.clientName,
            segmentId: data.segmentId,
            bytes: data.jsonl.length,
          });
          const revision = await acceptMutations(client.clientId, decodeUpdateBatchJsonl(data.jsonl));
          const ack: wsPacket = { type: opType.BatchAck, segmentId: data.segmentId, revision };
          ws.send(encodePacket(ack));
          client.lastPulledRevision = revision;
          log.info("update batch acknowledged", {
            clientId: client.clientId,
            segmentId: data.segmentId,
            revision,
          });
          void pushChangesToOtherClients(client, revision);
          return;
        }

        if (data.type === opType.InitUploadBatch) {
          log.info("initial upload batch received", {
            clientId: client.clientId,
            clientName: client.clientName,
            segmentId: data.segmentId,
            changes: data.changes.length,
          });
          const revision = await acceptMutations(client.clientId, data.changes);
          const ack: wsPacket = { type: opType.BatchAck, segmentId: data.segmentId, revision };
          ws.send(encodePacket(ack));
          client.lastPulledRevision = revision;
          log.info("initial upload batch acknowledged", {
            clientId: client.clientId,
            segmentId: data.segmentId,
            revision,
          });
          void pushChangesToOtherClients(client, revision);
          return;
        }

        if (data.type === opType.Update) {
          const deny: wsPacket = {
            type: opType.Deny,
            message: "Legacy Update packets are not supported; use DocSync and UpdateBatch",
          };
          ws.send(encodePacket(deny));
          ws.close(1008, "Unsupported packet");
          return;
        }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log.error("websocket handler error", {
            clientId: client.clientId,
            clientName: client.clientName,
            ...errorContext(error),
          });
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
        authenticatedClients.delete(client);
        log.info("websocket closed", {
          clientId: client.clientId,
          clientName: client.clientName,
          authenticated: client.isAuthenticated,
        });
      },
    };
  }),
);

export default {
  fetch: app.fetch,
  websocket,
  maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
};
