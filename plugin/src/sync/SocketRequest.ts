import { Notice } from "obsidian";
import { decodePacket } from "../../../shared/protocol";
import { opType, wsPacket } from "../../../shared/types";

export function readSocketMessage(event: MessageEvent): string {
    if (typeof event.data === "string") {
        return event.data;
    }
    throw new Error("WebSocket returned a non-text packet");
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(message)), ms);
        promise.then(
            value => {
                window.clearTimeout(timer);
                resolve(value);
            },
            error => {
                window.clearTimeout(timer);
                reject(asError(error));
            },
        );
    });
}

type WaitForPacketOptions<T> = {
    accept: (packet: wsPacket) => T | undefined;
    closeMessage: string;
    errorMessage: string;
    denyReturnsNull?: boolean;
};

export function waitForPacket<T>(
    ws: WebSocket,
    options: WaitForPacketOptions<T>,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            ws.removeEventListener("message", onMessage);
            ws.removeEventListener("close", onClose);
            ws.removeEventListener("error", onError);
        };
        const onMessage = (event: MessageEvent) => {
            let packet: wsPacket;
            try {
                packet = decodePacket(readSocketMessage(event));
            } catch (error) {
                cleanup();
                reject(asError(error));
                return;
            }

            const accepted = options.accept(packet);
            if (accepted !== undefined) {
                cleanup();
                resolve(accepted);
                return;
            }
            if (packet.type === opType.Deny) {
                cleanup();
                if (options.denyReturnsNull) {
                    new Notice(packet.message);
                    resolve(null as T);
                    return;
                }
                reject(new Error(packet.message));
            }
        };
        const onClose = () => {
            cleanup();
            reject(new Error(options.closeMessage));
        };
        const onError = () => {
            cleanup();
            reject(new Error(options.errorMessage));
        };

        ws.addEventListener("message", onMessage);
        ws.addEventListener("close", onClose, { once: true });
        ws.addEventListener("error", onError, { once: true });
    });
}
