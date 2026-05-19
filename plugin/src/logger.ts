import { createLogger, parseLogLevel } from "../../shared/logger";

declare const __SYNC_LOG_LEVEL__: string | undefined;

const STORAGE_KEY = "obsidian-sync-engine.logLevel";
const buildLogLevel = parseLogLevel(typeof __SYNC_LOG_LEVEL__ === "string" ? __SYNC_LOG_LEVEL__ : undefined, "warn");

function getRuntimeLogLevel() {
    try {
        return parseLogLevel(window.localStorage.getItem(STORAGE_KEY), buildLogLevel);
    } catch {
        return buildLogLevel;
    }
}

export const log = createLogger({
    namespace: "obsidian-sync:plugin",
    level: buildLogLevel,
    getLevel: getRuntimeLogLevel,
});
