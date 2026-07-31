import type { RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
	deserializeInboxNdjson,
	type InboxOp,
	revisionResponseSchema,
	revisionSchema,
} from "obsidian-sync-protocol";
import type { HttpRequestFn } from "../http";
import { NoopLogger, type Logger } from "../logger";
import { PermanentRemoteError, type SyncTransport } from "./engine";

export type HttpTransportOptions = {
	getServerUrl: () => string;
	getAuthorization: () => string;
	request: HttpRequestFn;
	logger?: Logger;
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
	private readonly logger: Logger;

	constructor(options: HttpTransportOptions) {
		this.getServerUrl = options.getServerUrl;
		this.getAuthorization = options.getAuthorization;
		this.request = options.request;
		this.logger = (options.logger ?? new NoopLogger()).child("http");
	}

	private async execute(
		params: RequestUrlParam,
		context: Record<string, unknown>,
	): Promise<RequestUrlResponse> {
		try {
			return await this.request(params);
		} catch (error) {
			this.logger.error("request.failed", {
				...context,
				error,
			});
			throw error;
		}
	}

	private validateResponse(
		response: RequestUrlResponse,
		action: string,
		context: Record<string, unknown>,
	): void {
		if (response.status >= 400) {
			this.logger.warn("response.rejected", {
				...context,
				status: response.status,
			});
		}
		assertOk(response, action);
	}

	async upload(
		path: string,
		body: ArrayBuffer | string,
	): Promise<{ revision: number }> {
		const startedAt = Date.now();
		this.logger.debug("request.started", {
			method: "POST",
			route: "/files",
			path,
			bytes: typeof body === "string" ? body.length : body.byteLength,
		});
		const response = await this.execute({
			url: `${this.getServerUrl()}/files`,
			method: "POST",
			contentType: "application/octet-stream",
			headers: {
				Authorization: this.getAuthorization(),
				"X-Obsidian-Path": encodeURIComponent(path),
			},
			body,
			throw: false,
		}, {
			method: "POST",
			route: "/files",
			path,
		});
		this.logger.info("request.completed", {
			method: "POST",
			route: "/files",
			path,
			status: response.status,
			durationMs: Date.now() - startedAt,
		});
		this.validateResponse(response, `Upload of "${path}"`, {
			method: "POST",
			route: "/files",
			path,
		});
		let result: { revision: number };
		try {
			result = revisionResponseSchema.parse(response.json);
		} catch (error) {
			this.logger.error("response.invalid", {
				method: "POST",
				route: "/files",
				path,
				status: response.status,
				error,
			});
			throw error;
		}
		this.logger.debug("response.parsed", {
			method: "POST",
			route: "/files",
			path,
			revision: result.revision,
		});
		return result;
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
		const startedAt = Date.now();
		this.logger.debug("request.started", {
			method: "DELETE",
			route: "/files",
			path,
			baseRevision,
		});
		const response = await this.execute({
			url: `${this.getServerUrl()}/files?path=${encodeURIComponent(path)}`,
			method: "DELETE",
			headers,
			throw: false,
		}, {
			method: "DELETE",
			route: "/files",
			path,
			baseRevision,
		});
		this.logger.info("request.completed", {
			method: "DELETE",
			route: "/files",
			path,
			status: response.status,
			durationMs: Date.now() - startedAt,
		});
		this.validateResponse(response, `Delete of "${path}"`, {
			method: "DELETE",
			route: "/files",
			path,
			baseRevision,
		});
		let result: { revision: number };
		try {
			result = revisionResponseSchema.parse(response.json);
		} catch (error) {
			this.logger.error("response.invalid", {
				method: "DELETE",
				route: "/files",
				path,
				status: response.status,
				error,
			});
			throw error;
		}
		this.logger.debug("response.parsed", {
			method: "DELETE",
			route: "/files",
			path,
			revision: result.revision,
		});
		return result;
	}

	async download(path: string): Promise<ArrayBuffer> {
		const startedAt = Date.now();
		this.logger.debug("request.started", {
			method: "GET",
			route: "/files",
			path,
		});
		const response = await this.execute({
			url: `${this.getServerUrl()}/files?path=${encodeURIComponent(path)}`,
			method: "GET",
			headers: { Authorization: this.getAuthorization() },
			throw: false,
		}, {
			method: "GET",
			route: "/files",
			path,
		});
		this.logger.info("request.completed", {
			method: "GET",
			route: "/files",
			path,
			status: response.status,
			bytes: response.arrayBuffer.byteLength,
			durationMs: Date.now() - startedAt,
		});
		if (response.status === 404) {
			throw new RemoteFileNotFoundError(path);
		}
		this.validateResponse(response, `Download of "${path}"`, {
			method: "GET",
			route: "/files",
			path,
		});
		return response.arrayBuffer;
	}

	async fetchInbox(rev: number): Promise<InboxOp[]> {
		const cursor = revisionSchema.parse(rev);
		const startedAt = Date.now();
		this.logger.debug("request.started", {
			method: "GET",
			route: "/inbox",
			revision: cursor,
		});
		const response = await this.execute({
			url: `${this.getServerUrl()}/inbox?rev=${cursor}`,
			method: "GET",
			headers: { Authorization: this.getAuthorization() },
			throw: false,
		}, {
			method: "GET",
			route: "/inbox",
			revision: cursor,
		});
		this.logger.info("request.completed", {
			method: "GET",
			route: "/inbox",
			revision: cursor,
			status: response.status,
			bytes: response.text.length,
			durationMs: Date.now() - startedAt,
		});
		this.validateResponse(response, "Fetching inbox", {
			method: "GET",
			route: "/inbox",
			revision: cursor,
		});
		let operations: InboxOp[];
		try {
			operations = deserializeInboxNdjson(response.text);
		} catch (error) {
			this.logger.error("response.invalid", {
				method: "GET",
				route: "/inbox",
				revision: cursor,
				status: response.status,
				error,
			});
			throw error;
		}
		this.logger.debug("response.parsed", {
			method: "GET",
			route: "/inbox",
			revision: cursor,
			operationCount: operations.length,
		});
		return operations;
	}
}
