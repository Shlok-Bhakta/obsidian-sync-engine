import { requestUrl } from "obsidian";
import { encodePathToken } from "../../../shared/protocol";
import { errorContext } from "../../../shared/logger";
import { log } from "../logger";

type BlobResponse = {
    status: number;
    text: string;
    arrayBuffer: ArrayBuffer;
};

export type BlobUploadResponse = {
    uploadId: string;
    path: string;
    byteSize: number;
    contentSha256: string | null;
};

function toHttpUrl(backendUrl: string): string {
    const url = new URL(backendUrl);
    url.protocol = url.protocol === "wss:" ? "https:" : url.protocol === "ws:" ? "http:" : url.protocol;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
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

    async upload(path: string, bytes: Uint8Array, sha256: string, clientId: string): Promise<BlobUploadResponse> {
        log.debug("blob upload request", { path, byteSize: bytes.byteLength, sha256 });
        let response = await this.uploadOnce(path, bytes, sha256, clientId);
        if (response.status === 401 && this.refreshAuth) {
            log.warn("blob upload unauthorized; refreshing auth", { path });
            this.clientKey = await this.refreshAuth();
            response = await this.uploadOnce(path, bytes, sha256, clientId);
        }
        if (response.status < 200 || response.status >= 300) {
            log.error("blob upload failed", { path, status: response.status, body: response.text });
            throw new Error(`Blob upload failed for ${path}: ${response.status} ${response.text}`);
        }
        const upload = JSON.parse(response.text) as BlobUploadResponse;
        if (!upload.uploadId) {
            throw new Error(`Blob upload failed for ${path}: response missing uploadId`);
        }
        log.info("blob upload complete", { path, uploadId: upload.uploadId, byteSize: bytes.byteLength, sha256 });
        return upload;
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

    private uploadOnce(path: string, bytes: Uint8Array, sha256: string, clientId: string): Promise<BlobResponse> {
        return requestUrl({
            url: `${this.baseUrl}/v1/blobs/${encodePathToken(path)}`,
            method: "PUT",
            throw: false,
            headers: {
                "Authorization": `Bearer ${this.clientKey}`,
                "Content-Type": "application/octet-stream",
                "X-Content-Sha256": sha256,
                "X-Client-Id": clientId,
            },
            body: exactArrayBuffer(bytes),
        }).catch(error => {
            log.error("blob upload request errored", { path, ...errorContext(error) });
            throw error;
        });
    }

    private downloadOnce(path: string): Promise<BlobResponse> {
        return requestUrl({
            url: `${this.baseUrl}/v1/blobs/${encodePathToken(path)}`,
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
