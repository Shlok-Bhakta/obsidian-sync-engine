export function normalizeServerUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

/** A reversible, collision-free directory key for one normalized server URL. */
export function serverIdentityFor(value: string): string {
	return encodeURIComponent(normalizeServerUrl(value));
}
