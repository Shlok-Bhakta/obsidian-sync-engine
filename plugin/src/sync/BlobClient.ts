import { bytesToBase64 } from "../../../shared/protocol";

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

export class BlobClient {
    private baseUrl: string;
    private clientKey: string;

    constructor(backendUrl: string, clientKey: string) {
        this.baseUrl = toHttpUrl(backendUrl);
        this.clientKey = clientKey;
    }

    update(backendUrl: string, clientKey: string): void {
        this.baseUrl = toHttpUrl(backendUrl);
        this.clientKey = clientKey;
    }

    async upload(path: string, bytes: Uint8Array, sha256: string): Promise<void> {
        const response = await fetch(`${this.baseUrl}/v1/blobs/${pathToken(path)}`, {
            method: "PUT",
            headers: {
                "Authorization": `Bearer ${this.clientKey}`,
                "Content-Type": "application/octet-stream",
                "X-Content-Sha256": sha256,
            },
            body: bytes,
        });
        if (!response.ok) {
            throw new Error(`Blob upload failed for ${path}: ${response.status} ${await response.text()}`);
        }
    }

    async download(path: string): Promise<Uint8Array> {
        const response = await fetch(`${this.baseUrl}/v1/blobs/${pathToken(path)}`, {
            method: "GET",
            headers: {
                "Authorization": `Bearer ${this.clientKey}`,
            },
        });
        if (!response.ok) {
            throw new Error(`Blob download failed for ${path}: ${response.status} ${await response.text()}`);
        }
        return new Uint8Array(await response.arrayBuffer());
    }
}
