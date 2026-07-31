import { describe, expect, test } from "bun:test";
import {
	normalizeServerUrl,
	legacyServerIdentityFor,
	resetServerCredentials,
	serverIdentityFor,
	transitionServerSettings,
} from "./serverIdentity";

describe("server identity", () => {
	test("normalizes whitespace and trailing slashes", () => {
		expect(normalizeServerUrl(" https://sync.example/v1/// ")).toBe(
			"https://sync.example/v1",
		);
	});

	test("does not collide for URLs that shared the legacy 32-bit hash", () => {
		const first = "https://m0g00hi01d.example";
		const second = "https://ae7qetyymf.example";
		expect(legacyServerIdentityFor(first)).toBe(
			legacyServerIdentityFor(second),
		);
		expect(serverIdentityFor(first)).not.toBe(serverIdentityFor(second));
	});

	test("produces one reversible path component", () => {
		const url = "https://sync.example:8443/team/vault";
		const identity = serverIdentityFor(url);
		expect(identity).not.toContain("/");
		expect(decodeURIComponent(identity)).toBe(url);
	});

	test("switching servers clears credentials and revision", () => {
		const settings = {
			serverUrl: "https://old.example",
			serverIdentity: serverIdentityFor("https://old.example"),
			clientSecret: "old-client-secret",
			revision: 42,
		};
		expect(
			transitionServerSettings(settings, "https://new.example/", "unpaired"),
		).toBe(true);
		expect(settings).toEqual({
			serverUrl: "https://new.example",
			serverIdentity: serverIdentityFor("https://new.example"),
			clientSecret: "unpaired",
			revision: 0,
		});
	});

	test("an externally mismatched identity resets credentials without changing URL", () => {
		const settings = {
			serverUrl: "https://new.example",
			serverIdentity: "identity-from-another-server",
			clientSecret: "old-client-secret",
			revision: 42,
		};
		resetServerCredentials(
			settings,
			serverIdentityFor(settings.serverUrl),
			"unpaired",
		);
		expect(settings.clientSecret).toBe("unpaired");
		expect(settings.revision).toBe(0);
		expect(settings.serverUrl).toBe("https://new.example");
	});
});
