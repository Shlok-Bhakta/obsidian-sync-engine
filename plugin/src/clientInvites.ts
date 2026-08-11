import {
	clientInviteBuildSchema,
	clientInviteSchema,
	clientInviteStatusSchema,
	type ClientArchiveBuildProgress,
	type ClientInvite,
	type ClientInviteBuild,
	type ClientInviteStatus,
} from "obsidian-sync-protocol";
import type { HttpRequestFn } from "./http";
import { NoopLogger, type Logger } from "./logger";

export type {
	ClientArchiveBuildProgress,
	ClientInvite,
	ClientInviteStatus,
} from "obsidian-sync-protocol";

const DEFAULT_POLL_INTERVAL_MS = 500;

type HttpResponse = Awaited<ReturnType<HttpRequestFn>>;

function responseJson(response: HttpResponse): unknown {
	if (typeof response.json !== "string") return response.json as unknown;
	try {
		return JSON.parse(response.json) as unknown;
	} catch {
		return undefined;
	}
}

async function wait(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

async function requestLegacyInvite(options: {
	serverUrl: string;
	clientSecret: string;
	request: HttpRequestFn;
	logger: Logger;
}): Promise<ClientInvite> {
	const response = await options.request({
		url: `${options.serverUrl}/client-invites`,
		method: "POST",
		headers: { Authorization: options.clientSecret },
		throw: false,
	});
	if (response.status !== 201) {
		throw new Error(`Could not create client package (${response.status})`);
	}
	const parsed = clientInviteSchema.safeParse(responseJson(response));
	if (!parsed.success) {
		options.logger.error("response.invalid", { status: response.status });
		throw new Error("Server returned an invalid client package link");
	}
	return parsed.data;
}

function finishBuild(
	build: ClientInviteBuild,
	onProgress: ((progress: ClientArchiveBuildProgress) => void) | undefined,
): ClientInvite | null {
	onProgress?.(build.progress);
	if (build.status === "failed") throw new Error(build.error);
	return build.status === "ready" ? build.invite : null;
}

export async function requestClientInvite(options: {
	serverUrl: string;
	clientSecret: string;
	request: HttpRequestFn;
	logger?: Logger;
	onProgress?: (progress: ClientArchiveBuildProgress) => void;
	pollIntervalMs?: number;
	sleep?: (milliseconds: number) => Promise<void>;
}): Promise<ClientInvite> {
	const logger = (options.logger ?? new NoopLogger()).child("client_invite_http");
	const serverUrl = options.serverUrl.replace(/\/+$/, "");
	const startedAt = Date.now();
	logger.debug("build_start.request_started", {
		method: "POST",
		route: "/client-invite-builds",
		serverUrl,
	});

	let startResponse: HttpResponse;
	try {
		startResponse = await options.request({
			url: `${serverUrl}/client-invite-builds`,
			method: "POST",
			headers: { Authorization: options.clientSecret },
			throw: false,
		});
	} catch (error) {
		logger.error("build_start.request_failed", {
			durationMs: Date.now() - startedAt,
			error,
		});
		throw error;
	}

	if (startResponse.status === 404 || startResponse.status === 405) {
		logger.info("build_start.polling_unavailable", {
			status: startResponse.status,
		});
		return requestLegacyInvite({
			serverUrl,
			clientSecret: options.clientSecret,
			request: options.request,
			logger,
		});
	}
	if (startResponse.status !== 202) {
		logger.warn("build_start.rejected", { status: startResponse.status });
		throw new Error(`Could not start client package (${startResponse.status})`);
	}

	const startedBuild = clientInviteBuildSchema.safeParse(responseJson(startResponse));
	if (!startedBuild.success) {
		logger.error("build_start.response_invalid", { status: startResponse.status });
		throw new Error("Server returned an invalid archive build status");
	}
	let build = startedBuild.data;
	let invite = finishBuild(build, options.onProgress);
	const sleep = options.sleep ?? wait;
	const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

	while (!invite) {
		await sleep(pollIntervalMs);
		const response = await options.request({
			url: `${serverUrl}/client-invite-builds/${encodeURIComponent(build.buildId)}`,
			method: "GET",
			headers: { Authorization: options.clientSecret },
			throw: false,
		});
		if (response.status !== 200) {
			logger.warn("build_status.rejected", {
				buildId: build.buildId,
				status: response.status,
			});
			throw new Error(`Could not check client package (${response.status})`);
		}
		const parsed = clientInviteBuildSchema.safeParse(responseJson(response));
		if (!parsed.success || parsed.data.buildId !== build.buildId) {
			logger.error("build_status.response_invalid", { buildId: build.buildId });
			throw new Error("Server returned an invalid archive build status");
		}
		build = parsed.data;
		invite = finishBuild(build, options.onProgress);
	}

	logger.info("build.completed", {
		buildId: build.buildId,
		expiresAt: invite.expiresAt,
		durationMs: Date.now() - startedAt,
	});
	return invite;
}

export async function requestClientInviteStatus(options: {
	invite: ClientInvite;
	clientSecret: string;
	request: HttpRequestFn;
	logger?: Logger;
}): Promise<ClientInviteStatus> {
	const logger = (options.logger ?? new NoopLogger()).child("client_invite_status_http");
	const inviteUrl = new URL(options.invite.url);
	const token = inviteUrl.pathname.split("/").filter(Boolean).at(-1);
	if (!token) throw new Error("Client link does not contain an invite token");
	const response = await options.request({
		url: `${inviteUrl.origin}/client-invite-status`,
		method: "GET",
		headers: {
			Authorization: options.clientSecret,
			"X-Client-Invite-Token": token,
		},
		throw: false,
	});
	if (response.status !== 200) {
		logger.warn("request.rejected", { status: response.status });
		throw new Error(`Could not check client link (${response.status})`);
	}
	const parsed = clientInviteStatusSchema.safeParse(responseJson(response));
	if (!parsed.success) {
		logger.error("response.invalid", { status: response.status });
		throw new Error("Server returned an invalid client link status");
	}
	logger.debug("request.completed", {
		status: parsed.data.status,
		remainingSeconds: parsed.data.remainingSeconds,
	});
	return parsed.data;
}
