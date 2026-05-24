export const DEFAULT_CONFIG_DIR = ".obsidian";
export const DEFAULT_PLUGIN_ID = "obsidian-sync-engine";

function normalizeConfigDir(configDir: string): string {
    return configDir.replace(/^\/+|\/+$/g, "") || DEFAULT_CONFIG_DIR;
}

export function pluginInternalPrefix(configDir: string, pluginId: string): string {
    return `${normalizeConfigDir(configDir)}/plugins/${pluginId}`;
}

/** Plugin-local state that must not be replicated between clients. */
export function isPluginInternalPath(
    path: string,
    configDir = DEFAULT_CONFIG_DIR,
    pluginId = DEFAULT_PLUGIN_ID,
): boolean {
    const prefix = pluginInternalPrefix(configDir, pluginId);
    if (path === `${prefix}/data.json`) {
        return true;
    }
    if (path === `${prefix}/yjs-state` || path.startsWith(`${prefix}/yjs-state/`)) {
        return true;
    }
    if (path === `${prefix}/outbox` || path.startsWith(`${prefix}/outbox/`)) {
        return true;
    }
    if (path === `${prefix}/bootstrap` || path.startsWith(`${prefix}/bootstrap/`)) {
        return true;
    }
    return false;
}

export function isIgnoredVaultPath(path: string): boolean {
    return path === ".trash" || path.startsWith(".trash/")
        || path === ".sync-engine-state" || path.startsWith(".sync-engine-state/")
        || path === ".sync-engine-sync" || path.startsWith(".sync-engine-sync/")
        || path.split("/").includes(".git");
}

export function shouldSyncPath(
    path: string,
    configDir = DEFAULT_CONFIG_DIR,
    pluginId = DEFAULT_PLUGIN_ID,
): boolean {
    return Boolean(path) && !isIgnoredVaultPath(path) && !isPluginInternalPath(path, configDir, pluginId);
}

export function shouldUseYjs(path: string, configDir = DEFAULT_CONFIG_DIR): boolean {
    const normalizedConfigDir = normalizeConfigDir(configDir);
    return path.endsWith(".md") && path !== normalizedConfigDir && !path.startsWith(`${normalizedConfigDir}/`);
}
