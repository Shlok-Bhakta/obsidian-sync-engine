import { Hono } from 'hono'
import { bootstrapDB } from './db/MigrationRunner'
import { registerAuthRoutes } from './auth/auth';
import { registerObjectStoreRoutes, objectStore } from './object/object_store';

await bootstrapDB();
const filled = await objectStore.backfillContentFromLegacyDisk();
if (filled > 0) {
  console.log(`Backfilled ${filled} legacy on-disk object(s) into BYTEA`);
}
await objectStore.assertContentComplete();

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

registerAuthRoutes(app);
registerObjectStoreRoutes(app);

export default {
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? "0.0.0.0",
  fetch: app.fetch,
  maxRequestBodySize: 1024 * 1024 * 10, // 10MB
};
