import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { opType, outboxData, wsPacket } from '../../shared/types'
import { decodePacket, encodePacket } from '../../shared/protocol'
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

        const data: wsPacket = decodePacket(raw);
        console.log("got data", data);

        if(data.type === opType.Ack){
            console.log("got ack");
            return;
        }else if(data.type === opType.Update){
            console.log("got update");
            console.log("got data", JSON.stringify(data));
            const ack: wsPacket = { type: opType.Ack, id: data.id };
            console.log("sending ack", ack);
            ws.send(encodePacket(ack));
            return;
        }else if(data.type === opType.CreateFile){
            console.log("got create file");
            return;
        }else if(data.type === opType.RenameFile){
            console.log("got rename file");
            return;
        }else if(data.type === opType.DeleteFile){
            console.log("got delete file");
            return;
        }else if(data.type === opType.CreateFolder){
            console.log("got create folder");
            return;
        }else if(data.type === opType.RenameFolder){
            console.log("got rename folder");
            return;
        }else if(data.type === opType.DeleteFolder){
            console.log("got delete folder");
            return;
        }



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