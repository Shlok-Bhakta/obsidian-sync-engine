import { Debouncer } from "./debounce";
import type { SyncFs } from "./fs";
import { appendInbox, applyInbox, type InboxOp } from "./inbox";
import {
	drain as drainOutbox,
	enqueue as enqueueOutbox,
	list as listOutbox,
	type OutboxOp,
} from "./outbox";
import { canonicalizeSyncPath } from "./paths";

export type SyncTransport = {
	upload(
		path: string,
		body: ArrayBuffer | string,
	): Promise<{ revision: number }>;
	deleteRemote(path: string): Promise<{ revision: number }>;
	download(path: string): Promise<ArrayBuffer>;
	fetchInbox(rev: number): Promise<InboxOp[]>;
};

export type VaultBlobFs = SyncFs & {
	readBinary(path: string): Promise<ArrayBuffer>;
	writeBinary(path: string, data: ArrayBuffer): Promise<void>;
	remove(path: string): Promise<void>;
	listAllFiles?(): Promise<string[]>;
};

export type SyncEngineOptions = {
	fs: VaultBlobFs;
	transport: SyncTransport;
	outboxPath: string;
	inboxPath: string;
	deadLetterPath?: string;
	getRevision: () => number | Promise<number>;
	setRevision: (rev: number) => void | Promise<void>;
	/**
	 * Quiet period before a network drain/tick is scheduled after a local
	 * change. Durability is NOT delayed — outbox writes happen immediately.
	 */
	debounceMs?: number;
	/** Optional hook invoked when a permanent outbox failure is dead-lettered. */
	onPermanentFailure?: (failure: PermanentSyncFailure) => void;
};

export type PermanentSyncFailure = {
	op: OutboxOp;
	error: string;
	status?: number;
};

/** Discriminated result so callers never treat a failed tick as success. */
export type SyncTickResult =
	| { ok: true; pushed: number; applied: number; deadLettered: number }
	| { ok: false; error: string; pushed: number; applied: number; deadLettered: number };

const DEFAULT_DEBOUNCE_MS = 1000;

export class PermanentRemoteError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "PermanentRemoteError";
		this.status = status;
	}
}

/**
 * Minimal two-way sync engine: local edits flow out through the outbox,
 * remote edits flow in through the inbox.
 *
 * Local intent is written to the durable outbox immediately. Debouncing only
 * coalesces when the network drain runs, not whether the edit survives a
 * reload. The revision cursor advances only when inbox lines are applied
 * (including self-echo of our own pushes).
 */
export class SyncEngine {
	private readonly fs: VaultBlobFs;
	private readonly transport: SyncTransport;
	private readonly outboxPath: string;
	private readonly inboxPath: string;
	private readonly deadLetterPath: string;
	private readonly getRevision: () => number | Promise<number>;
	private readonly setRevision: (rev: number) => void | Promise<void>;
	private readonly debouncer: Debouncer<"tick">;
	private readonly onPermanentFailure?: (failure: PermanentSyncFailure) => void;

	/**
	 * Paths with a local change in the durable outbox (or a write in flight).
	 * Hydrated from the outbox on start so a restart cannot pull over pending work.
	 */
	private readonly pendingOutboxPaths = new Set<string>();

	/** Revisions returned by our own upload/deleteRemote, awaiting self-echo. */
	private readonly echoRevs = new Set<number>();

	/** Paths with an enqueue currently writing to the outbox. */
	private readonly enqueueInFlight = new Set<Promise<void>>();
	private readonly enqueueCounts = new Map<string, number>();

	private tickInFlight: Promise<SyncTickResult> | null = null;
	private hydrated = false;

