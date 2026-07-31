import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { deserialize, MessageType, serialize } from "obsidian-sync-protocol";
import { registerAuthRoutes } from "./auth";
import { createClientFixture } from "../test/fixtures";

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
			headers: { "Content-Type": "application/json" },
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
			headers: { "Content-Type": "application/json" },
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
				headers: { "Content-Type": "application/json" },
				body: serialize({
					type: MessageType.AUTH_ACK,
					client_name: clientName,
					token: "unissued",
				}),
			});
		const responses = await Promise.all([request("first-a"), request("first-b")]);
		expect(responses.map(({ status }) => status).sort()).toEqual([200, 401]);
	});

	it("rotates a secret only when name and current token match atomically", async () => {
		const app = new Hono();
		registerAuthRoutes(app);
		const enrolled = await app.request("/auth", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: serialize({
				type: MessageType.AUTH_ACK,
				client_name: "rotate-me",
				token: "unissued",
			}),
		});
		const init = await readMessage(enrolled);
		if (init.type !== MessageType.AUTH_INIT) {
			throw new Error("expected AUTH_INIT");
		}

		const denied = await app.request("/reset-client-secret", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: serialize({
				type: MessageType.AUTH_ACK,
				client_name: "rotate-me",
				token: "wrong-token",
			}),
		});
		expect(denied.status).toBe(401);

		const rotated = await app.request("/reset-client-secret", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: serialize({
				type: MessageType.AUTH_ACK,
				client_name: "rotate-me",
				token: init.token,
			}),
		});
		expect(rotated.status).toBe(200);
		const message = await readMessage(rotated);
		expect(message.type).toBe(MessageType.AUTH_INIT);
		if (message.type === MessageType.AUTH_INIT) {
			expect(message.token).not.toBe(init.token);
		}
	});

	it("rotating one client leaves every other client credential valid", async () => {
		const app = new Hono();
		registerAuthRoutes(app);
		const first = await createClientFixture({ client_name: "first" });
		const second = await createClientFixture({ client_name: "second" });

		const rotated = await app.request("/reset-client-secret", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: serialize({
				type: MessageType.AUTH_ACK,
				client_name: first.client_name,
				token: first.client_secret,
			}),
		});
		expect(rotated.status).toBe(200);

		const secondAuth = await app.request("/auth", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: serialize({
				type: MessageType.AUTH_ACK,
				client_name: second.client_name,
				token: second.client_secret,
			}),
		});
		expect(secondAuth.status).toBe(200);
		expect((await readMessage(secondAuth)).type).toBe(
			MessageType.AUTH_SUCCESS,
		);
	});
});
