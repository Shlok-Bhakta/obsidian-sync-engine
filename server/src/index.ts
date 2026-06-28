import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { bootstrapDB } from './db/MigrationRunner'

bootstrapDB();
const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})
const AUTH_TOKEN = "88c53ab8-c8b7-4e6d-9481-f1d4326e4cfb";
app.get(
  '/ws',
  upgradeWebSocket((c) => {
    let authed = false;
    return {
      onOpen(_event, ws){
        ws.send(JSON.stringify({
          type: "auth_required"
        }));
      },
      onMessage(event, ws) {
        // ask client to auth 
        console.log(`Message from client: ${event.data}`)
        if(!authed){
          const data = JSON.parse(event.data.toString());
          if(data.type === "auth" && data.token === AUTH_TOKEN){
            authed = true;
            ws.send(JSON.stringify({
              type: "auth_success"
            }));
          } else {
            ws.send(JSON.stringify({
              type: "auth_failed"
            }));
            ws.close(1000, "Unauthorized");
            return;
          }
        }else{
          const data = JSON.parse(event.data.toString());
          if(data.type === "message"){
            ws.send(JSON.stringify({
              type: "message_received",
              message: data.message
            }));
          }
        }
      },
      onClose: () => {
        console.log('Connection closed')
      },
    }
  })
)

export default {
  fetch: app.fetch,
  websocket,
  maxRequestBodySize: 1024 * 1024 * 10, // 10MB
};
