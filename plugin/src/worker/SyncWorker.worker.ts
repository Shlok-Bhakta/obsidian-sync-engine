import { yDb } from "db/db";
import { json } from "stream/consumers";

console.log("worker running");

// on loop hit backend /worker endpoint

let serverurl: string;
let ws: WebSocket;
const db: yDb = new yDb();
let draining = false;

function waitForOpen(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve();

    return new Promise((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error("WebSocket failed to connect")), { once: true });
        ws.addEventListener("close", () => reject(new Error("WebSocket closed before opening")), { once: true });
    });
}

function waitForAck(ws: WebSocket, id: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onMessage = (event: MessageEvent) => {
          console.log("got msg", event.data);
          const msg = JSON.parse(event.data);
          console.log("parsed msg", JSON.stringify(msg));

        if (msg.type === "ack" && msg.id === id) {
        console.log("acked");
          cleanup();
          resolve();
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error("WebSocket closed before ack"));
      };

      const onError = () => {
        cleanup();
        reject(new Error("WebSocket errored before ack"));
      };

      const cleanup = () => {
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
      };

      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose, { once: true });
      ws.addEventListener("error", onError, { once: true });
    });
  }


async function checkForNewOutbox(){
    let row = await db.getFirstOutbox();
    if(row){
        emptyOutbox();
        return true;
    }
    return false;
}

// void emptyOutbox();

async function emptyOutbox() {
    if(draining){
        return;
    }
    draining = true;
    // create a websocket connection to the backend
    await ws;
    let empty = 0;
	while(true){
        try {
            // send first, then wait for ack, then delete
            let row = await db.getFirstOutbox();
            if(row){
                if(row.id){
                    const ack = waitForAck(ws, row.id);
                    ws.send(JSON.stringify(row));
                    await ack;
                    await db.removeOutbox(row.id);
                }
            }else{
                empty++;
                if(empty > 5){
                    // no more files so stop here
                    draining = false;
                    return;
                }
            }
        } catch (e) {
            console.error("failed to yeet packet", e);
        }
    }
}


self.onmessage = async (event) => {
	console.log("worker msg", event.data);
    if (event.data.type === "init") {
        serverurl = event.data.serverurl;
        // strip http:// or https://
        serverurl = serverurl.replace(/^https?:\/\//, "");
        // create a websocket connection to the backend
        serverurl = "ws://" + serverurl + "/worker";
        ws = new WebSocket(serverurl);
        await db.open();
        await waitForOpen(ws);
        console.log("init", serverurl);
        postMessage({ type: "ready" });
    }
    if (event.data.type === "start") {
        emptyOutbox();
        // setup system to check every 2 seconds if there is a new outbox message if so activate
        setInterval(checkForNewOutbox, 2000);
    }
    if (event.data.type === "wake") {
        emptyOutbox();
    }
};