import { requestUrl } from "obsidian";
import { encodePathToken } from "../../../shared/protocol";
import { errorContext } from "../../../shared/logger";
import { log } from "../logger";

type BlobResponse = {
    status: number;
    text: string;
};

type BootstrapManifestResponse = {
    revision: string;
    files: number;
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

export class BootstrapBlobClient {
    private baseUrl: string;
    private clientKey: string;
    private clientId: string;

    constructor(
        backendUrl: string,
        clientKey: string,
        clientId: string,
    ) {
        this.baseUrl = toHttpUrl(backendUrl);
        this.clientKey = clientKey;
        this.clientId = clientId;
    }

    update(backendUrl: string, clientKey: string, clientId: string): void {
        this.baseUrl = toHttpUrl(backendUrl);
        this.clientKey = clientKey;
        this.clientId = clientId;
    }

    updateClientKey(clientKey: string): void {
        this.clientKey = clientKey;
    }

    async upload(bootstrapId: string, path: string, bytes: Uint8Array, sha256: string): Promise<void> {
        log.debug("bootstrap blob upload request", { bootstrapId, path, byteSize: bytes.byteLength, sha256 });
        const response = await this.uploadOnce(bootstrapId, path, bytes, sha256);
        if (response.status < 200 || response.status >= 300) {
            log.error("bootstrap blob upload failed", {
                bootstrapId,
                path,
                status: response.status,
                body: response.text,
            });
            throw new Error(`Bootstrap blob upload failed for ${path}: ${response.status} ${response.text}`);
        }
        log.info("bootstrap blob upload complete", { bootstrapId, path, byteSize: bytes.byteLength, sha256 });
    }

    async uploadManifest(bootstrapId: string, jsonl: string, sha256: string): Promise<BootstrapManifestResponse> {
        log.info("bootstrap manifest upload request", { bootstrapId, bytes: jsonl.length, sha256 });
        const response = await this.uploadManifestOnce(bootstrapId, jsonl, sha256);
        if (response.status < 200 || response.status >= 300) {
            log.error("bootstrap manifest upload failed", {
                bootstrapId,
                status: response.status,
                body: response.text,
            });
            throw new Error(`Bootstrap manifest upload failed: ${response.status} ${response.text}`);
        }
        const parsed = JSON.parse(response.text) as BootstrapManifestResponse;
        log.info("bootstrap manifest upload complete", { bootstrapId, revision: parsed.revision, files: parsed.files });
        return parsed;
    }

    private uploadOnce(
        bootstrapId: string,
        path: string,
        bytes: Uint8Array,
        sha256: string,
    ): Promise<BlobResponse> {
        return requestUrl({
            url: `${this.baseUrl}/v1/bootstrap-upload/${encodeURIComponent(bootstrapId)}/blobs/${encodePathToken(path)}`,
            method: "PUT",
            throw: false,
            headers: {
                "Authorization": `Bearer ${this.clientKey}`,
                "Content-Type": "application/octet-stream",
                "X-Content-Sha256": sha256,
            },
            body: exactArrayBuffer(bytes),
        }).catch(error => {
            log.error("bootstrap blob upload request errored", { bootstrapId, path, ...errorContext(error) });
            throw error;
        });
    }

    private uploadManifestOnce(
        bootstrapId: string,
        jsonl: string,
        sha256: string,
    ): Promise<BlobResponse> {
        return requestUrl({
            url: `${this.baseUrl}/v1/bootstrap-upload/${encodeURIComponent(bootstrapId)}/manifest`,
            method: "PUT",
            throw: false,
            headers: {
                "Authorization": `Bearer ${this.clientKey}`,
                "Content-Type": "application/x-ndjson",
                "X-Client-Id": this.clientId,
                "X-Content-Sha256": sha256,
            },
            body: jsonl,
        }).catch(error => {
            log.error("bootstrap manifest upload request errored", { bootstrapId, ...errorContext(error) });
            throw error;
        });
    }
}
