import { Debouncer } from "./debounce";
import type { SyncFs } from "./fs";
import { applyInbox, readInbox, writeInbox, type InboxOp } from "./inbox";
import { drain as drainOutbox, enqueue as enqueueOutbox } from "./outbox";

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
	 * edits with an inbound inbox line for the same path.
	 */
	private readonly pendingOutboxPaths = new Set<string>();

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
		this.pendingOutboxPaths.add(path);
		this.debouncer.trigger(path, () => {
			void enqueueOutbox(this.fs, this.outboxPath, {
				op,
				path,
				ts: Date.now(),
			});
		});
	}

	/** Enqueue a put for every file in the vault (initial bootstrap / B1). */
	async seedFromVault(
		listFiles: () => Promise<string[]> | string[],
	): Promise<void> {
		const files = await listFiles();
		for (const path of files) {
			this.enqueuePut(path);
		}
	}

	/** One sync round: drain the outbox out, then pull and apply the inbox. */
	async tick(): Promise<void> {
		await this.drainOutboxOnce();
		await this.applyRemoteInbox();
	}

	private async drainOutboxOnce(): Promise<void> {
		await drainOutbox(this.fs, this.outboxPath, async (op) => {
			const result =
				op.op === "put"
					? await this.pushPut(op.path)
					: await this.pushDelete(op.path);

			const current = await this.getRevision();
			await this.setRevision(Math.max(current, result.revision));
			this.pendingOutboxPaths.delete(op.path);
		});
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
		if (ops.length > 0) {
			const existing = await readInbox(this.fs, this.inboxPath);
			await writeInbox(this.fs, this.inboxPath, [...existing, ...ops]);
		}

		await applyInbox(this.fs, this.inboxPath, {
			applyPut: (path) => this.applyRemotePut(path),
			applyDelete: (path) => this.applyRemoteDelete(path),
			getRevision: () => this.getRevision(),
			setRevision: (newRev) => this.setRevision(newRev),
			shouldSkipPath: (path) => this.pendingOutboxPaths.has(path),
		});
	}

	private async applyRemotePut(path: string): Promise<void> {
		const data = await this.transport.download(path);
		if (this.fs.writeBinary) {
			await this.fs.writeBinary(path, data);
		} else {
			await this.fs.write(path, new TextDecoder().decode(data));
		}
	}

	private async applyRemoteDelete(path: string): Promise<void> {
		if (this.fs.remove) {
			await this.fs.remove(path);
		}
	}
}
