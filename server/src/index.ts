import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { opType, outboxData, wsPacket } from '../../shared/types'
import { decodePacket, encodePacket, PROTOCOL_VERSION } from '../../shared/protocol'
import { bootstrapDB } from './db/MigrationRunner'
import { generateClientKey, mintNewClientKey, validateClientKey } from './security'


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

type Client = {
  isAuthenticated: boolean;
  clientName: string;
}
app.get(
  '/worker',
  upgradeWebSocket((c) => {
    const client: Client = {
      isAuthenticated: false,
      clientName: "",
    }
    return {
      async onMessage(event, ws) {
        // get data wait for "processing" then ack
        console.log('Message received:', event.data)
        let raw = event.data;
        if (raw instanceof Uint8Array) {
          raw = new TextDecoder().decode(raw);
        }
        if (typeof raw !== "string") {
          raw = String(raw);
        }
        // console.log("raw type", typeof event.data, event.data.constructor?.name);
        // console.log("raw value", raw);

        const data: wsPacket = decodePacket(raw);
        // console.log("got data", data);

        if(!client.isAuthenticated){
          const deny: wsPacket = { 
            type: opType.Deny, 
            message: "Client is not authenticated" 
          };
          ws.send(encodePacket(deny));
          ws.close(1008, "Authenticate First");
          return;
        }

        if (data.type === opType.Ack) {
          console.log("got ack");
          return;
        } else if (data.type === opType.Update) {
          console.log("got update");
          console.log("got data", JSON.stringify(data));
          const ack: wsPacket = { type: opType.Ack, id: data.id };
          console.log("sending ack", ack);
          ws.send(encodePacket(ack));
          return;
        } else if (data.type === opType.CreateFile) {
          console.log("got create file");
          return;
        } else if (data.type === opType.RenameFile) {
          console.log("got rename file");
          return;
        } else if (data.type === opType.DeleteFile) {
          console.log("got delete file");
          return;
        } else if (data.type === opType.CreateFolder) {
          console.log("got create folder");
          return;
        } else if (data.type === opType.RenameFolder) {
          console.log("got rename folder");
          return;
        } else if (data.type === opType.DeleteFolder) {
          console.log("got delete folder");
          return;
        } else if (data.type === opType.Auth) {
          console.log("got auth");
          if(data.protocolVersion > PROTOCOL_VERSION){
            const deny: wsPacket = { 
              type: opType.Deny, 
              message: "Client is on a newer protocol version than the server (update the server or rollback the client)" 
            };
            ws.send(encodePacket(deny));
            return;
          }else if(data.protocolVersion < PROTOCOL_VERSION){
            const deny: wsPacket = { 
              type: opType.Deny, 
              message: "Client is on an older protocol version than the server (update the client or rollback the server)" 
            };
            ws.send(encodePacket(deny));
            return;
          }
          if(!(await validateClientKey(data.clientKey))){
            const deny: wsPacket = { 
              type: opType.Deny, 
              message: "Client key is invalid" 
            };
            ws.send(encodePacket(deny));
            return;
          }
          client.isAuthenticated = true;
          client.clientName = data.clientName;
          const key = await mintNewClientKey();
          const ack: wsPacket = { type: opType.AuthAck, newClientKey: key };
          console.log("sending ack [redacted for security]");
          ws.send(encodePacket(ack));
          console.log("sent ack [redacted for security]");
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