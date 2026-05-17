import { yDb } from "db/db";
import { opType, wsPacket } from "../../../shared/types";
import { decodePacket, encodePacket } from "../../../shared/protocol";

console.log("worker running");

// on loop hit backend /worker endpoint

let serverurl: string;
let ws: WebSocket | null = null;
const db: yDb = new yDb();
let draining = false;
let pollInterval: ReturnType<typeof setInterval> | null = null;

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


self.onmessage = async (event) => {
    console.log("worker msg", event.data);
    if (event.data.type === "init") {
        serverurl = toWebSocketUrl(event.data.serverurl);
        await ensureWebsocketConnection();
        await db.open();
        console.log("init", serverurl);
        postMessage({ type: "ready" });
    }
    if (event.data.type === "update-backend-url") {
        const nextUrl = toWebSocketUrl(event.data.serverurl);
        if (nextUrl !== serverurl) {
            serverurl = nextUrl;
            closeSocket();
            void emptyOutbox();
        }
    }
    if (event.data.type === "start") {
        void emptyOutbox();
        // setup system to check every 2 seconds if there is a new outbox message if so activate
        if (pollInterval === null) {
            pollInterval = setInterval(checkForNewOutbox, 2000);
        }
    }
    if (event.data.type === "wake") {
        void emptyOutbox();
    }
};
