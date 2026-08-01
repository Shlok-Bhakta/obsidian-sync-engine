import type {
	SyncTickOptions,
	SyncTickResult,
} from "../sync/engine";
import type { SyncFs } from "../sync/fs";

const ERROR_SUMMARY_LIMIT = 160;

export type SyncControlSnapshot = {
	outboxDepth: number;
	inboxDepth: number;
	lastSuccessfulSyncAt: number | null;
	lastError: string | null;
	manualInboxRequestInFlight: boolean;
};

type QueueRuntime = {
	fs: SyncFs;
	outboxPath: string;
	inboxPath: string;
	generation: number;
};

export type ManualSyncTarget = {
	isTickActive(): boolean;
	tick(options?: SyncTickOptions): Promise<SyncTickResult>;
};

export function countRawJsonlRows(raw: string): number {
	return raw.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

function bounded(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (!normalized || normalized === "[object Object]") {
		return "Sync failed unexpectedly";
	}
	return normalized.length <= ERROR_SUMMARY_LIMIT
		? normalized
		: `${normalized.slice(0, ERROR_SUMMARY_LIMIT - 1).trimEnd()}…`;
}

/** Convert arbitrary thrown values to a short, safe, human-readable summary. */
export function safeErrorSummary(error: unknown): string {
	if (error instanceof Error) return bounded(error.message);
	if (typeof error === "string") return bounded(error.split(/\r?\n/, 1)[0] ?? "");
	if (error === null || error === undefined) return "Sync failed unexpectedly";
	if (typeof error === "number" || typeof error === "boolean") {
		return bounded(`${error}`);
	}
	if (typeof error === "bigint") return bounded(error.toString());
	if (typeof error === "symbol") return bounded(error.description ?? "Symbol error");
	if (typeof error === "function") return bounded(error.name || "Function error");

	try {
		const seen = new WeakSet<object>();
		const serialized = JSON.stringify(error, (_key, value: unknown) => {
			if (typeof value === "bigint") return value.toString();
			if (typeof value === "object" && value !== null) {
				if (seen.has(value)) return "[circular]";
				seen.add(value);
			}
			return value;
		});
		return serialized === undefined
			? "Sync failed unexpectedly"
			: bounded(serialized);
	} catch {
		return "Sync failed unexpectedly";
	}
}

export function formatShortRelativeTime(
	timestamp: number | null,
	now = Date.now(),
): string {
	if (timestamp === null) return "Never";
	const elapsedSeconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (elapsedSeconds < 10) return "Just now";
	if (elapsedSeconds < 60) return `${elapsedSeconds}s ago`;
	const minutes = Math.floor(elapsedSeconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export class SyncStatusState {
	private snapshot: SyncControlSnapshot = {
		outboxDepth: 0,
		inboxDepth: 0,
		lastSuccessfulSyncAt: null,
		lastError: null,
		manualInboxRequestInFlight: false,
	};
	private readonly listeners = new Set<(state: SyncControlSnapshot) => void>();
	private runtime: QueueRuntime | null = null;
	private generation = 0;
	private refreshTail: Promise<void> = Promise.resolve();
	private refreshRunning = false;
	private refreshRequested = false;

	get(): Readonly<SyncControlSnapshot> {
		return this.snapshot;
	}

	/** Compatibility for diagnostics that inspect the prior plain status object. */
	get lastError(): string | null {
		return this.snapshot.lastError;
	}

	subscribe(listener: (state: SyncControlSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => this.listeners.delete(listener);
	}

	setQueueRuntime(fs: SyncFs, outboxPath: string, inboxPath: string): Promise<void> {
		this.generation++;
		this.runtime = { fs, outboxPath, inboxPath, generation: this.generation };
		this.update({ outboxDepth: 0, inboxDepth: 0 });
		return this.refreshQueueDepths();
	}

	refreshQueueDepths(): Promise<void> {
		if (!this.runtime) return Promise.resolve();
		this.refreshRequested = true;
		if (this.refreshRunning) return this.refreshTail;
		this.refreshRunning = true;
		this.refreshTail = this.runRefreshLoop().finally(() => {
			this.refreshRunning = false;
		});
		return this.refreshTail;
	}

	recordTickResult(result: SyncTickResult, completedAt = Date.now()): void {
		if (result.ok || result.failureKind === "dead-letter") {
			this.update({ lastSuccessfulSyncAt: completedAt, lastError: null });
			return;
		}
		this.recordError(result.error);
	}

	recordError(error: unknown): void {
		this.update({ lastError: safeErrorSummary(error) });
	}

	setManualInboxRequestInFlight(inFlight: boolean): void {
		this.update({ manualInboxRequestInFlight: inFlight });
	}

	resetForRuntimeChange(): void {
		this.update({
			lastSuccessfulSyncAt: null,
			lastError: null,
			manualInboxRequestInFlight: false,
		});
	}

	private async readDepth(fs: SyncFs, path: string): Promise<number> {
		if (!(await fs.exists(path))) return 0;
		return countRawJsonlRows(await fs.read(path));
	}

	private async runRefreshLoop(): Promise<void> {
		let firstError: unknown;
		do {
			this.refreshRequested = false;
			const runtime = this.runtime;
			if (!runtime) continue;
			try {
				const [outboxDepth, inboxDepth] = await Promise.all([
					this.readDepth(runtime.fs, runtime.outboxPath),
					this.readDepth(runtime.fs, runtime.inboxPath),
				]);
				if (this.runtime?.generation === runtime.generation) {
					this.update({ outboxDepth, inboxDepth });
				}
			} catch (error) {
				firstError ??= error;
			}
		} while (this.refreshRequested);
		if (firstError !== undefined) {
			throw firstError instanceof Error
				? firstError
				: new Error(safeErrorSummary(firstError));
		}
	}

	private update(change: Partial<SyncControlSnapshot>): void {
		const next = { ...this.snapshot, ...change };
		if (
			next.outboxDepth === this.snapshot.outboxDepth &&
			next.inboxDepth === this.snapshot.inboxDepth &&
			next.lastSuccessfulSyncAt === this.snapshot.lastSuccessfulSyncAt &&
			next.lastError === this.snapshot.lastError &&
			next.manualInboxRequestInFlight ===
				this.snapshot.manualInboxRequestInFlight
		) return;
		this.snapshot = next;
		for (const listener of this.listeners) listener(next);
	}
}

/** Deduplicates status-bar requests without owning or reimplementing sync. */
export class ManualSyncCoordinator {
	private requestInFlight = false;

	constructor(private readonly state: SyncStatusState) {}

	request(engine: ManualSyncTarget): Promise<SyncTickResult> | null {
		if (this.requestInFlight || engine.isTickActive()) return null;
		this.requestInFlight = true;
		return engine.tick({
			onInboxRequestStarted: () =>
				this.state.setManualInboxRequestInFlight(true),
			onInboxRequestFinished: () =>
				this.state.setManualInboxRequestInFlight(false),
		}).finally(() => {
			this.state.setManualInboxRequestInFlight(false);
			this.requestInFlight = false;
		});
	}
}
