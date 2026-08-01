import { describe, expect, test } from "bun:test";
import {
	checkServerHealth,
	ServerConnectionCoordinator,
	type AuthenticatedServerConnection,
} from "./serverConnection";
import { FakeLogger } from "./logger";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function connection(serverUrl: string): AuthenticatedServerConnection {
	return {
		serverUrl,
		clientName: "Main computer",
		clientSecret: `secret-for-${serverUrl}`,
	};
}

describe("server connection coordinator", () => {
	test("checks the normalized server /health endpoint", async () => {
		const requested: string[] = [];
		const healthy = await checkServerHealth({
			serverUrl: " https://sync.example/base/ ",
			request: async (params) => {
				requested.push(params.url);
				return { status: 204 } as never;
			},
			logger: new FakeLogger(),
		});

		expect(healthy).toBe(true);
		expect(requested).toEqual(["https://sync.example/base/health"]);
	});

	test("checks health after every field change and connects the latest value", async () => {
		const checked: string[] = [];
		const authenticated: string[] = [];
		const activated: string[] = [];
		const notices: string[] = [];
		let activeUrl = "https://old.example";
		const coordinator = new ServerConnectionCoordinator({
			checkHealth: async (serverUrl) => {
				checked.push(serverUrl);
				return true;
			},
			isConnected: (serverUrl) => serverUrl === activeUrl,
			authenticate: async (serverUrl) => {
				authenticated.push(serverUrl);
				return connection(serverUrl);
			},
			activate: async (candidate) => {
				activeUrl = candidate.serverUrl;
				activated.push(candidate.serverUrl);
				return true;
			},
			onConnected: (serverUrl) => notices.push(serverUrl),
		});

		await coordinator.update(" https://new.example/ ");
		await coordinator.update("https://new.example/");

		expect(checked).toEqual([
			"https://new.example",
			"https://new.example",
		]);
		expect(authenticated).toEqual(["https://new.example"]);
		expect(activated).toEqual(["https://new.example"]);
		expect(notices).toEqual(["https://new.example"]);
		expect(coordinator.getState()).toEqual({
			serverUrl: "https://new.example",
			status: "connected",
		});
	});

	test("signals establishment only after health, authentication, and activation", async () => {
		const events: string[] = [];
		const coordinator = new ServerConnectionCoordinator({
			checkHealth: async () => {
				events.push("health");
				return true;
			},
			isConnected: () => false,
			authenticate: async (serverUrl) => {
				events.push("authenticate");
				return connection(serverUrl);
			},
			activate: async () => {
				events.push("activate");
				return true;
			},
			onConnectionEstablished: () => events.push("established"),
			onConnected: () => events.push("notice"),
		});

		await coordinator.update("https://sync.example");

		expect(events).toEqual([
			"health",
			"authenticate",
			"activate",
			"established",
			"notice",
		]);
	});

	test("configured startup establishes silently after the handshake", async () => {
		const events: string[] = [];
		const coordinator = new ServerConnectionCoordinator({
			checkHealth: async () => true,
			isConnected: () => false,
			authenticate: async (serverUrl) => connection(serverUrl),
			activate: async () => true,
			onConnectionEstablished: (serverUrl) => events.push(serverUrl),
			onConnected: () => events.push("notice"),
		});

		await coordinator.update(
			"https://configured.example",
			{ announce: false },
		);

		expect(events).toEqual(["https://configured.example"]);
	});

	test("ignores a stale health response from an earlier keystroke", async () => {
		const firstHealth = deferred<boolean>();
		const authenticated: string[] = [];
		const coordinator = new ServerConnectionCoordinator({
			checkHealth: (serverUrl) =>
				serverUrl === "https://a.example"
					? firstHealth.promise
					: Promise.resolve(false),
			isConnected: () => false,
			authenticate: async (serverUrl) => {
				authenticated.push(serverUrl);
				return connection(serverUrl);
			},
			activate: async () => true,
			onConnected: () => undefined,
		});

		const first = coordinator.update("https://a.example");
		await coordinator.update("https://b.example");
		firstHealth.resolve(true);
		await first;

		expect(authenticated).toEqual([]);
		expect(coordinator.getState()).toEqual({
			serverUrl: "https://b.example",
			status: "failed",
		});
	});

	test("does not activate a stale authentication response", async () => {
		const firstAuth = deferred<AuthenticatedServerConnection>();
		const activated: string[] = [];
		const coordinator = new ServerConnectionCoordinator({
			checkHealth: async () => true,
			isConnected: () => false,
			authenticate: (serverUrl) =>
				serverUrl === "https://a.example"
					? firstAuth.promise
					: Promise.reject(new Error("not paired")),
			activate: async (candidate) => {
				activated.push(candidate.serverUrl);
				return true;
			},
			onConnected: () => undefined,
		});

		const first = coordinator.update("https://a.example");
		await coordinator.update("https://b.example");
		firstAuth.resolve(connection("https://a.example"));
		await first;

		expect(activated).toEqual([]);
		expect(coordinator.getState().serverUrl).toBe("https://b.example");
		expect(coordinator.getState().status).toBe("failed");
	});

	test("reports health and authentication failures without success notices", async () => {
		const notices: string[] = [];
		const established: string[] = [];
		let healthSucceeds = false;
		const coordinator = new ServerConnectionCoordinator({
			checkHealth: async () => healthSucceeds,
			isConnected: () => false,
			authenticate: async () => {
				throw new Error("rejected");
			},
			activate: async () => true,
			onConnectionEstablished: (serverUrl) => established.push(serverUrl),
			onConnected: (serverUrl) => notices.push(serverUrl),
		});

		await coordinator.update("https://offline.example");
		expect(coordinator.getState().status).toBe("failed");

		healthSucceeds = true;
		await coordinator.update("https://unpaired.example");
		expect(coordinator.getState().status).toBe("failed");
		expect(notices).toEqual([]);
		expect(established).toEqual([]);
	});

	test("marking a configured startup connection never shows a notice", () => {
		const notices: string[] = [];
		const coordinator = new ServerConnectionCoordinator({
			checkHealth: async () => true,
			isConnected: () => true,
			authenticate: async (serverUrl) => connection(serverUrl),
			activate: async () => true,
			onConnected: (serverUrl) => notices.push(serverUrl),
		});

		coordinator.markConnected("https://configured.example/");

		expect(notices).toEqual([]);
		expect(coordinator.getState()).toEqual({
			serverUrl: "https://configured.example",
			status: "connected",
		});
	});
});
