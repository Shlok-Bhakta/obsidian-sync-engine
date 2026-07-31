import { Hono } from 'hono'
import { bootstrapDB } from './db/MigrationRunner'
import { registerAuthRoutes } from './auth/auth';
import { registerObjectStoreRoutes, objectStore } from './object/object_store';
import {
	cleanupExpiredClientInvites,
	registerClientInviteRoutes,
} from "./invites/clientInvites";
import { MAX_REQUEST_BODY_SIZE } from "./config";
import { serverLogger } from "./logger";
import { registerHealthRoute } from "./health";

const startupLogger = serverLogger.child("startup");
startupLogger.info("server.starting", {
  bunVersion: Bun.version,
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? "0.0.0.0",
});
try {
  await bootstrapDB(serverLogger);
} catch (error) {
  startupLogger.error("server.startup_failed", { error });
  throw error;
}

const app = new Hono()

function logSafePath(pathname: string): string {
	return pathname.replace(
		/^\/client-invites\/[^/]+/,
		"/client-invites/[redacted]",
	);
}

app.use("*", async (c, next) => {
  const requestLogger = serverLogger.child("http");
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const url = new URL(c.req.url);
  const path = logSafePath(url.pathname);
  requestLogger.info("request.started", {
    requestId,
    method: c.req.method,
    path,
    query: url.search,
    contentLength: c.req.header("Content-Length"),
  });
  try {
    await next();
    requestLogger.info("request.completed", {
      requestId,
      method: c.req.method,
      path,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    requestLogger.error("request.failed", {
      requestId,
      method: c.req.method,
      path,
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  }
});

app.onError((error, c) => {
  serverLogger.child("http").error("request.unhandled_error", {
    method: c.req.method,
    path: logSafePath(new URL(c.req.url).pathname),
    error,
  });
  return c.text("Internal Server Error", 500);
});

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

registerHealthRoute(app, undefined, serverLogger);

registerAuthRoutes(app, serverLogger);
registerObjectStoreRoutes(app, objectStore, undefined, serverLogger);
registerClientInviteRoutes(app, objectStore, undefined, serverLogger);

const inviteCleanup = setInterval(() => {
	void cleanupExpiredClientInvites(new Date(), serverLogger).catch((error) => {
		serverLogger.child("client_invites").error("cleanup.failed", { error });
	});
}, 30_000);
inviteCleanup.unref?.();

startupLogger.info("server.ready", {
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? "0.0.0.0",
  maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
});

export default {
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? "0.0.0.0",
  fetch: app.fetch,
  maxRequestBodySize: MAX_REQUEST_BODY_SIZE,
};
