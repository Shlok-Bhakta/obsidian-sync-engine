import type { RequestUrlResponse } from "obsidian";
import {
	deleteResponseSchema,
	deserializeInboxNdjson,
	type InboxOp,
	revisionSchema,
	uploadResponseSchema,
} from "obsidian-sync-protocol";
import type { HttpRequestFn } from "../http";
import { PermanentRemoteError, type SyncTransport } from "./engine";

export type HttpTransportOptions = {
	getServerUrl: () => string;
	getAuthorization: () => string;
	request: HttpRequestFn;
};

/** Thrown when GET /files returns 404 (missing or soft-deleted). */
export class RemoteFileNotFoundError extends Error {
	readonly path: string;
	constructor(path: string) {
		super(`Remote file not found: ${path}`);
		this.name = "RemoteFileNotFoundError";
		this.path = path;
	}
}

function assertOk(response: RequestUrlResponse, action: string): void {
	if (response.status === 413 || response.status === 400) {
		throw new PermanentRemoteError(
			`${action} failed with status ${response.status}: ${response.text}`,
			response.status,
		);
	}
	if (response.status >= 400) {
		throw new Error(
			`${action} failed with status ${response.status}: ${response.text}`,
		);
	}
}

/** SyncTransport implementation backed by Obsidian's `requestUrl`, injected via `request`. */
export class HttpTransport implements SyncTransport {
	private readonly getServerUrl: () => string;
	private readonly getAuthorization: () => string;
	private readonly request: HttpRequestFn;

	constructor(options: HttpTransportOptions) {
		this.getServerUrl = options.getServerUrl;
		this.getAuthorization = options.getAuthorization;
		this.request = options.request;
	}

	async upload(
		path: string,
		body: ArrayBuffer | string,
	): Promise<{ revision: number }> {
		const response = await this.request({
			url: `${this.getServerUrl()}/files`,
			method: "POST",
			contentType: "application/octet-stream",
			headers: {
				Authorization: this.getAuthorization(),
				"X-Obsidian-Path": encodeURIComponent(path),
			},
			body,
			throw: false,
		});
		assertOk(response, `Upload of "${path}"`);
		const result = uploadResponseSchema.parse(response.json);
		return { revision: result.revision };
	}

	async deleteRemote(
		path: string,
		baseRevision?: number,
	): Promise<{ revision: number }> {
		const headers: Record<string, string> = {
			Authorization: this.getAuthorization(),
		};
		if (baseRevision !== undefined) {
			headers["X-Obsidian-Base-Revision"] = String(
				revisionSchema.parse(baseRevision),
			);
		}
		const response = await this.request({
			url: `${this.getServerUrl()}/files?path=${encodeURIComponent(path)}`,
			method: "DELETE",
			headers,
			throw: false,
		});
		assertOk(response, `Delete of "${path}"`);
		const result = deleteResponseSchema.parse(response.json);
		return { revision: result.revision };
	}

	async download(path: string): Promise<ArrayBuffer> {
		const response = await this.request({
			url: `${this.getServerUrl()}/files?path=${encodeURIComponent(path)}`,
			method: "GET",
			headers: { Authorization: this.getAuthorization() },
			throw: false,
		});
		if (response.status === 404) {
			throw new RemoteFileNotFoundError(path);
		}
		assertOk(response, `Download of "${path}"`);
		return response.arrayBuffer;
	}

	async fetchInbox(rev: number): Promise<InboxOp[]> {
		const cursor = revisionSchema.parse(rev);
		const response = await this.request({
			url: `${this.getServerUrl()}/inbox?rev=${cursor}`,
			method: "GET",
			headers: { Authorization: this.getAuthorization() },
			throw: false,
		});
		assertOk(response, "Fetching inbox");
		return deserializeInboxNdjson(response.text);
	}
}
