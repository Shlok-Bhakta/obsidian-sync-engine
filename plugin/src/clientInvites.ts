import type { ClientInvite } from "obsidian-sync-protocol";
import type { HttpRequestFn } from "./http";
import { NoopLogger, type Logger } from "./logger";

export type { ClientInvite } from "obsidian-sync-protocol";

export async function requestClientInvite(options: {
	serverUrl: string;
	clientSecret: string;
	request: HttpRequestFn;
	logger?: Logger;
}): Promise<ClientInvite> {
	const logger = (options.logger ?? new NoopLogger()).child("client_invite_http");
	const startedAt = Date.now();
	logger.debug("request.started", {
		method: "POST",
		route: "/client-invites",
		serverUrl: options.serverUrl,
	});
	let response;
	try {
		response = await options.request({
			url: `${options.serverUrl.replace(/\/+$/, "")}/client-invites`,
			method: "POST",
			headers: { Authorization: options.clientSecret },
			throw: false,
		});
	} catch (error) {
		logger.error("request.failed", {
			method: "POST",
			route: "/client-invites",
			durationMs: Date.now() - startedAt,
			error,
		});
		throw error;
	}
	logger.info("request.completed", {
		method: "POST",
		route: "/client-invites",
		status: response.status,
		durationMs: Date.now() - startedAt,
	});
	if (response.status !== 201) {
		logger.warn("request.rejected", { status: response.status });
		throw new Error(`Could not create client package (${response.status})`);
	}
	const responseJson = response.json as unknown;
	let body: Partial<ClientInvite>;
	try {
		body = (typeof responseJson === "string"
			? JSON.parse(responseJson)
			: responseJson) as Partial<ClientInvite>;
	} catch (error) {
		logger.error("response.invalid_json", {
			status: response.status,
			error,
		});
		throw error;
	}
	if (
		typeof body.url !== "string" ||
		!["http:", "https:"].includes(new URL(body.url).protocol) ||
		typeof body.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(body.expiresAt))
	) {
		logger.error("response.invalid", { status: response.status });
		throw new Error("Server returned an invalid client package link");
	}
	logger.info("response.validated", { expiresAt: body.expiresAt });
	return { url: body.url, expiresAt: body.expiresAt };
}
