import {
	clientInviteSchema,
	type ClientInvite,
} from "obsidian-sync-protocol";
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
	const body: unknown = typeof response.json === "string"
		? (JSON.parse(response.json) as unknown)
		: response.json;
	const parsed = clientInviteSchema.safeParse(body);
	if (!parsed.success) {
		throw new Error("Server returned an invalid client package link");
	}
	return parsed.data;
}
