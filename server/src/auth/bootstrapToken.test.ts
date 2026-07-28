import { describe, expect, it } from "bun:test";
import { createClientFixture, createTestApp } from "../test/fixtures";
import {
	assertBootstrapAuthorized,
	extractBootstrapToken,
} from "./bootstrapToken";

describe("bootstrap token helpers", () => {
	it("extracts bearer and raw authorization tokens", () => {
		expect(
			extractBootstrapToken({
				authorizationHeader: "Bearer secret-value",
				queryToken: undefined,
			}),
		).toBe("secret-value");
		expect(
			extractBootstrapToken({
				authorizationHeader: "raw-token",
				queryToken: undefined,
			}),
		).toBe("raw-token");
		expect(
			extractBootstrapToken({
				authorizationHeader: undefined,
				queryToken: "from-query",
			}),
		).toBe("from-query");
	});

	it("denies bootstrap when BOOTSTRAP_TOKEN is unset", () => {
		const previous = process.env.BOOTSTRAP_TOKEN;
		delete process.env.BOOTSTRAP_TOKEN;
		try {
			const result = assertBootstrapAuthorized({
				authorizationHeader: "anything",
				queryToken: undefined,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.status).toBe(503);
			}
		} finally {
			if (previous === undefined) {
				delete process.env.BOOTSTRAP_TOKEN;
			} else {
				process.env.BOOTSTRAP_TOKEN = previous;
			}
		}
	});

	it("accepts a matching token and rejects a mismatch", () => {
		const previous = process.env.BOOTSTRAP_TOKEN;
		process.env.BOOTSTRAP_TOKEN = "correct-token";
		try {
			expect(
				assertBootstrapAuthorized({
					authorizationHeader: "Bearer correct-token",
					queryToken: undefined,
				}).ok,
			).toBe(true);
			const denied = assertBootstrapAuthorized({
				authorizationHeader: "Bearer wrong",
				queryToken: undefined,
			});
			expect(denied.ok).toBe(false);
			if (!denied.ok) {
				expect(denied.status).toBe(401);
			}
		} finally {
			if (previous === undefined) {
				delete process.env.BOOTSTRAP_TOKEN;
			} else {
				process.env.BOOTSTRAP_TOKEN = previous;
			}
		}
	});
});

describe("GET /bootstrap.zip auth gate", () => {
	it("returns 503 when BOOTSTRAP_TOKEN is not configured", async () => {
		await createClientFixture({ client_name: "alice" });
		const previous = process.env.BOOTSTRAP_TOKEN;
		delete process.env.BOOTSTRAP_TOKEN;
		try {
			const app = createTestApp();
			const res = await app.request("/bootstrap.zip");
			expect(res.status).toBe(503);
			const body = (await res.json()) as { error: string };
			expect(body.error).toContain("BOOTSTRAP_TOKEN");
		} finally {
			if (previous === undefined) {
				delete process.env.BOOTSTRAP_TOKEN;
			} else {
				process.env.BOOTSTRAP_TOKEN = previous;
			}
		}
	});

	it("returns 401 without a valid token after setup", async () => {
		await createClientFixture({ client_name: "alice" });
		const previous = process.env.BOOTSTRAP_TOKEN;
		process.env.BOOTSTRAP_TOKEN = "e2e-bootstrap-secret";
		try {
			const app = createTestApp();
			const unauth = await app.request("/bootstrap.zip");
			expect(unauth.status).toBe(401);

			const wrong = await app.request("/bootstrap.zip", {
				headers: { Authorization: "Bearer nope" },
			});
			expect(wrong.status).toBe(401);
		} finally {
			if (previous === undefined) {
				delete process.env.BOOTSTRAP_TOKEN;
			} else {
				process.env.BOOTSTRAP_TOKEN = previous;
			}
		}
	});

	it("allows bootstrap with a valid bearer token", async () => {
		await createClientFixture({ client_name: "alice" });
		const previous = process.env.BOOTSTRAP_TOKEN;
		process.env.BOOTSTRAP_TOKEN = "e2e-bootstrap-secret";
		try {
			const app = createTestApp();
			const res = await app.request("/bootstrap.zip", {
				headers: { Authorization: "Bearer e2e-bootstrap-secret" },
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("application/zip");
			expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
		} finally {
			if (previous === undefined) {
				delete process.env.BOOTSTRAP_TOKEN;
			} else {
				process.env.BOOTSTRAP_TOKEN = previous;
			}
		}
	});
});
