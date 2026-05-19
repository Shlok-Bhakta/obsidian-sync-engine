export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

type LogMethod = Exclude<LogLevel, "silent">;

export type LogContext = Record<string, unknown>;

export type Logger = {
    debug: (message: string, context?: LogContext) => void;
    info: (message: string, context?: LogContext) => void;
    warn: (message: string, context?: LogContext) => void;
    error: (message: string, context?: LogContext) => void;
    child: (context: LogContext) => Logger;
};

const LEVELS: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 50,
};

export function parseLogLevel(value: string | null | undefined, fallback: LogLevel): LogLevel {
    if (value === "debug" || value === "info" || value === "warn" || value === "error" || value === "silent") {
        return value;
    }
    return fallback;
}

export function createLogger(options: {
    namespace: string;
    level: LogLevel;
    getLevel?: () => LogLevel;
    context?: LogContext;
}): Logger {
    const baseContext = options.context ?? {};

    function shouldLog(method: LogMethod): boolean {
        const currentLevel = options.getLevel?.() ?? options.level;
        return LEVELS[method] >= LEVELS[currentLevel];
    }

    function write(method: LogMethod, message: string, context?: LogContext): void {
        if (!shouldLog(method)) {
            return;
        }
        const mergedContext = { ...baseContext, ...context };
        const args: unknown[] = [
            `[${new Date().toISOString()}] [${options.namespace}] ${message}`,
        ];
        if (Object.keys(mergedContext).length > 0) {
            args.push(mergedContext);
        }

        if (method === "debug") {
            console.debug(...args);
        } else if (method === "info") {
            console.info(...args);
        } else if (method === "warn") {
            console.warn(...args);
        } else {
            console.error(...args);
        }
    }

    return {
        debug: (message, context) => write("debug", message, context),
        info: (message, context) => write("info", message, context),
        warn: (message, context) => write("warn", message, context),
        error: (message, context) => write("error", message, context),
        child: context => createLogger({
            ...options,
            context: { ...baseContext, ...context },
        }),
    };
}

export function errorContext(error: unknown): LogContext {
    if (error instanceof Error) {
        return {
            errorName: error.name,
            errorMessage: error.message,
            errorStack: error.stack,
        };
    }
    return { errorMessage: String(error) };
}
