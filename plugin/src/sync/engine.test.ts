import { describe, expect, jest, test } from "bun:test";
import type { InboxOp } from "./inbox";
import { readInbox } from "./inbox";
import { enqueue as enqueueOutbox, list as listOutbox } from "./outbox";
import { SyncEngine, type SyncTransport, type VaultBlobFs } from "./engine";

const OUTBOX = "outbox.jsonl";
const INBOX = "inbox.jsonl";

/** In-memory vault fs with the binary/remove/list extensions SyncEngine wants. */
class MemoryVaultFs implements VaultBlobFs {
	private readonly files = new Map<string, string>();

	async read(path: string): Promise<string> {
		const data = this.files.get(path);
		if (data === undefined) {
			throw new Error(`ENOENT: no such file: ${path}`);
		}
		return data;
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}

	async exists(path: string): Promise<boolean> {
		return this.files.has(path);
	}

	async mkdir(): Promise<void> {}

	async readBinary(path: string): Promise<ArrayBuffer> {
		return new TextEncoder().encode(await this.read(path)).buffer;
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.files.set(path, new TextDecoder().decode(data));
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}

	async listAllFiles(): Promise<string[]> {
		return [...this.files.keys()];
	}
}

/**
 * Fake transport modeling a shared server revision log: every `upload` /
 * `deleteRemote` call (ours or, via `simulateRemoteOp`, another client's)
 * appends to the same `log` that `fetchInbox` reads from — including our
 * own pushes, so tests can exercise self-echo the way the real server does.
 */
class FakeTransport implements SyncTransport {
	revision = 0;
	readonly remoteFiles = new Map<string, string>();
	readonly log: InboxOp[] = [];
	readonly uploads: { path: string; body: ArrayBuffer | string }[] = [];
	readonly deletes: string[] = [];
	readonly fetchInboxCalls: number[] = [];
	readonly calls: string[] = [];

	async upload(
		path: string,
		body: ArrayBuffer | string,
	): Promise<{ revision: number }> {
		this.calls.push("upload");
		this.revision++;
		this.uploads.push({ path, body });
		this.remoteFiles.set(
			path,
			typeof body === "string" ? body : new TextDecoder().decode(body),
		);
		this.log.push({ rev: this.revision, op: "put", path });
		return { revision: this.revision };
	}

	async deleteRemote(path: string): Promise<{ revision: number }> {
		this.calls.push("delete");
		this.revision++;
		this.deletes.push(path);
		this.remoteFiles.delete(path);
		this.log.push({ rev: this.revision, op: "delete", path });
		return { revision: this.revision };
	}

	async download(path: string): Promise<ArrayBuffer> {
		this.calls.push("download");
		const content = this.remoteFiles.get(path) ?? "";
		return new TextEncoder().encode(content).buffer;
	}

	async fetchInbox(rev: number): Promise<InboxOp[]> {
		this.calls.push("fetchInbox");
		this.fetchInboxCalls.push(rev);
		return this.log.filter((op) => op.rev > rev);
	}

	/** Simulate some other client's change landing in the shared log. */
	simulateRemoteOp(op: "put" | "delete", path: string, content = ""): number {
		this.revision++;
		if (op === "put") {
			this.remoteFiles.set(path, content);
		} else {
			this.remoteFiles.delete(path);
		}
		this.log.push({ rev: this.revision, op, path });
		return this.revision;
	}
}

function makeRevisionStore(initial = 0) {
	let revision = initial;
	return {
		get: () => revision,
		set: (rev: number) => {
			revision = rev;
		},
	};
}

/** Flush pending microtask chains (e.g. a fire-and-forget debounced enqueue). */
async function flushMicrotasks(times = 20): Promise<void> {
	for (let i = 0; i < times; i++) {
		await Promise.resolve();
	}
}

