import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { deserialize, MessageType, serialize } from "obsidian-sync-protocol";
import { registerAuthRoutes } from "./auth";

async function readMessage(res: Response) {
	const body = await res.json();
	// Routes historically `c.json(serialize(...))`, which double-encodes into a JSON string.
	return deserialize(typeof body === "string" ? body : JSON.stringify(body));
}

describe("HTTP /auth", () => {
	it("issues a secret for the first client on an empty server", async () => {
		const app = new Hono();
		registerAuthRoutes(app);

		const res = await app.request("/auth", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${process.env.BOOTSTRAP_TOKEN}`,
			},
			body: serialize({
				type: MessageType.AUTH_ACK,
				client_name: "first-client",
				token: "Made by server",
			}),
		});
		expect(res.status).toBe(200);
		const message = await readMessage(res);
		expect(message.type).toBe(MessageType.AUTH_INIT);
		if (message.type === MessageType.AUTH_INIT) {
			expect(message.token.length).toBeGreaterThan(8);
			expect(message.client_name).toBe("first-client");
		}
	});

	it("accepts a second request with the issued secret", async () => {
		const app = new Hono();
		registerAuthRoutes(app);

		const first = await app.request("/auth", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${process.env.BOOTSTRAP_TOKEN}`,
			},
			body: serialize({
				type: MessageType.AUTH_ACK,
				client_name: "only-client",
				token: "Made by server",
			}),
		});
		const init = await readMessage(first);
		expect(init.type).toBe(MessageType.AUTH_INIT);
		if (init.type !== MessageType.AUTH_INIT) {
			throw new Error("expected AUTH_INIT");
		}

		const second = await app.request("/auth", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: serialize({
				type: MessageType.AUTH_ACK,
				client_name: "only-client",
				token: init.token,
			}),
		});
		expect(second.status).toBe(200);
		expect((await readMessage(second)).type).toBe(MessageType.AUTH_SUCCESS);
	});

	it("allows exactly one concurrent first-client enrollment", async () => {
		const app = new Hono();
		registerAuthRoutes(app);
		const request = (clientName: string) =>
			app.request("/auth", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${process.env.BOOTSTRAP_TOKEN}`,
				},
				body: serialize({
					type: MessageType.AUTH_ACK,
					client_name: clientName,
					token: "unissued",
				}),
			});
		const responses = await Promise.all([request("first-a"), request("first-b")]);
		expect(responses.map(({ status }) => status).sort()).toEqual([200, 401]);
	});
});