	constructor(options: SyncEngineOptions) {
		this.fs = options.fs;
		this.transport = options.transport;
		this.outboxPath = options.outboxPath;
		this.inboxPath = options.inboxPath;
		this.deadLetterPath =
			options.deadLetterPath ??
			options.outboxPath.replace(/outbox\.jsonl$/, "dead-letter.jsonl");
		this.getRevision = options.getRevision;
		this.setRevision = options.setRevision;
		this.debouncer = new Debouncer(options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
		this.onPermanentFailure = options.onPermanentFailure;
	}

	/** Load durable outbox paths into the conflict guard before the first pull. */
	async hydrate(): Promise<void> {
		const ops = await listOutbox(this.fs, this.outboxPath);
		// Union with anything already marked pending (in-flight enqueue during startup).
		for (const op of ops) {
			this.pendingOutboxPaths.add(op.path);
		}
		this.hydrated = true;
	}

	/** Enqueue a local write — durable immediately, network work debounced. */
	enqueuePut(path: string): void {
		void this.enqueueDurable(path, "put");
	}

	/** Enqueue a local delete — durable immediately, network work debounced. */
	enqueueDelete(path: string): void {
		void this.enqueueDurable(path, "delete");
	}

	/**
	 * Awaitable enqueue for callers that must know the intent landed on disk
	 * (seed, unload flush). Still schedules a debounced network tick.
	 */
	async enqueueDurable(rawPath: string, op: "put" | "delete"): Promise<void> {
		const path = canonicalizeSyncPath(rawPath);
		this.pendingOutboxPaths.add(path);
		this.enqueueCounts.set(path, (this.enqueueCounts.get(path) ?? 0) + 1);
		const persistence = enqueueOutbox(this.fs, this.outboxPath, {
				op,
				path,
				ts: Date.now(),
			}).finally(async () => {
				const remaining = (this.enqueueCounts.get(path) ?? 1) - 1;
				if (remaining > 0) this.enqueueCounts.set(path, remaining);
				else this.enqueueCounts.delete(path);
				this.enqueueInFlight.delete(persistence);
				await this.refreshPending(path);
			});
		this.enqueueInFlight.add(persistence);
		await persistence;
		this.scheduleNetworkTick();
	}

	private scheduleNetworkTick(): void {
		this.debouncer.trigger("tick", () => this.tick().then(() => undefined));
	}

	/**
	 * Wait for in-flight durable enqueues and run any debounced network tick.
	 * Used before seed/unload so nothing sits only in memory.
	 */
	async flush(): Promise<void> {
		await Promise.all([...this.enqueueInFlight]);
		await this.debouncer.flush();
		if (this.tickInFlight) await this.tickInFlight;
	}

	private async refreshPending(path: string): Promise<void> {
		if ((this.enqueueCounts.get(path) ?? 0) > 0) {
			this.pendingOutboxPaths.add(path);
			return;
		}
		const outboxOps = await listOutbox(this.fs, this.outboxPath);
		if (outboxOps.some((op) => op.path === path)) {
			this.pendingOutboxPaths.add(path);
		} else {
			this.pendingOutboxPaths.delete(path);
		}
	}

	private async rebuildPendingPaths(): Promise<void> {
		this.pendingOutboxPaths.clear();
		for (const op of await listOutbox(this.fs, this.outboxPath)) {
			this.pendingOutboxPaths.add(op.path);
		}
		for (const path of this.enqueueCounts.keys()) {
			this.pendingOutboxPaths.add(path);
		}
	}

	/** Enqueue a put for every file in the vault (initial bootstrap / B1). */
	async seedFromVault(
		listFiles: () => Promise<string[]> | string[],
	): Promise<void> {
		await this.ensureHydrated();
		const files = await listFiles();
		for (const path of files) {
			await this.enqueueDurable(path, "put");
		}
	}

	/**
	 * One sync round: drain the outbox out, then pull and apply the inbox.
	 * Concurrent callers share the same in-flight promise (single-flight).
	 */
	async tick(): Promise<SyncTickResult> {
		if (this.tickInFlight) {
			return this.tickInFlight;
		}
		this.tickInFlight = this.runTick().finally(() => {
			this.tickInFlight = null;
		});
		return this.tickInFlight;
	}

	private async ensureHydrated(): Promise<void> {
		if (!this.hydrated) {
			await this.hydrate();
		}
	}

	private async runTick(): Promise<SyncTickResult> {
		let pushed = 0;
		let applied = 0;
		let deadLettered = 0;
		try {
			await this.ensureHydrated();
			while (true) {
				const drainResult = await this.drainOutboxOnce();
				pushed += drainResult.pushed;
				deadLettered += drainResult.deadLettered;
				await Promise.all([...this.enqueueInFlight]);
				if ((await listOutbox(this.fs, this.outboxPath)).length === 0) {
					break;
				}
			}
			await this.rebuildPendingPaths();
			applied = await this.applyRemoteInbox();
			if (deadLettered > 0) {
				return {
					ok: false,
					error: `${deadLettered} operation(s) require attention`,
					pushed,
					applied,
					deadLettered,
				};
			}
			return { ok: true, pushed, applied, deadLettered };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: message, pushed, applied, deadLettered };
		}
	}

