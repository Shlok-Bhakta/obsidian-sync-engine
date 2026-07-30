import type { ClientInvite } from "obsidian-sync-protocol";
import type { HttpRequestFn } from "./http";

export type { ClientInvite } from "obsidian-sync-protocol";

export async function requestClientInvite(options: {
	serverUrl: string;
	clientSecret: string;
	request: HttpRequestFn;
}): Promise<ClientInvite> {
	const response = await options.request({
		url: `${options.serverUrl.replace(/\/+$/, "")}/client-invites`,
		method: "POST",
		headers: { Authorization: options.clientSecret },
		throw: false,
	});
	if (response.status !== 201) {
		throw new Error(`Could not create client package (${response.status})`);
	}
	const responseJson = response.json as unknown;
	const body = (typeof responseJson === "string"
		? JSON.parse(responseJson)
		: responseJson) as Partial<ClientInvite>;
	if (
		typeof body.url !== "string" ||
		!["http:", "https:"].includes(new URL(body.url).protocol) ||
		typeof body.expiresAt !== "string" ||
		!Number.isFinite(Date.parse(body.expiresAt))
	) {
		throw new Error("Server returned an invalid client package link");
	}
	return { url: body.url, expiresAt: body.expiresAt };
}
