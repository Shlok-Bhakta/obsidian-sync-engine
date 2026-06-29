import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { bootstrapDB } from './db/MigrationRunner'
import { auth, checkClientExists, resetClientSecret } from './auth/auth';
import { PROTOCOL_VERSION, Message, MessageType, serialize, deserialize} from 'obsidian-sync-protocol';


bootstrapDB();
const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.post('/reset-client-secret', async (c) => {
  let data: Message;
  try {
    data = deserialize(await c.req.text());
  } catch (error) {
    console.error(error);
    let response: Message = {
      type: MessageType.ERROR,
      reason: 'Invalid request body'
    };
    return c.json(serialize(response), 400);
  }
  if(data.type !== MessageType.AUTH_ACK){
    let response: Message = {
      type: MessageType.ERROR,
      reason: 'Invalid request'
    };
    return c.json(serialize(response), 400);
  }
  const authResult = await checkClientExists(data.client_name, data.token);
  if(!authResult){
    let response: Message = {
      type: MessageType.ERROR,
      reason: 'Invalid token'
    };
    return c.json(serialize(response), 401);
  }
  const newClientSecret = await resetClientSecret(data.client_name);
  let response: Message = {
    type: MessageType.AUTH_INIT,
    client_name: data.client_name,
    token: newClientSecret
  };
  return c.json(serialize(response), 200);
})

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
      async onMessage(event, ws) {
        // ask client to auth 
        console.log(`Message from client: ${event.data}`)
        if(!authed){
          const data = deserialize(event.data.toString());
          if(data.type === MessageType.AUTH_ACK){
            const authResult = await auth(data.client_name, data.token);
            if(authResult.token !== null){
              let message: Message = {
                type: MessageType.AUTH_INIT,
                client_name: data.client_name,
                token: authResult.token
              };
              ws.send(serialize(message));
            }
            if(authResult.authenticated){
              authed = true;
              let message: Message = {
                type: MessageType.AUTH_SUCCESS
              };
              ws.send(serialize(message));
            }else{
              let message: Message = {
                type: MessageType.AUTH_FAILED,
                reason: 'Invalid token'
              };
              ws.send(serialize(message));
              ws.close(1000, "Invalid token");
              return;
            }
          }
        }else{
          // here the user is now authenticated so we chillin
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

