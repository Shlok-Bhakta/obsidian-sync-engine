export function isSyncExcludedPath(options: {
	path: string;
	configDir: string;
	pluginDir: string;
}): boolean {
	const dataPath = `${options.pluginDir}/data.json`;
	const stateDir = `${options.pluginDir}/state`;
	return (
		options.path === dataPath ||
		options.path === stateDir ||
		options.path.startsWith(`${stateDir}/`)
	);
}
