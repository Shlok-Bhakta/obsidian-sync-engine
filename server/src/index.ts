import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { outboxData } from '../../shared/types'
import { bootstrapDB } from './db/MigrationRunner'

// before we run the app we need to "bootstrap" the database
bootstrapDB();


const app = new Hono();
app.use("/*", cors());

app.get('/', (c) => {
  return c.text('Hello Hono!');
})
app.get('/health', (c) => {
  return c.text('OK');
})


app.get(
  '/worker',
  upgradeWebSocket((c) => {
    return {
      onMessage(event, ws) {
        // get data wait for "processing" then ack
        console.log('Message received:', event.data)
        let raw = event.data;

        if (raw instanceof Uint8Array) {
          raw = new TextDecoder().decode(raw);
        }

        if (typeof raw !== "string") {
          raw = String(raw);
        }

        console.log("raw type", typeof event.data, event.data.constructor?.name);
        console.log("raw value", raw);

        const data = JSON.parse(raw);
        console.log("got data", data);

        const ack = JSON.stringify({ type: "ack", id: data.id });
        console.log("got data", JSON.stringify(data));
        console.log("sending ack", ack);
        ws.send(ack);
      },
      onClose: () => {
        console.log('Connection closed')
      },
    }
  })
)
// export default app;

export default {
  fetch: app.fetch,
  websocket,
}