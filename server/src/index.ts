import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { bootstrapDB } from './db/MigrationRunner'
import { auth } from './auth/auth';
import { PROTOCOL_VERSION, Message, MessageType, serialize, deserialize} from 'obsidian-sync-protocol';


bootstrapDB();
const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/auth', async (c) => {
  const clientName = c.req.query('client_name');
  const clientSecret = c.req.query('client_secret');
  if(!clientName || !clientSecret){
    return c.json({ error: 'client_name and client_secret are required' }, 400);
  }
  const client = await auth(clientName as string, clientSecret as string);
  return c.json(client);
})

const AUTH_TOKEN = "88c53ab8-c8b7-4e6d-9481-f1d4326e4cfb";
app.get(
  '/ws',
  async (c, next) => {
    const version = c.req.query('version');
    if (!version) {
      let message: Message = {
        type: MessageType.ERROR,
        reason: 'Version is required'
      };
      return c.json(message, 400);
    }
    if (version !== PROTOCOL_VERSION) {
      let message: Message = {
        type: MessageType.ERROR,
        reason: 'Unsupported protocol version'
      };
      return c.json(message, 400);
    }
    await next();
  },
  upgradeWebSocket((_c) => {
    let authed = false;
    return {
      onOpen(_event, ws){
        let message: Message = {
          type: MessageType.AUTH_REQUIRED
        };
        ws.send(serialize(message));
      },
      onMessage(event, ws) {
        // ask client to auth 
        console.log(`Message from client: ${event.data}`)
        if(!authed){
          const data = deserialize(event.data.toString());
          if(data.type === MessageType.AUTH_ACK && data.token === AUTH_TOKEN){
            authed = true;
            let message: Message = {
              type: MessageType.AUTH_SUCCESS
            };
            ws.send(serialize(message));
          } else {
            let message: Message = {
              type: MessageType.AUTH_FAILED,
              reason: 'Invalid token'
            };
            ws.send(serialize(message));
            ws.close(1000, "Invalid token");
            return;
          }
        }else{
          let message: Message = {
            type: MessageType.MESSAGE,
            payload: event.data.toString()
          };
          ws.send(serialize(message));
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
