export type ClientInvite = {
	url: string;
	expiresAt: string;
};

type InviteRequestOptions = {
	url: string;
	method: "POST";
	headers: Record<string, string>;
	throw: false;
};

type InviteResponse = {
	status: number;
	json: unknown;
	text: string;
};

type Request = (
	options: InviteRequestOptions,
) => Promise<InviteResponse>;

export async function requestClientInvite(options: {
	serverUrl: string;
	clientSecret: string;
	request: Request;
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
	const body = (typeof response.json === "string"
		? JSON.parse(response.json)
		: response.json) as Partial<ClientInvite>;
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
