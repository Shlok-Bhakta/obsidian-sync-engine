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
		const prefix = `[obsidian-sync:${this.component}] ${event}`;
		const details = normalizeFields(fields);
		if (details) {
			// Development builds intentionally opt into diagnostic console output.
			// eslint-disable-next-line obsidianmd/rule-custom-message
			console[level](prefix, details);
		} else {
			// Development builds intentionally opt into diagnostic console output.
			// eslint-disable-next-line obsidianmd/rule-custom-message
			console[level](prefix);
		}
	}
}

export class NoopLogger implements Logger {
	debug(): void {}
	info(): void {}
	warn(): void {}
	error(): void {}

	child(): Logger {
		return this;
	}
}

export type CapturedLog = {
	level: LogLevel;
	component: string;
	event: string;
	fields?: LogFields;
};

/** In-memory logger for unit tests and local harnesses. */
export class FakeLogger implements Logger {
	readonly entries: CapturedLog[];

	constructor(
		private readonly component = "client",
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

export function createClientLogger(enabled: boolean): Logger {
	return enabled ? new ConsoleLogger("client") : new NoopLogger();
}
