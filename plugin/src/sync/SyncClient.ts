import { Notice } from "obsidian";
import { OutboxSegment, OutboxStore } from "db/db";
import { opType, wsPacket } from "../../../shared/types";
import { decodePacket, encodePacket, PROTOCOL_VERSION } from "../../../shared/protocol";
import { SyncEngineSettings } from "../settings";

const EMPTY_BACKOFF_MS = 1000;
const ERROR_BACKOFF_MS = 2000;
const IDLE_EMPTY_SEGMENTS = 3;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function toWebSocketUrl(backendUrl: string): string {
    const url = new URL(backendUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/worker";
    url.search = "";
    url.hash = "";
    return url.toString();
}

function readSocketMessage(event: MessageEvent): string {
    if (typeof event.data === "string") {
        return event.data;
    }
    throw new Error("WebSocket returned a non-text packet");
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export class SyncClient {
    private ws: WebSocket | null = null;
    private serverUrl: string;
    private clientKey: string;
    private clientName: string;
    private draining = false;
    private stopped = false;
    private flushTimer: number | null = null;
    private pollInterval: number | null = null;
    private authenticated = false;

    constructor(private readonly outbox: OutboxStore, settings: SyncEngineSettings) {
        this.serverUrl = toWebSocketUrl(settings.backendUrl);
        this.clientKey = settings.clientKey;
        this.clientName = settings.clientName;
    }

    start(): void {
        this.stopped = false;
        this.wakeSoon();
        this.pollInterval = window.setInterval(() => this.wakeSoon(), 5000);
    }

    stop(): void {
        this.stopped = true;
        if (this.flushTimer !== null) {
            window.clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.pollInterval !== null) {
            window.clearInterval(this.pollInterval);
            this.pollInterval = null;
        }
        this.closeSocket();
    }

    updateSettings(settings: SyncEngineSettings): void {
        const nextUrl = toWebSocketUrl(settings.backendUrl);
        const authChanged = settings.clientKey !== this.clientKey || settings.clientName !== this.clientName;
        this.clientKey = settings.clientKey;
        this.clientName = settings.clientName;
        if (nextUrl !== this.serverUrl || authChanged) {
            this.serverUrl = nextUrl;
            this.closeSocket();
        }
        this.wakeSoon();
    }

    wakeSoon(): void {
        if (this.stopped || this.flushTimer !== null) {
            return;
        }

        this.flushTimer = window.setTimeout(() => {
            this.flushTimer = null;
            void this.drainOutbox();
        }, 1000);
    }

    async drainOutbox(): Promise<void> {
        if (this.draining || this.stopped) {
            return;
        }

        this.draining = true;
        try {
            let emptyCount = 0;
            while (!this.stopped) {
                let segment: OutboxSegment | null = null;
                try {
                    segment = await this.outbox.claimNextSegment(true);
                    if (!segment) {
                        emptyCount++;
                        if (emptyCount >= IDLE_EMPTY_SEGMENTS) {
                            return;
                        }
                        await sleep(EMPTY_BACKOFF_MS);
                        continue;
                    }

                    emptyCount = 0;
                    await this.sendSegment(segment);
                    await this.outbox.completeSegment(segment);
                    await sleep(0);
                } catch (error) {
                    console.error("failed to drain outbox", error);
                    if (segment) {
                        await this.outbox.releaseSegment(segment);
                    }
                    this.closeSocket();
                    await sleep(ERROR_BACKOFF_MS);
                }
            }
        } finally {
            this.draining = false;
        }
    }

    private async sendSegment(segment: OutboxSegment): Promise<void> {
        const rows = await this.outbox.readSegment(segment);
        for (const row of rows) {
            if (row.id === undefined) {
                throw new Error(`Outbox row in ${segment.path} is missing an id`);
            }

            const openWs = await this.ensureAuthenticatedSocket();
            const packet: wsPacket = {
                type: opType.Update,
                id: row.id,
                fileId: row.fileId,
                data: row.data,
                updateTime: row.created,
            };
            const ack = this.waitForAck(openWs, row.id);
            openWs.send(encodePacket(packet));
            await ack;
        }
    }

    private async ensureAuthenticatedSocket(): Promise<WebSocket> {
        const openWs = await this.ensureSocket();
        if (this.authenticated) {
            return openWs;
        }

        const authPacket: wsPacket = {
            type: opType.Auth,
            clientKey: this.clientKey,
            clientName: this.clientName,
            protocolVersion: PROTOCOL_VERSION,
        };
        const ack = this.waitForAuthAck(openWs);
        openWs.send(encodePacket(authPacket));
        const packet = await ack;
        if (!packet || packet.type !== opType.AuthAck) {
            throw new Error("Backend did not acknowledge authentication");
        }

        this.authenticated = true;
        return openWs;
    }

    private async ensureSocket(): Promise<WebSocket> {
        if (this.ws?.readyState === WebSocket.OPEN) {
            return this.ws;
        }

        if (this.ws?.readyState === WebSocket.CONNECTING) {
            await this.waitForOpen(this.ws);
            return this.ws;
        }

        this.closeSocket();
        const nextWs = new WebSocket(this.serverUrl);
        this.ws = nextWs;
        nextWs.addEventListener("close", () => {
            if (this.ws === nextWs) {
                this.ws = null;
                this.authenticated = false;
            }
        });

        await this.waitForOpen(nextWs);
        return nextWs;
    }

    private waitForOpen(ws: WebSocket): Promise<void> {
        if (ws.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }

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

    private waitForAck(ws: WebSocket, id: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const onMessage = (event: MessageEvent) => {
                let msg: wsPacket;
                try {
                    msg = decodePacket(readSocketMessage(event));
                } catch (error) {
                    cleanup();
                    reject(asError(error));
                    return;
                }

                if (msg.type === opType.Ack && msg.id === id) {
                    cleanup();
                    resolve();
                    return;
                }
                if (msg.type === opType.Deny) {
                    cleanup();
                    reject(new Error(msg.message));
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

    private waitForAuthAck(ws: WebSocket): Promise<wsPacket | null> {
        return new Promise((resolve, reject) => {
            const onMessage = (event: MessageEvent) => {
                let msg: wsPacket;
                try {
                    msg = decodePacket(readSocketMessage(event));
                } catch (error) {
                    cleanup();
                    reject(asError(error));
                    return;
                }

                cleanup();
                if (msg.type === opType.AuthAck) {
                    resolve(msg);
                    return;
                }
                if (msg.type === opType.Deny) {
                    new Notice(msg.message);
                    resolve(null);
                    return;
                }
                resolve(null);
            };
            const onClose = () => {
                cleanup();
                reject(new Error("WebSocket closed before auth ack"));
            };
            const onError = () => {
                cleanup();
                reject(new Error("WebSocket errored before auth ack"));
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

    private closeSocket(): void {
        this.authenticated = false;
        if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
            this.ws.close();
        }
        this.ws = null;
    }
}
