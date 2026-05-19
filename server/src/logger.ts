import { createLogger, parseLogLevel } from "../../shared/logger";

const envLogLevel = Bun.env.SYNC_LOG_LEVEL ?? Bun.env.LOG_LEVEL;

export const log = createLogger({
  namespace: "obsidian-sync:server",
  level: parseLogLevel(envLogLevel, "warn"),
});
