import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { bootstrapDB } from './db/MigrationRunner'
import { registerAuthRoutes } from './auth/auth';
import { registerWebSocketRoutes } from './websockets/websockets';
import { registerObjectStoreRoutes } from './object/object_store';


bootstrapDB();
const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

registerAuthRoutes(app);
registerWebSocketRoutes(app);
registerObjectStoreRoutes(app);

export default {
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST ?? "0.0.0.0",
  fetch: app.fetch,
  websocket,
  maxRequestBodySize: 1024 * 1024 * 10, // 10MB
};
