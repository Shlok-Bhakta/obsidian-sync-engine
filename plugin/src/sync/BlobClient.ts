import { requestUrl } from "obsidian";
import { bytesToBase64 } from "../../../shared/protocol";
import { errorContext } from "../../../shared/logger";
import { log } from "../logger";

type BlobResponse = {
    status: number;
    text: string;
    arrayBuffer: ArrayBuffer;
};

function toHttpUrl(backendUrl: string): string {
    const url = new URL(backendUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
}

function pathToken(path: string): string {
    return encodeURIComponent(bytesToBase64(new TextEncoder().encode(path)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export class BlobClient {
    private baseUrl: string;
    private clientKey: string;

    constructor(
        backendUrl: string,
        clientKey: string,
        private readonly refreshAuth: (() => Promise<string>) | null = null,
    ) {
        this.baseUrl = toHttpUrl(backendUrl);
        this.clientKey = clientKey;
    }

    update(backendUrl: string, clientKey: string): void {
        this.baseUrl = toHttpUrl(backendUrl);
        this.clientKey = clientKey;
    }

    async upload(path: string, bytes: Uint8Array, sha256: string): Promise<void> {
        log.debug("blob upload request", { path, byteSize: bytes.byteLength, sha256 });
        let response = await this.uploadOnce(path, bytes, sha256);
        if (response.status === 401 && this.refreshAuth) {
            log.warn("blob upload unauthorized; refreshing auth", { path });
            this.clientKey = await this.refreshAuth();
            response = await this.uploadOnce(path, bytes, sha256);
        }
        if (response.status < 200 || response.status >= 300) {
            log.error("blob upload failed", { path, status: response.status, body: response.text });
            throw new Error(`Blob upload failed for ${path}: ${response.status} ${response.text}`);
        }
        log.info("blob upload complete", { path, byteSize: bytes.byteLength, sha256 });
    }

    async download(path: string): Promise<Uint8Array> {
        log.debug("blob download request", { path });
        let response = await this.downloadOnce(path);
        if (response.status === 401 && this.refreshAuth) {
            log.warn("blob download unauthorized; refreshing auth", { path });
            this.clientKey = await this.refreshAuth();
            response = await this.downloadOnce(path);
        }
        if (response.status < 200 || response.status >= 300) {
            log.error("blob download failed", { path, status: response.status, body: response.text });
            throw new Error(`Blob download failed for ${path}: ${response.status} ${response.text}`);
        }
        const bytes = new Uint8Array(response.arrayBuffer);
        log.info("blob download complete", { path, byteSize: bytes.byteLength });
        return bytes;
    }

    private uploadOnce(path: string, bytes: Uint8Array, sha256: string): Promise<BlobResponse> {
        return requestUrl({
            url: `${this.baseUrl}/v1/blobs/${pathToken(path)}`,
            method: "PUT",
            throw: false,
            headers: {
                "Authorization": `Bearer ${this.clientKey}`,
                "Content-Type": "application/octet-stream",
                "X-Content-Sha256": sha256,
            },
            body: exactArrayBuffer(bytes),
        }).catch(error => {
            log.error("blob upload request errored", { path, ...errorContext(error) });
            throw error;
        });
    }

    private downloadOnce(path: string): Promise<BlobResponse> {
        return requestUrl({
            url: `${this.baseUrl}/v1/blobs/${pathToken(path)}`,
            method: "GET",
            throw: false,
            headers: {
                "Authorization": `Bearer ${this.clientKey}`,
            },
        }).catch(error => {
            log.error("blob download request errored", { path, ...errorContext(error) });
            throw error;
        });
    }
}
