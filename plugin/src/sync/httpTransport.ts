import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import { inboxOpSchema } from "obsidian-sync-protocol";
import { PermanentRemoteError, type SyncTransport } from "./engine";
import type { InboxOp } from "./inbox";

/**
 * Shape of Obsidian's `requestUrl`. Kept as a plain function type (rather than
 * importing the value) so this module never pulls in the real `obsidian`
 * package at runtime — only its types — which lets it run under `bun test`
 * outside the Obsidian renderer. Callers pass the real `requestUrl` in
 * production and a fake in tests.
 */
export type HttpRequestFn = (
	params: RequestUrlParam,
) => Promise<RequestUrlResponse>;

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

/** Split an NDJSON response body into parsed, schema-validated inbox lines. */
function parseNdjson(body: string): InboxOp[] {
	return body
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => inboxOpSchema.parse(JSON.parse(line)));
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
		return { revision: Number((response.json as { revision: unknown }).revision) };
	}

	async deleteRemote(path: string): Promise<{ revision: number }> {
		const response = await this.request({
			url: `${this.getServerUrl()}/files?path=${encodeURIComponent(path)}`,
			method: "DELETE",
			headers: { Authorization: this.getAuthorization() },
			throw: false,
		});
		assertOk(response, `Delete of "${path}"`);
		return { revision: Number((response.json as { revision: unknown }).revision) };
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
		const response = await this.request({
			url: `${this.getServerUrl()}/inbox?rev=${rev}`,
			method: "GET",
			headers: { Authorization: this.getAuthorization() },
			throw: false,
		});
		assertOk(response, "Fetching inbox");
		return parseNdjson(response.text);
	}
}
