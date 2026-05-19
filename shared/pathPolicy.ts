export const DEFAULT_CONFIG_DIR = ".obsidian";
export const DEFAULT_PLUGIN_ID = "obsidian-sync-engine";

function normalizeConfigDir(configDir: string): string {
    return configDir.replace(/^\/+|\/+$/g, "") || DEFAULT_CONFIG_DIR;
}

export function pluginInternalPrefix(configDir: string, pluginId: string): string {
    return `${normalizeConfigDir(configDir)}/plugins/${pluginId}`;
}

export function isPluginInternalPath(
    path: string,
    configDir = DEFAULT_CONFIG_DIR,
    pluginId = DEFAULT_PLUGIN_ID,
): boolean {
    const prefix = pluginInternalPrefix(configDir, pluginId);
    return (
        path === `${prefix}/data.json` ||
        path.startsWith(`${prefix}/outbox/`) ||
        path === `${prefix}/outbox` ||
        path.startsWith(`${prefix}/yjs-state/`) ||
        path === `${prefix}/yjs-state`
    );
}

export function shouldSyncPath(
    path: string,
    configDir = DEFAULT_CONFIG_DIR,
    pluginId = DEFAULT_PLUGIN_ID,
): boolean {
    return Boolean(path) && !isPluginInternalPath(path, configDir, pluginId);
}

export function shouldUseYjs(path: string, configDir = DEFAULT_CONFIG_DIR): boolean {
    const normalizedConfigDir = normalizeConfigDir(configDir);
    return path.endsWith(".md") && path !== normalizedConfigDir && !path.startsWith(`${normalizedConfigDir}/`);
}
