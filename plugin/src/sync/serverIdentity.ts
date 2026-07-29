export function normalizeServerUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

/** A reversible, collision-free directory key for one normalized server URL. */
export function serverIdentityFor(value: string): string {
	return encodeURIComponent(normalizeServerUrl(value));
}

/** Identity format used before collision-free URL encoding was introduced. */
export function legacyServerIdentityFor(value: string): string {
	const normalized = normalizeServerUrl(value);
	let hash = 0x811c9dc5;
	for (let index = 0; index < normalized.length; index++) {
		hash ^= normalized.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

type MutableServerSettings = {
	serverUrl: string;
	serverIdentity: string;
	clientSecret: string;
	setupToken: string;
	revision: number;
};

/** Applies the credential and cursor reset required before changing servers. */
export function transitionServerSettings(
	settings: MutableServerSettings,
	value: string,
	defaultClientSecret: string,
): boolean {
	const serverUrl = normalizeServerUrl(value);
	if (serverUrl === settings.serverUrl) return false;
	settings.serverUrl = serverUrl;
	settings.serverIdentity = serverIdentityFor(serverUrl);
	settings.clientSecret = defaultClientSecret;
	settings.setupToken = "";
	settings.revision = 0;
	return true;
}

export function resetServerCredentials(
	settings: MutableServerSettings,
	nextIdentity: string,
	defaultClientSecret: string,
): void {
	settings.serverIdentity = nextIdentity;
	settings.clientSecret = defaultClientSecret;
	settings.setupToken = "";
	settings.revision = 0;
}
