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
import { NoopLogger, type Logger } from "../logger";

export type SyncTransport = {
	upload(
		path: string,
		body: ArrayBuffer | string,
	): Promise<{ revision: number }>;
	deleteRemote(path: string, baseRevision?: number): Promise<{ revision: number }>;
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
	onEnqueueFailure?: (error: Error, op: OutboxOp) => void;
	/** Called after either durable queue file changes. */
	onQueueChanged?: () => void;
	/** Called once when a sync round finishes, including failed rounds. */
	onTickCompleted?: (result: SyncTickResult) => void;
	/** Stops all persistence/network work while runtime configuration is stale. */
	isSuspended?: () => boolean;
	logger?: Logger;
};

export type SyncTickOptions = {
	/** Manual-sync UI hook: only wraps the server inbox request, not application. */
	onInboxRequestStarted?: () => void;
	onInboxRequestFinished?: () => void;
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
	private readonly onEnqueueFailure?: (error: Error, op: OutboxOp) => void;
	private readonly onQueueChanged?: () => void;
	private readonly onTickCompleted?: (result: SyncTickResult) => void;
	private readonly isSuspended: () => boolean;
	private readonly logger: Logger;

	/**
	 * Paths with a local change in the durable outbox (or a write in flight).
	 * Hydrated from the outbox on start so a restart cannot pull over pending work.
	 */
	private readonly pendingOutboxPaths = new Set<string>();

	/** Paths with an enqueue currently writing to the outbox. */
	private readonly enqueueInFlight = new Set<Promise<void>>();
	private readonly enqueueCounts = new Map<string, number>();
	private readonly failedEnqueues = new Map<string, OutboxOp>();

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
		this.onPermanentFailure = options.onPermanentFailure;
		this.onEnqueueFailure = options.onEnqueueFailure;
		this.onQueueChanged = options.onQueueChanged;
		this.onTickCompleted = options.onTickCompleted;
		this.isSuspended = options.isSuspended ?? (() => false);
		this.logger = (options.logger ?? new NoopLogger()).child("engine");
		this.debouncer = new Debouncer(
			options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
			this.logger,
		);
		this.logger.info("created", {
			outboxPath: this.outboxPath,
			inboxPath: this.inboxPath,
			deadLetterPath: this.deadLetterPath,
			debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
		});
	}

	/** Load durable outbox paths into the conflict guard before the first pull. */
	async hydrate(): Promise<void> {
		this.logger.debug("hydrate.started");
		const ops = await listOutbox(this.fs, this.outboxPath, this.logger);
		// Union with anything already marked pending (in-flight enqueue during startup).
		for (const op of ops) {
			this.pendingOutboxPaths.add(op.path);
		}
		this.hydrated = true;
		this.logger.info("hydrate.completed", {
			outboxOperations: ops.length,
			pendingPaths: this.pendingOutboxPaths.size,
		});
	}

	/** Enqueue a local write — durable immediately, network work debounced. */
	enqueuePut(path: string): void {
		void this.enqueueDurable(path, "put").catch((error) => {
			this.logger.error("enqueue.fire_and_forget_failed", {
				path,
				operation: "put",
				error,
			});
		});
	}

	/** Enqueue a local delete — durable immediately, network work debounced. */
	enqueueDelete(path: string): void {
		void this.enqueueDurable(path, "delete").catch((error) => {
			this.logger.error("enqueue.fire_and_forget_failed", {
				path,
				operation: "delete",
				error,
			});
		});
	}

	/**
	 * Awaitable enqueue for callers that must know the intent landed on disk
	 * (seed, unload flush). Still schedules a debounced network tick.
	 */
	async enqueueDurable(rawPath: string, op: "put" | "delete"): Promise<void> {
		if (this.isSuspended()) {
			this.logger.warn("enqueue.skipped", {
				path: rawPath,
				operation: op,
				reason: "suspended",
			});
			throw new Error("Sync is suspended while the connection is changing");
		}
		const path = canonicalizeSyncPath(rawPath);
		const baseRevision = op === "delete" ? await this.getRevision() : undefined;
		this.logger.debug("enqueue.started", {
			path,
			operation: op,
			baseRevision,
		});
		this.pendingOutboxPaths.add(path);
		this.enqueueCounts.set(path, (this.enqueueCounts.get(path) ?? 0) + 1);
		const intent: OutboxOp = {
			op,
			path,
			ts: Date.now(),
			baseRevision,
		};
		const persistence = enqueueOutbox(
			this.fs,
			this.outboxPath,
			intent,
			this.logger,
		).finally(async () => {
				const remaining = (this.enqueueCounts.get(path) ?? 1) - 1;
				if (remaining > 0) this.enqueueCounts.set(path, remaining);
				else this.enqueueCounts.delete(path);
				this.enqueueInFlight.delete(persistence);
				await this.refreshPending(path);
			});
		this.enqueueInFlight.add(persistence);
		try {
			await persistence;
			this.notifyQueueChanged();
			this.failedEnqueues.delete(path);
			this.logger.info("enqueue.persisted", {
				path,
				operation: op,
				pendingWrites: this.enqueueInFlight.size,
			});
		} catch (error) {
			const enqueueError =
				error instanceof Error ? error : new Error(String(error));
			this.failedEnqueues.set(path, intent);
			this.pendingOutboxPaths.add(path);
			this.onEnqueueFailure?.(enqueueError, intent);
			this.logger.error("enqueue.failed", {
				path,
				operation: op,
				error: enqueueError,
			});
			this.scheduleNetworkTick();
			throw enqueueError;
		}
		this.scheduleNetworkTick();
	}

	private scheduleNetworkTick(): void {
		this.logger.debug("tick.scheduled");
		this.debouncer.trigger("tick", () => this.tick().then(() => undefined));
	}

	/**
	 * Wait for in-flight durable enqueues and run any debounced network tick.
	 * Used before seed/unload so nothing sits only in memory.
	 */
	async flush(): Promise<void> {
		this.logger.info("flush.started", {
			pendingWrites: this.enqueueInFlight.size,
			failedEnqueues: this.failedEnqueues.size,
		});
		await Promise.allSettled([...this.enqueueInFlight]);
		await this.debouncer.flush();
		if (this.tickInFlight) await this.tickInFlight;
		if (this.failedEnqueues.size > 0) {
			await this.tick();
		}
		if (this.failedEnqueues.size > 0) {
			this.logger.error("flush.failed", {
				failedEnqueues: this.failedEnqueues.size,
			});
			throw new Error(
				`${this.failedEnqueues.size} local operation(s) could not be persisted`,
			);
		}
		this.logger.info("flush.completed");
	}

	/**
	 * Stop scheduled work and wait for any already-running persistence/tick
	 * (including its Vault mutation) to settle. Used before changing the
	 * engine's server identity.
	 */
	async quiesce(): Promise<void> {
		this.logger.info("quiesce.started", {
			pendingWrites: this.enqueueInFlight.size,
			tickInFlight: this.tickInFlight !== null,
		});
		this.debouncer.cancel("tick");
		await Promise.allSettled([...this.enqueueInFlight]);
		if (this.tickInFlight) await this.tickInFlight;
		this.logger.info("quiesce.completed");
	}

	private async refreshPending(path: string): Promise<void> {
		if ((this.enqueueCounts.get(path) ?? 0) > 0) {
			this.pendingOutboxPaths.add(path);
			return;
		}
		const outboxOps = await listOutbox(
			this.fs,
			this.outboxPath,
			this.logger,
		);
		if (outboxOps.some((op) => op.path === path)) {
			this.pendingOutboxPaths.add(path);
		} else {
			this.pendingOutboxPaths.delete(path);
		}
	}

	private async rebuildPendingPaths(): Promise<void> {
		this.pendingOutboxPaths.clear();
		for (const op of await listOutbox(
			this.fs,
			this.outboxPath,
			this.logger,
		)) {
			this.pendingOutboxPaths.add(op.path);
		}
		for (const path of this.enqueueCounts.keys()) {
			this.pendingOutboxPaths.add(path);
		}
		for (const path of this.failedEnqueues.keys()) {
			this.pendingOutboxPaths.add(path);
		}
	}

	private async retryFailedEnqueues(): Promise<void> {
		for (const [path, op] of [...this.failedEnqueues]) {
			this.logger.warn("enqueue.retrying", {
				path,
				operation: op.op,
			});
			await enqueueOutbox(this.fs, this.outboxPath, op, this.logger);
			this.notifyQueueChanged();
			this.failedEnqueues.delete(path);
			this.logger.info("enqueue.retry_succeeded", {
				path,
				operation: op.op,
			});
		}
	}

	/** Enqueue a put for every file in the vault (initial bootstrap / B1). */
	async seedFromVault(
		listFiles: () => Promise<string[]> | string[],
	): Promise<void> {
		await this.ensureHydrated();
		const files = await listFiles();
		this.logger.info("seed.started", { fileCount: files.length });
		for (const path of files) {
			this.logger.debug("seed.file", { path });
			await this.enqueueDurable(path, "put");
		}
		this.logger.info("seed.enqueued", { fileCount: files.length });
	}

	/**
	 * One sync round: drain the outbox out, then pull and apply the inbox.
	 * Concurrent callers share the same in-flight promise (single-flight).
	 */
	async tick(options: SyncTickOptions = {}): Promise<SyncTickResult> {
		if (this.tickInFlight) {
			this.logger.debug("tick.joined_existing");
			return this.tickInFlight;
		}
		this.logger.debug("tick.started");
		this.tickInFlight = this.runTick(options)
			.then((result) => {
				try {
					this.onTickCompleted?.(result);
				} catch (error) {
					this.logger.warn("tick.completion_callback_failed", { error });
				}
				return result;
			})
			.finally(() => {
				this.tickInFlight = null;
			});
		return this.tickInFlight;
	}

	isTickActive(): boolean {
		return this.tickInFlight !== null;
	}

	private async ensureHydrated(): Promise<void> {
		if (!this.hydrated) {
			await this.hydrate();
		}
	}

	private async runTick(options: SyncTickOptions): Promise<SyncTickResult> {
		const startedAt = Date.now();
		let pushed = 0;
		let applied = 0;
		let deadLettered = 0;
		try {
			if (this.isSuspended()) {
				const result: SyncTickResult = {
					ok: false,
					error: "Sync is suspended while the connection is changing",
					pushed,
					applied,
					deadLettered,
				};
				this.logger.warn("tick.suspended", {
					durationMs: Date.now() - startedAt,
				});
				return result;
			}
			await this.retryFailedEnqueues();
			await this.ensureHydrated();
			while (true) {
				const drainResult = await this.drainOutboxOnce();
				pushed += drainResult.pushed;
				deadLettered += drainResult.deadLettered;
				await Promise.all([...this.enqueueInFlight]);
				if (
					(await listOutbox(
						this.fs,
						this.outboxPath,
						this.logger,
					)).length === 0
				) {
					break;
				}
			}
			await this.rebuildPendingPaths();
			applied = await this.applyRemoteInbox(options);
			if (deadLettered > 0) {
				const result: SyncTickResult = {
					ok: false,
					error: `${deadLettered} operation(s) require attention`,
					pushed,
					applied,
					deadLettered,
				};
				this.logger.warn("tick.completed_with_dead_letters", {
					pushed,
					applied,
					deadLettered,
					durationMs: Date.now() - startedAt,
				});
				return result;
			}
			const result: SyncTickResult = {
				ok: true,
				pushed,
				applied,
				deadLettered,
			};
			this.logger.info("tick.completed", {
				pushed,
				applied,
				deadLettered,
				durationMs: Date.now() - startedAt,
			});
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.logger.error("tick.failed", {
				error,
				pushed,
				applied,
				deadLettered,
				durationMs: Date.now() - startedAt,
			});
			return { ok: false, error: message, pushed, applied, deadLettered };
		}
	}

	private async drainOutboxOnce(): Promise<{
		pushed: number;
		deadLettered: number;
	}> {
		await Promise.all([...this.enqueueInFlight]);
		this.logger.debug("outbox.drain_started");
		const processedPaths = new Set<string>();
		let pushed = 0;
		let deadLettered = 0;

		await drainOutbox(this.fs, this.outboxPath, async (op) => {
			this.logger.debug("outbox.operation_started", {
				path: op.path,
				operation: op.op,
				baseRevision: op.baseRevision,
			});
			if (op.op === "put" && !(await this.fs.exists(op.path))) {
				processedPaths.add(op.path);
				this.logger.warn("outbox.put_skipped", {
					path: op.path,
					reason: "local_file_missing",
				});
				return;
			}

			try {
				if (op.op === "put") {
					await this.pushPut(op.path);
				} else {
					await this.pushDelete(op.path, op.baseRevision);
				}
				processedPaths.add(op.path);
				pushed++;
				this.logger.info("outbox.operation_pushed", {
					path: op.path,
					operation: op.op,
				});
			} catch (error) {
				if (this.isPermanentFailure(error)) {
					await this.deadLetter(op, error);
					deadLettered++;
					processedPaths.add(op.path);
					this.logger.error("outbox.operation_dead_lettered", {
						path: op.path,
						operation: op.op,
						error,
					});
					return;
				}
				this.logger.error("outbox.operation_failed", {
					path: op.path,
					operation: op.op,
					error,
				});
				throw error;
			}
		}, this.logger, () => this.notifyQueueChanged());

		for (const path of processedPaths) {
			await this.refreshPending(path);
		}
		this.logger.debug("outbox.drain_completed", { pushed, deadLettered });
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
		this.assertActive();
		const body = await this.fs.readBinary(path);
		this.assertActive();
		this.logger.debug("put.uploading", {
			path,
			bytes: body.byteLength,
		});
		const result = await this.transport.upload(path, body);
		this.logger.info("put.uploaded", {
			path,
			bytes: body.byteLength,
			revision: result.revision,
		});
		return result;
	}

	private async pushDelete(
		path: string,
		baseRevision?: number,
	): Promise<{ revision: number }> {
		this.assertActive();
		this.logger.debug("delete.uploading", { path, baseRevision });
		const result = await this.transport.deleteRemote(path, baseRevision);
		this.logger.info("delete.uploaded", {
			path,
			baseRevision,
			revision: result.revision,
		});
		return result;
	}

	private async applyRemoteInbox(options: SyncTickOptions): Promise<number> {
		this.assertActive();
		const rev = await this.getRevision();
		this.logger.debug("inbox.fetching", { revision: rev });
		this.notifyTickPhase(options.onInboxRequestStarted, "started");
		let ops: InboxOp[];
		try {
			ops = await this.transport.fetchInbox(rev);
		} finally {
			this.notifyTickPhase(options.onInboxRequestFinished, "finished");
		}
		this.logger.info("inbox.fetched", {
			revision: rev,
			operationCount: ops.length,
		});
		this.assertActive();
		await appendInbox(
			this.fs,
			this.inboxPath,
			ops,
			this.logger,
			() => this.notifyQueueChanged(),
		);

		let applied = 0;
		await applyInbox(this.fs, this.inboxPath, {
			applyPut: async (path) => {
				this.assertActive();
				this.logger.debug("inbox.put_applying", { path });
				await this.applyRemotePut(path);
				applied++;
				this.logger.info("inbox.put_applied", { path });
			},
			applyDelete: async (path) => {
				this.assertActive();
				this.logger.debug("inbox.delete_applying", { path });
				await this.applyRemoteDelete(path);
				applied++;
				this.logger.info("inbox.delete_applied", { path });
			},
			getRevision: () => this.getRevision(),
			setRevision: (newRev) => {
				this.assertActive();
				return this.setRevision(newRev);
			},
			shouldDeferApply: (op) => {
				const deferred = [...this.pendingOutboxPaths].some((path) =>
					pathsStructurallyConflict(path, op.path),
				);
				if (deferred) {
					this.logger.debug("inbox.operation_deferred", {
						path: op.path,
						operation: op.op,
					});
				}
				return deferred;
			},
			logger: this.logger,
			onQueueChanged: () => this.notifyQueueChanged(),
		});
		return applied;
	}

	private notifyQueueChanged(): void {
		try {
			this.onQueueChanged?.();
		} catch (error) {
			this.logger.warn("queue.change_callback_failed", { error });
		}
	}

	private notifyTickPhase(
		callback: (() => void) | undefined,
		phase: "started" | "finished",
	): void {
		try {
			callback?.();
		} catch (error) {
			this.logger.warn("tick.phase_callback_failed", { phase, error });
		}
	}

	private assertActive(): void {
		if (this.isSuspended()) {
			throw new Error("Sync is suspended until Obsidian reloads");
		}
	}

	private async applyRemotePut(path: string): Promise<void> {
		let data: ArrayBuffer;
		try {
			data = await this.transport.download(path);
		} catch (error) {
			this.assertActive();
			// Stale put raced a later delete: treat as success so the inbox
			// can advance; a later tombstone still applies normally.
			if (
				error instanceof Error &&
				(error.name === "RemoteFileNotFoundError" ||
					/\b404\b/.test(error.message))
			) {
				this.logger.warn("inbox.put_skipped", {
					path,
					reason: "remote_file_missing",
				});
				return;
			}
			throw error;
		}
		this.assertActive();
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

function pathsStructurallyConflict(left: string, right: string): boolean {
	return (
		left === right ||
		left.startsWith(`${right}/`) ||
		right.startsWith(`${left}/`)
	);
}
