import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { bootstrapDB } from './db/MigrationRunner'
import { registerAuthRoutes } from './auth/auth';
import { registerObjectStoreRoutes, objectStore } from './object/object_store';
// Deferred: WebSocket routes live in ./websockets/websockets.ts for the
// second iteration. MVP uses HTTP polling only — do not register them here yet.
// import { registerWebSocketRoutes } from './websockets/websockets';

await bootstrapDB();
const filled = await objectStore.backfillContentFromLegacyDisk();
if (filled > 0) {
  console.log(`Backfilled ${filled} legacy on-disk object(s) into BYTEA`);
}

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

registerAuthRoutes(app);
// registerWebSocketRoutes(app);
registerObjectStoreRoutes(app);

export default {
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? "0.0.0.0",
  fetch: app.fetch,
  // websocket upgrade hook kept so a later iteration can re-enable /ws without
  // reshaping the Bun serve export.
  websocket,
  maxRequestBodySize: 1024 * 1024 * 10, // 10MB
};
