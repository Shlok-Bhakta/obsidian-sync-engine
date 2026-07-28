import { Debouncer } from "./debounce";
import type { SyncFs } from "./fs";
import { appendInbox, applyInbox, type InboxOp } from "./inbox";
import {
	drain as drainOutbox,
	enqueue as enqueueOutbox,
	list as listOutbox,
} from "./outbox";

export type SyncTransport = {
	upload(
		path: string,
		body: ArrayBuffer | string,
	): Promise<{ revision: number }>;
	deleteRemote(path: string): Promise<{ revision: number }>;
	download(path: string): Promise<ArrayBuffer>;
	fetchInbox(rev: number): Promise<InboxOp[]>; // or raw JSONL parse
};

export type VaultBlobFs = SyncFs & {
	readBinary?(path: string): Promise<ArrayBuffer>;
	writeBinary?(path: string, data: ArrayBuffer): Promise<void>;
	remove?(path: string): Promise<void>;
	listAllFiles?(): Promise<string[]>;
};

export type SyncEngineOptions = {
	fs: VaultBlobFs;
	transport: SyncTransport;
	outboxPath: string;
	inboxPath: string;
	getRevision: () => number | Promise<number>;
	setRevision: (rev: number) => void | Promise<void>;
	/** Per-path quiet period before an enqueued change is written to the outbox. Default 1000ms. */
	debounceMs?: number;
};

const DEFAULT_DEBOUNCE_MS = 1000;

/**
 * Minimal two-way sync engine: local edits flow out through the outbox,
 * remote edits flow in through the inbox. No IndexedDB, no background
 * scheduling beyond what the caller drives via `tick()`.
 *
 * The revision cursor is a single source of truth for "what have we caught
 * up to" and only ever moves in one place: `applyInbox`'s `setRevision`
 * call, driven from `applyRemoteInbox` below. Pushing a local change via
 * `upload`/`deleteRemote` does NOT move the cursor by itself — the server is
 * expected to hand that same change back to us through `fetchInbox` (a
 * "self-echo"), and it's only once *that* line is processed that the cursor
 * advances past it. `echoRevs` lets us recognize our own echoed lines so we
 * skip re-applying them to the vault while still letting them drive the
 * cursor forward.
 */
export class SyncEngine {
	private readonly fs: VaultBlobFs;
	private readonly transport: SyncTransport;
	private readonly outboxPath: string;
	private readonly inboxPath: string;
	private readonly getRevision: () => number | Promise<number>;
	private readonly setRevision: (rev: number) => void | Promise<void>;
	private readonly debouncer: Debouncer<string>;

	/**
	 * Paths with a local change that's been enqueued (debouncing or already in
	 * the outbox) but not yet confirmed pushed. Used to skip clobbering local
	 * edits with an inbound inbox line for the same path. Kept accurate via
	 * `refreshPending`, which recomputes membership from the debouncer and
	 * outbox rather than trusting ad hoc add/delete calls.
	 */
	private readonly pendingOutboxPaths = new Set<string>();

	/** Revisions returned by our own `upload`/`deleteRemote` calls, awaiting self-echo through the inbox. */
	private readonly echoRevs = new Set<number>();

	/** Most recently requested op per path, for paths currently debouncing (not yet written to the outbox). Read by `flush`. */
	private readonly pendingOps = new Map<string, "put" | "delete">();

