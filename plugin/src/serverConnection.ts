import type { HttpRequestFn } from "./http";
import type { Logger } from "./logger";
import { normalizeServerUrl } from "./sync/serverIdentity";

export type ServerConnectionStatus =
	| "unknown"
	| "checking"
	| "connected"
	| "failed";

export type ServerConnectionState = {
	serverUrl: string;
	status: ServerConnectionStatus;
};

export type AuthenticatedServerConnection = {
	serverUrl: string;
	clientName: string;
	clientSecret: string;
};

type ServerConnectionCoordinatorOptions = {
	checkHealth: (serverUrl: string) => Promise<boolean>;
	isConnected: (serverUrl: string) => boolean;
	authenticate: (
		serverUrl: string,
	) => Promise<AuthenticatedServerConnection>;
	activate: (
		connection: AuthenticatedServerConnection,
		isCurrent: () => boolean,
	) => Promise<boolean>;
	onConnectionEstablished?: (serverUrl: string) => void;
	onConnected: (serverUrl: string) => void;
	onStateChanged?: (state: ServerConnectionState) => void;
};

type ServerConnectionUpdateOptions = {
	announce?: boolean;
};

/**
 * Coordinates URL-field requests so only the newest value can update state.
 * Obsidian's requestUrl cannot be aborted, so every async boundary checks a
 * monotonically increasing attempt number before continuing.
 */
export class ServerConnectionCoordinator {
	private readonly options: ServerConnectionCoordinatorOptions;
	private attempt = 0;
	private state: ServerConnectionState = {
		serverUrl: "",
		status: "unknown",
	};

	constructor(options: ServerConnectionCoordinatorOptions) {
		this.options = options;
	}

	getState(): ServerConnectionState {
		return { ...this.state };
	}

	markConnected(serverUrl: string): void {
		const normalized = normalizeServerUrl(serverUrl);
		if (this.state.status === "checking" && this.state.serverUrl !== normalized) {
			return;
		}
		this.setState(normalized, "connected");
	}

	markFailed(serverUrl: string): void {
		const normalized = normalizeServerUrl(serverUrl);
		if (this.state.status === "checking" && this.state.serverUrl !== normalized) {
			return;
		}
		this.setState(normalized, "failed");
	}

	async update(
		serverUrl: string,
		options: ServerConnectionUpdateOptions = {},
	): Promise<void> {
		const normalized = normalizeServerUrl(serverUrl);
		const attempt = ++this.attempt;
		const isCurrent = () => attempt === this.attempt;
		this.setState(normalized, "checking");

		let healthy = false;
		try {
			healthy = await this.options.checkHealth(normalized);
		} catch {
			healthy = false;
		}
		if (!isCurrent()) return;
		if (!healthy) {
			this.setState(normalized, "failed");
			return;
		}

		if (this.options.isConnected(normalized)) {
			this.setState(normalized, "connected");
			return;
		}

		try {
			const connection = await this.options.authenticate(normalized);
			if (!isCurrent()) return;
			const activated = await this.options.activate(connection, isCurrent);
			if (!activated || !isCurrent()) return;
			this.setState(normalized, "connected");
			this.options.onConnectionEstablished?.(normalized);
			if (options.announce !== false) {
				this.options.onConnected(normalized);
			}
		} catch {
			if (isCurrent()) this.setState(normalized, "failed");
		}
	}

	private setState(
		serverUrl: string,
		status: ServerConnectionStatus,
	): void {
		this.state = { serverUrl, status };
		this.options.onStateChanged?.(this.getState());
	}
}

export async function checkServerHealth(options: {
	serverUrl: string;
	request: HttpRequestFn;
	logger: Logger;
}): Promise<boolean> {
	const logger = options.logger.child("health_http");
	const startedAt = Date.now();
	try {
		const response = await options.request({
			url: `${normalizeServerUrl(options.serverUrl)}/health`,
			method: "GET",
			throw: false,
		});
		const healthy = response.status >= 200 && response.status < 300;
		logger.info("request.completed", {
			serverUrl: options.serverUrl,
			status: response.status,
			healthy,
			durationMs: Date.now() - startedAt,
		});
		return healthy;
	} catch (error) {
		logger.debug("request.failed", {
			serverUrl: options.serverUrl,
			durationMs: Date.now() - startedAt,
			error,
		});
		return false;
	}
}
