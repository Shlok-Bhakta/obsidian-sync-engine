import { describe, expect, test } from "bun:test";
import { normalizeServerUrl, serverIdentityFor } from "./serverIdentity";

describe("server identity", () => {
	test("normalizes whitespace and trailing slashes", () => {
		expect(normalizeServerUrl(" https://sync.example/v1/// ")).toBe(
			"https://sync.example/v1",
		);
	});

	test("does not collide for URLs that shared the legacy 32-bit hash", () => {
		const first = "https://m0g00hi01d.example";
		const second = "https://ae7qetyymf.example";
		expect(serverIdentityFor(first)).not.toBe(serverIdentityFor(second));
	});

	test("produces one reversible path component", () => {
		const url = "https://sync.example:8443/team/vault";
		const identity = serverIdentityFor(url);
		expect(identity).not.toContain("/");
		expect(decodeURIComponent(identity)).toBe(url);
	});
});
