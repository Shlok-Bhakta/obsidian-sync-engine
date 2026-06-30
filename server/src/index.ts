import { Hono } from 'hono'
import { websocket } from 'hono/bun'
import { bootstrapDB } from './db/MigrationRunner'
import { registerAuthRoutes } from './auth/auth';
import { registerWebSocketRoutes } from './websockets/websockets';


bootstrapDB();
const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

registerAuthRoutes(app);
registerWebSocketRoutes(app);

export default {
  fetch: app.fetch,
  websocket,
  maxRequestBodySize: 1024 * 1024 * 10, // 10MB
};

