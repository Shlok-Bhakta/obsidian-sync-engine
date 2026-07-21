import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { bootstrapDB } from './db/MigrationRunner'
import { registerAuthRoutes } from './auth/auth';
import { registerWebSocketRoutes } from './presence/websockets';
import { objectStore, registerObjectStoreRoutes } from './storage/object_store';
import { registerSyncRoutes } from './sync/routes';
import { registerBootstrapRoutes } from './sync/bootstrap';


await bootstrapDB();
const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

registerAuthRoutes(app);
registerWebSocketRoutes(app);
registerObjectStoreRoutes(app);
registerSyncRoutes(app);
registerBootstrapRoutes(app);

const objectGcTimer = setInterval(() => {
  void objectStore.collectGarbage().catch((error: unknown) => console.error('Object garbage collection failed', error));
}, 6 * 60 * 60 * 1000);
objectGcTimer.unref();

export default {
  fetch: app.fetch,
  websocket,
  maxRequestBodySize: Number(process.env.MAX_OBJECT_BYTES ?? 100 * 1024 * 1024),
};