describe("SyncEngine", () => {
	test("tick drains the outbox before applying the inbox", async () => {
		const fs = new MemoryVaultFs();
		await fs.write("local.md", "hello world");
		const transport = new FakeTransport();
		// Another client's change, already in the shared log before our tick.
		transport.simulateRemoteOp("put", "remote.md", "from the server");
		const revision = makeRevisionStore(0);

		await enqueueOutbox(fs, OUTBOX, {
			op: "put",
			path: "local.md",
			ts: 1,
		});

		const engine = new SyncEngine({
			fs,
			transport,
			outboxPath: OUTBOX,
			inboxPath: INBOX,
			getRevision: revision.get,
			setRevision: revision.set,
			debounceMs: 0,
		});

		await engine.tick();

		expect(transport.calls).toEqual(["upload", "fetchInbox", "download"]);
		expect(transport.uploads.length).toBe(1);
		expect(transport.uploads[0]?.path).toBe("local.md");
		expect(
			new TextDecoder().decode(transport.uploads[0]?.body as ArrayBuffer),
		).toBe("hello world");
		expect(await listOutbox(fs, OUTBOX)).toEqual([]);
		expect(await fs.read("remote.md")).toBe("from the server");
		expect(await readInbox(fs, INBOX)).toEqual([]);
		// remote.md (rev 1) was applied for real; local.md's echo (rev 2) was
		// recognized and skipped, but both still drove the cursor to 2.
		expect(revision.get()).toBe(2);
	});

	test("uploading alone does not move the revision cursor — only applying the echoed inbox line does", async () => {
		const fs = new MemoryVaultFs();
		await fs.write("a.md", "content");
		const transport = new FakeTransport();
		const revision = makeRevisionStore(0);

		await enqueueOutbox(fs, OUTBOX, { op: "put", path: "a.md", ts: 1 });

		const engine = new SyncEngine({
			fs,
			transport,
			outboxPath: OUTBOX,
			inboxPath: INBOX,
			getRevision: revision.get,
			setRevision: revision.set,
			debounceMs: 0,
		});

		// Simulate the echo not having arrived yet (e.g. network lag): fetchInbox
		// returns nothing even though the transport's own revision moved.
		transport.fetchInbox = async () => [];

		await engine.tick();

		expect(transport.revision).toBe(1); // the push did happen server-side...
		expect(revision.get()).toBe(0); // ...but our cursor hasn't moved.
	});

	test("self-echo: applying our own echoed line advances the cursor without re-downloading the file", async () => {
		const fs = new MemoryVaultFs();
		await fs.write("a.md", "content");
		const transport = new FakeTransport();
		const revision = makeRevisionStore(0);

		await enqueueOutbox(fs, OUTBOX, { op: "put", path: "a.md", ts: 1 });

		const engine = new SyncEngine({
			fs,
			transport,
			outboxPath: OUTBOX,
			inboxPath: INBOX,
			getRevision: revision.get,
			setRevision: revision.set,
			debounceMs: 0,
		});

		await engine.tick();

		// The upload's own log entry comes back through fetchInbox and is
		// recognized via echoRevs, so the cursor still advances...
		expect(revision.get()).toBe(1);
		expect(transport.fetchInboxCalls).toEqual([0]);
		expect(await readInbox(fs, INBOX)).toEqual([]);
		// ...but the content is never re-downloaded/re-applied for our own echo.
		expect(transport.calls).toEqual(["upload", "fetchInbox"]);
	});

	test("enqueuePut debounces rapid calls into a single outbox entry", async () => {
		jest.useFakeTimers();
		try {
			const fs = new MemoryVaultFs();
			await fs.write("a.md", "v1");
			const transport = new FakeTransport();
			const revision = makeRevisionStore(0);
			const engine = new SyncEngine({
				fs,
				transport,
				outboxPath: OUTBOX,
				inboxPath: INBOX,
				getRevision: revision.get,
				setRevision: revision.set,
			});

			engine.enqueuePut("a.md");
			jest.advanceTimersByTime(400);
			engine.enqueuePut("a.md");
			jest.advanceTimersByTime(400);
			engine.enqueuePut("a.md");

			jest.advanceTimersByTime(999);
			await flushMicrotasks();
			expect(await listOutbox(fs, OUTBOX)).toEqual([]);

			jest.advanceTimersByTime(1);
			await flushMicrotasks();

			const ops = await listOutbox(fs, OUTBOX);
			expect(ops.length).toBe(1);
			expect(ops[0]).toMatchObject({ op: "put", path: "a.md" });
		} finally {
			jest.useRealTimers();
		}
	});

	test("seedFromVault enqueues a put for every file", async () => {
		jest.useFakeTimers();
		try {
			const fs = new MemoryVaultFs();
			await fs.write("a.md", "a");
			await fs.write("b.md", "b");
			const transport = new FakeTransport();
			const revision = makeRevisionStore(0);
			const engine = new SyncEngine({
				fs,
				transport,
				outboxPath: OUTBOX,
				inboxPath: INBOX,
				getRevision: revision.get,
				setRevision: revision.set,
				debounceMs: 0,
			});

			await engine.seedFromVault(() => fs.listAllFiles());
			jest.advanceTimersByTime(0);
			await flushMicrotasks();

			const ops = await listOutbox(fs, OUTBOX);
			expect(ops.map((op) => op.path).sort()).toEqual(["a.md", "b.md"]);
			expect(ops.every((op) => op.op === "put")).toBe(true);
		} finally {
			jest.useRealTimers();
		}
	});

	test("seedFromVault skips a path already pending, so it doesn't reset that path's debounce timer", async () => {
		jest.useFakeTimers();
		try {
			const fs = new MemoryVaultFs();
			await fs.write("a.md", "a");
			await fs.write("b.md", "b");
			const transport = new FakeTransport();
			const revision = makeRevisionStore(0);
			const engine = new SyncEngine({
				fs,
				transport,
				outboxPath: OUTBOX,
				inboxPath: INBOX,
				getRevision: revision.get,
				setRevision: revision.set,
				debounceMs: 1000,
			});

			// a.md already has a local edit debouncing, started at t=0.
			engine.enqueuePut("a.md");
			await flushMicrotasks();

			jest.advanceTimersByTime(900); // t=900, not fired yet.

			// If seedFromVault didn't skip already-pending paths, this would
			// call enqueuePut("a.md") again and push its deadline out to t=1900.
			await engine.seedFromVault(() => fs.listAllFiles());
			await flushMicrotasks();

			jest.advanceTimersByTime(100); // t=1000: a.md's original timer, if untouched, fires now.
			await flushMicrotasks();

			const ops = await listOutbox(fs, OUTBOX);
			// a.md's original debounce fired on schedule (not reset by seeding);
			// b.md was newly seeded and is still debouncing at t=1000.
			expect(ops.map((op) => op.path)).toEqual(["a.md"]);
		} finally {
			jest.useRealTimers();
		}
	});

	test("pendingOutboxPaths stays true after draining an older put if a newer edit is still debouncing", async () => {
		jest.useFakeTimers();
		try {
			const fs = new MemoryVaultFs();
			await fs.write("a.md", "local-v2");
			const transport = new FakeTransport();
			const revision = makeRevisionStore(0);
			const engine = new SyncEngine({
				fs,
				transport,
				outboxPath: OUTBOX,
				inboxPath: INBOX,
				getRevision: revision.get,
				setRevision: revision.set,
				debounceMs: 1000,
			});

			// An older put for a.md is already sitting in the outbox, as if
			// flushed earlier.
			await enqueueOutbox(fs, OUTBOX, { op: "put", path: "a.md", ts: 1 });
			// A newer local edit for the same path starts debouncing — it has
			// NOT reached the outbox yet.
			engine.enqueuePut("a.md");
			await flushMicrotasks();

			// A concurrent remote push for the same path lands in the shared log.
			transport.simulateRemoteOp("put", "a.md", "remote-should-not-land");

			// Drains the older queued put (the debounced edit still hasn't fired).
			await engine.tick();

			// The debounce timer for the newer edit is still pending, so a.md
			// must still be treated as locally-pending: both the concurrent
			// remote write AND our own echo for this path are skipped, and the
			// local (unsynced) content is left alone.
			expect(await fs.read("a.md")).toBe("local-v2");

			jest.advanceTimersByTime(1000);
			await flushMicrotasks();
		} finally {
			jest.useRealTimers();
		}
	});

	test("flush writes debounced puts to the outbox immediately, without waiting out the debounce window", async () => {
		jest.useFakeTimers();
		try {
			const fs = new MemoryVaultFs();
			await fs.write("a.md", "a");
			await fs.write("b.md", "b");
			const transport = new FakeTransport();
			const revision = makeRevisionStore(0);
			const engine = new SyncEngine({
				fs,
				transport,
				outboxPath: OUTBOX,
				inboxPath: INBOX,
				getRevision: revision.get,
				setRevision: revision.set,
				debounceMs: 1000,
			});

			engine.enqueuePut("a.md");
			engine.enqueuePut("b.md");

			// Nothing should be in the outbox yet — both are still debouncing.
			expect(await listOutbox(fs, OUTBOX)).toEqual([]);

			await engine.flush();

			const ops = await listOutbox(fs, OUTBOX);
			expect(ops.map((op) => op.path).sort()).toEqual(["a.md", "b.md"]);

			// The original timers must be defused, not just raced ahead of.
			jest.advanceTimersByTime(5000);
			await flushMicrotasks();
			expect((await listOutbox(fs, OUTBOX)).length).toBe(2);
		} finally {
			jest.useRealTimers();
		}
	});

	test("seedFromVault + flush + tick pushes every seeded file without waiting on the debounce timer", async () => {
		const fs = new MemoryVaultFs();
		await fs.write("a.md", "a");
		await fs.write("b.md", "b");
		const transport = new FakeTransport();
		const revision = makeRevisionStore(0);
		const engine = new SyncEngine({
			fs,
			transport,
			outboxPath: OUTBOX,
			inboxPath: INBOX,
			getRevision: revision.get,
			setRevision: revision.set,
			debounceMs: 1000,
		});

		await engine.seedFromVault(() => fs.listAllFiles());
		await engine.flush();
		await engine.tick();

		expect(transport.uploads.map((u) => u.path).sort()).toEqual([
			"a.md",
			"b.md",
		]);
		expect(await listOutbox(fs, OUTBOX)).toEqual([]);
	});

	test("draining a put for a file that's been deleted locally skips the upload without erroring", async () => {
		const fs = new MemoryVaultFs();
		await fs.write("a.md", "content");
		const transport = new FakeTransport();
		const revision = makeRevisionStore(0);

		await enqueueOutbox(fs, OUTBOX, { op: "put", path: "a.md", ts: 1 });
		await fs.remove("a.md"); // deleted locally before the put could be pushed

		const engine = new SyncEngine({
			fs,
			transport,
			outboxPath: OUTBOX,
			inboxPath: INBOX,
			getRevision: revision.get,
			setRevision: revision.set,
			debounceMs: 0,
		});

		await engine.tick();

		expect(transport.uploads).toEqual([]);
		expect(transport.calls).not.toContain("upload");
		expect(await listOutbox(fs, OUTBOX)).toEqual([]);
	});

	test("a put for a locally-deleted file is dropped without blocking the delete queued behind it", async () => {
		const fs = new MemoryVaultFs();
		await fs.write("a.md", "content");
		const transport = new FakeTransport();
		const revision = makeRevisionStore(0);

		await enqueueOutbox(fs, OUTBOX, { op: "put", path: "a.md", ts: 1 });
		await fs.remove("a.md");
		await enqueueOutbox(fs, OUTBOX, { op: "delete", path: "a.md", ts: 2 });

		const engine = new SyncEngine({
			fs,
			transport,
			outboxPath: OUTBOX,
			inboxPath: INBOX,
			getRevision: revision.get,
			setRevision: revision.set,
			debounceMs: 0,
		});

		await engine.tick();

		expect(transport.uploads).toEqual([]);
		expect(transport.deletes).toEqual(["a.md"]);
		expect(await listOutbox(fs, OUTBOX)).toEqual([]);
	});

	test("a remote delete throws when fs.remove is missing, stopping the apply and keeping the inbox line", async () => {
		const fs = new MemoryVaultFs();
		const vaultFs: VaultBlobFs = fs;
		vaultFs.remove = undefined;
		const transport = new FakeTransport();
		transport.simulateRemoteOp("delete", "gone.md");
		const revision = makeRevisionStore(0);

		const engine = new SyncEngine({
			fs: vaultFs,
			transport,
			outboxPath: OUTBOX,
			inboxPath: INBOX,
			getRevision: revision.get,
			setRevision: revision.set,
			debounceMs: 0,
		});

		await engine.tick();

		expect(revision.get()).toBe(0);
		expect(await readInbox(fs, INBOX)).toEqual([
			{ rev: 1, op: "delete", path: "gone.md" },
		]);
	});

	test("a remote put whose download 404s is skipped so apply can advance", async () => {
		const fs = new MemoryVaultFs();
		const transport = new FakeTransport();
		// Simulate inbox put for a path that is already gone on the server.
		transport.log.push({ rev: 1, op: "put", path: "race.md" });
		transport.download = async () => {
			const err = new Error("Download of \"race.md\" failed with status 404: Not found");
			err.name = "RemoteFileNotFoundError";
			throw err;
		};
		const revision = makeRevisionStore(0);

		const engine = new SyncEngine({
			fs,
			transport,
			outboxPath: OUTBOX,
			inboxPath: INBOX,
			getRevision: revision.get,
			setRevision: revision.set,
			debounceMs: 0,
		});

		await engine.tick();

		expect(revision.get()).toBe(1);
		expect(await readInbox(fs, INBOX)).toEqual([]);
		expect(await fs.exists("race.md")).toBe(false);
	});
});