	private async drainOutboxOnce(): Promise<{
		pushed: number;
		deadLettered: number;
	}> {
		await Promise.all([...this.enqueueInFlight]);
		const processedPaths = new Set<string>();
		let pushed = 0;
		let deadLettered = 0;

		await drainOutbox(this.fs, this.outboxPath, async (op) => {
			if (op.op === "put" && !(await this.fs.exists(op.path))) {
				processedPaths.add(op.path);
				return;
			}

			try {
				const result =
					op.op === "put"
						? await this.pushPut(op.path)
						: await this.pushDelete(op.path);
				this.echoRevs.add(result.revision);
				processedPaths.add(op.path);
				pushed++;
			} catch (error) {
				if (this.isPermanentFailure(error)) {
					await this.deadLetter(op, error);
					deadLettered++;
					processedPaths.add(op.path);
					return;
				}
				throw error;
			}
		});

		for (const path of processedPaths) {
			await this.refreshPending(path);
		}
		return { pushed, deadLettered };
	}

	private isPermanentFailure(error: unknown): boolean {
		return error instanceof PermanentRemoteError;
	}

	private async deadLetter(op: OutboxOp, error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		const status =
			error instanceof PermanentRemoteError ? error.status : undefined;
		const failure: PermanentSyncFailure = { op, error: message, status };
		const existing = (await this.fs.exists(this.deadLetterPath))
			? await this.fs.read(this.deadLetterPath)
			: "";
		const note = JSON.stringify({
			kind: "dead-letter",
			op: op.op,
			path: op.path,
			originalTs: op.ts,
			error: message,
			status: status ?? null,
			ts: Date.now(),
		});
		const base =
			existing.length === 0 || existing.endsWith("\n")
				? existing
				: existing + "\n";
		await this.fs.write(this.deadLetterPath, base + note + "\n");
		this.onPermanentFailure?.(failure);
	}

	private async pushPut(path: string): Promise<{ revision: number }> {
		const body = await this.fs.readBinary(path);
		return this.transport.upload(path, body);
	}

	private async pushDelete(path: string): Promise<{ revision: number }> {
		return this.transport.deleteRemote(path);
	}

	private async applyRemoteInbox(): Promise<number> {
		const rev = await this.getRevision();
		const ops = await this.transport.fetchInbox(rev);
		await appendInbox(this.fs, this.inboxPath, ops);

		let applied = 0;
		await applyInbox(this.fs, this.inboxPath, {
			applyPut: async (path) => {
				await this.applyRemotePut(path);
				applied++;
			},
			applyDelete: async (path) => {
				await this.applyRemoteDelete(path);
				applied++;
			},
			getRevision: () => this.getRevision(),
			setRevision: (newRev) => this.setRevision(newRev),
			shouldSkipApply: (op) => {
				if (this.echoRevs.delete(op.rev)) {
					return true;
				}
				return false;
			},
			shouldDeferApply: (op) => this.pendingOutboxPaths.has(op.path),
		});
		return applied;
	}

	private async applyRemotePut(path: string): Promise<void> {
		let data: ArrayBuffer;
		try {
			data = await this.transport.download(path);
		} catch (error) {
			// Stale put raced a later delete: treat as success so the inbox
			// can advance; a later tombstone still applies normally.
			if (
				error instanceof Error &&
				(error.name === "RemoteFileNotFoundError" ||
					/\b404\b/.test(error.message))
			) {
				return;
			}
			throw error;
		}
		await this.fs.writeBinary(path, data);
	}

	private async applyRemoteDelete(path: string): Promise<void> {
		await this.fs.remove(path);
	}

	/** Test/inspection helper: whether a path is treated as locally pending. */
	isPending(path: string): boolean {
		return this.pendingOutboxPaths.has(path);
	}
}
