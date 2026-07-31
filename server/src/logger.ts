export type LogFields = Record<string, unknown>;

export interface Logger {
	debug(event: string, fields?: LogFields): void;
	info(event: string, fields?: LogFields): void;
	warn(event: string, fields?: LogFields): void;
	error(event: string, fields?: LogFields): void;
	child(component: string): Logger;
}

type LogLevel = "debug" | "info" | "warn" | "error";

function serializeError(error: unknown): unknown {
	if (!(error instanceof Error)) return error;
	return {
		name: error.name,
		message: error.message,
		stack: error.stack,
		cause: error.cause,
	};
}

function normalizeFields(fields?: LogFields): LogFields | undefined {
	if (!fields) return undefined;
	return Object.fromEntries(
		Object.entries(fields).map(([key, value]) => [key, serializeError(value)]),
	);
}

class ConsoleLogger implements Logger {
	constructor(private readonly component: string) {}

	debug(event: string, fields?: LogFields): void {
		this.write("debug", event, fields);
	}

	info(event: string, fields?: LogFields): void {
		this.write("info", event, fields);
	}

	warn(event: string, fields?: LogFields): void {
		this.write("warn", event, fields);
	}

	error(event: string, fields?: LogFields): void {
		this.write("error", event, fields);
	}

	child(component: string): Logger {
		return new ConsoleLogger(`${this.component}:${component}`);
	}

	private write(level: LogLevel, event: string, fields?: LogFields): void {
		const entry = {
			timestamp: new Date().toISOString(),
			level,
			component: this.component,
			event,
			...normalizeFields(fields),
		};
		try {
			const seen = new WeakSet<object>();
			const serialized = JSON.stringify(entry, (_key, value: unknown) => {
				if (typeof value === "bigint") return value.toString();
				if (value && typeof value === "object") {
					if (seen.has(value)) return "[Circular]";
					seen.add(value);
				}
				return value;
			});
			console[level](serialized);
		} catch {
			// Logging must never interrupt a server operation.
			console[level](
				JSON.stringify({
					timestamp: new Date().toISOString(),
					level,
					component: this.component,
					event,
					logSerializationFailed: true,
				}),
			);
		}
	}
}

export type CapturedLog = {
	level: LogLevel;
	component: string;
	event: string;
	fields?: LogFields;
};

/** In-memory dependency for tests that need to assert logs without printing. */
export class FakeLogger implements Logger {
	readonly entries: CapturedLog[];

	constructor(
		private readonly component = "server",
		entries: CapturedLog[] = [],
	) {
		this.entries = entries;
	}

	debug(event: string, fields?: LogFields): void {
		this.capture("debug", event, fields);
	}

	info(event: string, fields?: LogFields): void {
		this.capture("info", event, fields);
	}

	warn(event: string, fields?: LogFields): void {
		this.capture("warn", event, fields);
	}

	error(event: string, fields?: LogFields): void {
		this.capture("error", event, fields);
	}

	child(component: string): Logger {
		return new FakeLogger(`${this.component}:${component}`, this.entries);
	}

	private capture(level: LogLevel, event: string, fields?: LogFields): void {
		this.entries.push({
			level,
			component: this.component,
			event,
			fields: normalizeFields(fields),
		});
	}
}

/** Server logging is deliberately always enabled. */
export const serverLogger: Logger = new ConsoleLogger("server");
