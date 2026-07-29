export function normalizeServerUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

/** A reversible, collision-free directory key for one normalized server URL. */
export function serverIdentityFor(value: string): string {
	return encodeURIComponent(normalizeServerUrl(value));
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
