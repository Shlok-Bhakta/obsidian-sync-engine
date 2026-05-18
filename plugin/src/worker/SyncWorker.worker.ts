import { yDb } from "db/db";
import { opType, workerOpType, workerPacket, wsPacket } from "../../../shared/types";
import { decodePacket, encodePacket, PROTOCOL_VERSION } from "../../../shared/protocol";

console.log("worker running");

// on loop hit backend /worker endpoint

let serverurl: string;
let ws: WebSocket | null = null;
const db: yDb = new yDb();
let draining = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let clientKey: string;
let clientName: string;

function sendClientPacket(packet: workerPacket) {
    postMessage(packet);
}

function toWebSocketUrl(backendUrl: string): string {
    const url = new URL(backendUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/worker";
    url.search = "";
    url.hash = "";
    return url.toString();
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForOpen(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.OPEN) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const onOpen = () => {
            cleanup();
            resolve();
        };
        const onError = () => {
            cleanup();
            reject(new Error("WebSocket failed to connect"));
        };
        const onClose = () => {
            cleanup();
            reject(new Error("WebSocket closed before opening"));
        };
        const cleanup = () => {
            ws.removeEventListener("open", onOpen);
            ws.removeEventListener("error", onError);
            ws.removeEventListener("close", onClose);
        };

        ws.addEventListener("open", onOpen, { once: true });
        ws.addEventListener("error", onError, { once: true });
        ws.addEventListener("close", onClose, { once: true });
    });
}

function waitForAck(ws: WebSocket, id: number): Promise<void> {
    return new Promise((resolve, reject) => {
        const onMessage = (event: MessageEvent) => {
            console.log("got msg", event.data);
            const msg: wsPacket = decodePacket(event.data);
            console.log("parsed msg", JSON.stringify(msg));

            if (msg.type === opType.Ack && msg.id === id) {
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


async function checkForNewOutbox() {
    let row = await db.getFirstOutbox();
    if (row) {
        emptyOutbox();
        return true;
    }
    return false;
}

function closeSocket() {
    if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
    }
    ws = null;
}

async function ensureWebsocketConnection(): Promise<WebSocket> {
    if (ws?.readyState === WebSocket.OPEN) {
        return ws;
    }

    if (ws?.readyState === WebSocket.CONNECTING) {
        await waitForOpen(ws);
        return ws;
    }

    closeSocket();

    const nextWs = new WebSocket(serverurl);
    ws = nextWs;
    nextWs.addEventListener("close", () => {
        if (ws === nextWs) {
            ws = null;
        }
    });

    await waitForOpen(nextWs);
    console.log("connected to backend");
    return nextWs;
}

async function emptyOutbox() {
    if (draining) {
        return;
    }
    // me when lock for async :( 
    // me when use variable instead :)
    draining = true;
    try {
        let empty = 0;
        while (true) {
            try {
                const openWs = await ensureWebsocketConnection();
                // send first, then wait for ack, then delete
                let row = await db.getFirstOutbox();
                if (row) {
                    empty = 0;
                    if (row.id !== undefined) {
                        const ack = waitForAck(openWs, row.id);
                        const packet: wsPacket = {
                            type: opType.Update,
                            id: row.id,
                            fileId: row.fileId,
                            data: row.data,
                            updateTime: row.created
                        };
                        openWs.send(encodePacket(packet));
                        await ack;
                        await db.removeOutbox(row.id);
                    }
                } else {
                    empty++;
                    if (empty > 5) {
                        // no more files so stop here
                        return;
                    }
                    await sleep(1000);
                }
            } catch (e) {
                console.error("failed to yeet packet", e);
                closeSocket();
                await sleep(2000);
            }
        }
    } finally {
        draining = false;
    }
}




function waitForAuthAck(ws: WebSocket): Promise<wsPacket | null> {
    return new Promise((resolve, reject) => {
        const onMessage = (event: MessageEvent) => {
            console.log("got msg", event.data);
            const msg: wsPacket = decodePacket(event.data);
            console.log("parsed msg", JSON.stringify(msg));

            if (msg.type === opType.AuthAck) {
                console.log("auth acked");
                cleanup();
                resolve(msg);
                return;
            }
            if(msg.type === opType.Deny){
                console.log(msg.type, msg.message);
                cleanup();
                resolve(null);
                return;
            }

            cleanup();
            resolve(null);
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

async function backendAuth(){
    // validate connection with websocket, update the key in settings
    const openWs = await ensureWebsocketConnection();
    const authPacket: wsPacket = {
        type: opType.Auth,
        clientKey: clientKey,
        clientName: clientName,
        protocolVersion: PROTOCOL_VERSION
    }
    console.log("sending off auth")
    const authAck = waitForAuthAck(openWs);
    openWs.send(encodePacket(authPacket));
    const ack = await authAck;
    if (!ack || ack.type !== opType.AuthAck) {
        throw new Error("Backend did not auth ack");
    }
    // clientKey = ack.newClientKey;
    console.log("authenticated with backend" + ack.newClientKey);
    return ack;
}

self.onmessage = async (event: MessageEvent<workerPacket>) => {
    const packet = event.data;
    console.log("worker msg", packet);
    if (packet.type === workerOpType.Init) {
        serverurl = toWebSocketUrl(packet.serverurl);
        clientKey = packet.clientKey;
        clientName = packet.clientName;
        await backendAuth();
        await db.open();
        console.log("init", serverurl);
        const readyPacket: workerPacket = { type: workerOpType.Ready };
        sendClientPacket(readyPacket);
    }
    if (packet.type === workerOpType.UpdateBackendUrl) {
        const nextUrl = toWebSocketUrl(packet.serverurl);
        if (nextUrl !== serverurl) {
            serverurl = nextUrl;
            closeSocket();
            void emptyOutbox();
        }
    }
    if (packet.type === workerOpType.Start) {
        void emptyOutbox();
        // setup system to check every 2 seconds if there is a new outbox message if so activate
        if (pollInterval === null) {
            pollInterval = setInterval(checkForNewOutbox, 2000);
        }
    }
    if (packet.type === workerOpType.Wake) {
        void emptyOutbox();
    }
};