	constructor(options: SyncEngineOptions) {
		this.fs = options.fs;
		this.transport = options.transport;
		this.outboxPath = options.outboxPath;
		this.inboxPath = options.inboxPath;
		this.getRevision = options.getRevision;
		this.setRevision = options.setRevision;
		this.debouncer = new Debouncer(options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
	}

	/** Enqueue a local write, debounced per-path. */
	enqueuePut(path: string): void {
		this.scheduleEnqueue(path, "put");
	}

	/** Enqueue a local delete, debounced per-path. */
	enqueueDelete(path: string): void {
		this.scheduleEnqueue(path, "delete");
	}

	private scheduleEnqueue(path: string, op: "put" | "delete"): void {
		this.pendingOps.set(path, op);
		this.debouncer.trigger(path, () => this.flushOne(path));
		void this.refreshPending(path);
	}

	private async flushOne(path: string): Promise<void> {
		const op = this.pendingOps.get(path);
		if (op === undefined) {
			return;
		}
		this.pendingOps.delete(path);
		await enqueueOutbox(this.fs, this.outboxPath, { op, path, ts: Date.now() });
		await this.refreshPending(path);
	}

	/**
	 * Immediately writes every debounced-but-not-yet-enqueued local change to
	 * the outbox, as if each one's quiet period had already elapsed. Used
	 * before a manual seed + tick so bulk-enqueued puts aren't left waiting
	 * out the debounce window.
	 */
	async flush(): Promise<void> {
		await this.debouncer.flush();
	}

	/**
	 * Recompute whether `path` should be treated as "locally pending" — i.e.
	 * still debouncing, or already sitting in the outbox. Call after any
	 * change that could affect either of those (enqueue, drain).
	 */
	private async refreshPending(path: string): Promise<void> {
		if (this.debouncer.isPending(path)) {
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

	/** Enqueue a put for every file in the vault (initial bootstrap / B1). */
	async seedFromVault(
		listFiles: () => Promise<string[]> | string[],
	): Promise<void> {
		const files = await listFiles();
		for (const path of files) {
			if (this.pendingOutboxPaths.has(path)) {
				continue;
			}
			this.enqueuePut(path);
		}
	}

	/** One sync round: drain the outbox out, then pull and apply the inbox. */
	async tick(): Promise<void> {
		await this.drainOutboxOnce();
		await this.applyRemoteInbox();
	}

	private async drainOutboxOnce(): Promise<void> {
		const processedPaths = new Set<string>();
		await drainOutbox(this.fs, this.outboxPath, async (op) => {
			if (op.op === "put" && !(await this.fs.exists(op.path))) {
				// The file was deleted locally before this put could be pushed
				// (e.g. a delete queued right behind it). There's nothing to
				// upload — drop the line without erroring so the delete behind
				// it isn't blocked from draining on the same tick.
				processedPaths.add(op.path);
				return;
			}

			const result =
				op.op === "put"
					? await this.pushPut(op.path)
					: await this.pushDelete(op.path);

			// Do NOT move the revision cursor here — only applyInbox does that,
			// once this same change comes back to us through fetchInbox.
			this.echoRevs.add(result.revision);
			processedPaths.add(op.path);
		});

		// The outbox file only reflects post-drain state once `drainOutbox`
		// (and its internal mutex) has fully returned, so recompute pending
		// status for touched paths now rather than inside the handler above.
		for (const path of processedPaths) {
			await this.refreshPending(path);
		}
	}

	private async pushPut(path: string): Promise<{ revision: number }> {
		const body = this.fs.readBinary
			? await this.fs.readBinary(path)
			: await this.fs.read(path);
		return this.transport.upload(path, body);
	}

	private async pushDelete(path: string): Promise<{ revision: number }> {
		return this.transport.deleteRemote(path);
	}

	private async applyRemoteInbox(): Promise<void> {
		const rev = await this.getRevision();
		const ops = await this.transport.fetchInbox(rev);
		await appendInbox(this.fs, this.inboxPath, ops);

		await applyInbox(this.fs, this.inboxPath, {
			applyPut: (path) => this.applyRemotePut(path),
			applyDelete: (path) => this.applyRemoteDelete(path),
			getRevision: () => this.getRevision(),
			setRevision: (newRev) => this.setRevision(newRev),
			shouldSkipApply: (op) => {
				// Our own change echoed back: consume it from the set so a
				// legitimately reused revision number later isn't misread.
				if (this.echoRevs.delete(op.rev)) {
					return true;
				}
				return this.pendingOutboxPaths.has(op.path);
			},
		});
	}

	private async applyRemotePut(path: string): Promise<void> {
		let data: ArrayBuffer;
		try {
			data = await this.transport.download(path);
		} catch (error) {
			// Path was deleted (or never existed) by the time we went to fetch
			// it. Treat as a successful no-op so applyInbox can advance past
			// this put; a later delete line (if any) still applies normally.
			if (
				error instanceof Error &&
				(error.name === "RemoteFileNotFoundError" ||
					/\b404\b/.test(error.message))
			) {
				return;
			}
			throw error;
		}
		if (this.fs.writeBinary) {
			await this.fs.writeBinary(path, data);
		} else {
			await this.fs.write(path, new TextDecoder().decode(data));
		}
	}

	private async applyRemoteDelete(path: string): Promise<void> {
		if (!this.fs.remove) {
			throw new Error(
				`Cannot apply remote delete for "${path}": vault fs has no remove()`,
			);
		}
		await this.fs.remove(path);
	}
}
