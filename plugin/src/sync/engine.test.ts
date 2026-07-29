import { describe, expect, jest, test } from "bun:test";
import type { InboxOp } from "./inbox";
import { readInbox } from "./inbox";
import { enqueue as enqueueOutbox, list as listOutbox } from "./outbox";
import {
	PermanentRemoteError,
	SyncEngine,
	type SyncTransport,
	type VaultBlobFs,
} from "./engine";

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

	async append(path: string, data: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? "") + data);
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

/** Vault fs whose remove always fails — exercises applyRemoteDelete failure paths. */
class MemoryVaultFsNoRemove implements VaultBlobFs {
	private readonly inner = new MemoryVaultFs();

	read = this.inner.read.bind(this.inner);
	write = this.inner.write.bind(this.inner);
	append = this.inner.append.bind(this.inner);
	exists = this.inner.exists.bind(this.inner);
	mkdir = this.inner.mkdir.bind(this.inner);
	readBinary = this.inner.readBinary.bind(this.inner);
	writeBinary = this.inner.writeBinary.bind(this.inner);
	listAllFiles = this.inner.listAllFiles.bind(this.inner);

	async remove(path: string): Promise<void> {
		throw new Error(`remove not supported for ${path}`);
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
		const content = this.remoteFiles.get(path);
		if (content === undefined) {
			const err = new Error(
				`Download of "${path}" failed with status 404: Not found`,
			);
			err.name = "RemoteFileNotFoundError";
			throw err;
		}
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

		expect(transport.calls).toEqual([
			"upload",
			"fetchInbox",
			"download",
			"download",
		]);
		expect(transport.uploads.length).toBe(1);
		expect(transport.uploads[0]?.path).toBe("local.md");
		expect(
			new TextDecoder().decode(transport.uploads[0]?.body as ArrayBuffer),
		).toBe("hello world");
		expect(await listOutbox(fs, OUTBOX)).toEqual([]);
		expect(await fs.read("remote.md")).toBe("from the server");
		expect(await readInbox(fs, INBOX)).toEqual([]);
		// Both the remote change and authoritative self-echo were reconciled.
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

	test("self-echo: applying our own echoed line advances and reconciles local content", async () => {
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

		expect(revision.get()).toBe(1);
		expect(transport.fetchInboxCalls).toEqual([0]);
		expect(await readInbox(fs, INBOX)).toEqual([]);
		expect(transport.calls).toEqual(["upload", "fetchInbox", "download"]);
		expect(await fs.read("a.md")).toBe("content");
	});

	test("an offline local put survives an older remote tombstone before its echo", async () => {
		const fs = new MemoryVaultFs();
		await fs.write("a.md", "offline edit");
		const transport = new FakeTransport();
		transport.simulateRemoteOp("delete", "a.md");
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
		const result = await engine.tick();
		expect(result.ok).toBe(true);
		expect(revision.get()).toBe(2);
		expect(await fs.read("a.md")).toBe("offline edit");
		expect(transport.remoteFiles.get("a.md")).toBe("offline edit");
	});

	test("enqueuePut writes to the outbox immediately and coalesces rapid calls", async () => {
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
		engine.enqueuePut("a.md");
		engine.enqueuePut("a.md");
		await flushMicrotasks();

		const ops = await listOutbox(fs, OUTBOX);
		expect(ops.length).toBe(1);
		expect(ops[0]).toMatchObject({ op: "put", path: "a.md" });
	});

	test("seedFromVault enqueues a put for every file", async () => {
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
		await flushMicrotasks();

		const ops = await listOutbox(fs, OUTBOX);
		expect(ops.map((op) => op.path).sort()).toEqual(["a.md", "b.md"]);
		expect(ops.every((op) => op.op === "put")).toBe(true);
	});

	test("seedFromVault coalesces with a path already in the outbox", async () => {
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

		engine.enqueuePut("a.md");
		await flushMicrotasks();

		await engine.seedFromVault(async () => ["a.md", "b.md"]);
		await flushMicrotasks();

		const ops = await listOutbox(fs, OUTBOX);
		expect(ops.map((op) => op.path).sort()).toEqual(["a.md", "b.md"]);
		expect(ops.filter((op) => op.path === "a.md").length).toBe(1);
	});

	test("pendingOutboxPaths stays true while a newer edit is still in the outbox", async () => {
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
			debounceMs: 0,
		});

		await enqueueOutbox(fs, OUTBOX, { op: "put", path: "a.md", ts: 1 });
		engine.enqueuePut("a.md");
		await flushMicrotasks();

		transport.simulateRemoteOp("put", "a.md", "remote-should-not-land");

		await engine.hydrate();
		expect(engine.isPending("a.md")).toBe(true);

		await engine.tick();

		expect(await fs.read("a.md")).toBe("local-v2");
	});

	test("flush runs a debounced network tick without waiting out the debounce window", async () => {
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
			await flushMicrotasks();

			expect(await listOutbox(fs, OUTBOX)).toHaveLength(2);
			expect(transport.uploads).toEqual([]);

			await engine.flush();
			await flushMicrotasks(50);

			expect(transport.uploads.map((u) => u.path).sort()).toEqual([
				"a.md",
				"b.md",
			]);
			expect(await listOutbox(fs, OUTBOX)).toEqual([]);

			jest.advanceTimersByTime(5000);
			await flushMicrotasks();
			expect(transport.uploads.length).toBe(2);
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

	test("a remote delete returns ok:false when fs.remove is missing", async () => {
		const fs = new MemoryVaultFsNoRemove();
		const transport = new FakeTransport();
		transport.simulateRemoteOp("delete", "gone.md");
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

		const result = await engine.tick();

		expect(result.ok).toBe(false);
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

	test("hydrate loads pending paths from the outbox before the first pull", async () => {
		const fs = new MemoryVaultFs();
		await fs.write("local.md", "mine");
		const transport = new FakeTransport();
		transport.simulateRemoteOp("put", "local.md", "remote-wins-if-not-pending");
		const revision = makeRevisionStore(0);

		await enqueueOutbox(fs, OUTBOX, { op: "put", path: "local.md", ts: 1 });

		const engine = new SyncEngine({
			fs,
			transport,
			outboxPath: OUTBOX,
			inboxPath: INBOX,
			getRevision: revision.get,
			setRevision: revision.set,
			debounceMs: 0,
		});

		await engine.hydrate();
		expect(engine.isPending("local.md")).toBe(true);

		await engine.tick();

		expect(await fs.read("local.md")).toBe("mine");
		expect(transport.uploads.some((u) => u.path === "local.md")).toBe(true);
	});

	test("tick is single-flight — concurrent callers share one run", async () => {
		const fs = new MemoryVaultFs();
		await fs.write("a.md", "a");
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

		let releaseUpload!: () => void;
		const uploadGate = new Promise<void>((resolve) => {
			releaseUpload = resolve;
		});
		const originalUpload = transport.upload.bind(transport);
		transport.upload = async (path, body) => {
			await uploadGate;
			return originalUpload(path, body);
		};

		try {
			const first = engine.tick();
			const second = engine.tick();
			await flushMicrotasks();
			releaseUpload();
			const [r1, r2] = await Promise.all([first, second]);
			expect(r1).toEqual(r2);
			expect(r1.ok).toBe(true);
			expect(transport.uploads.length).toBe(1);
		} finally {
			releaseUpload();
		}
	});

	test("dead-lettering a permanent 413 failure does not block later outbox ops", async () => {
		const fs = new MemoryVaultFs();
		await fs.write("big.md", "too big");
		await fs.write("ok.md", "fine");
		const transport = new FakeTransport();
		const revision = makeRevisionStore(0);
		const deadLetterPath = "dead-letter.jsonl";

		await enqueueOutbox(fs, OUTBOX, { op: "put", path: "big.md", ts: 1 });
		await enqueueOutbox(fs, OUTBOX, { op: "put", path: "ok.md", ts: 2 });

		const originalUpload = transport.upload.bind(transport);
		transport.upload = async (path, body) => {
			if (path === "big.md") {
				throw new PermanentRemoteError("Payload too large", 413);
			}
			return originalUpload(path, body);
		};

		const engine = new SyncEngine({
			fs,
			transport,
			outboxPath: OUTBOX,
			inboxPath: INBOX,
			deadLetterPath,
			getRevision: revision.get,
			setRevision: revision.set,
			debounceMs: 0,
		});

		const result = await engine.tick();

		expect(result.ok).toBe(false);
		expect(result.deadLettered).toBe(1);
		expect(result.pushed).toBe(1);
		expect(await listOutbox(fs, OUTBOX)).toEqual([]);
		expect(transport.uploads.some((u) => u.path === "ok.md")).toBe(true);
		expect(await fs.exists(deadLetterPath)).toBe(true);
	});

	test("suspension blocks both network ticks and new durable intent", async () => {
		const fs = new MemoryVaultFs();
		await fs.write("a.md", "local");
		const transport = new FakeTransport();
		const revision = makeRevisionStore(0);
		const engine = new SyncEngine({
			fs,
			transport,
			outboxPath: OUTBOX,
			inboxPath: INBOX,
			getRevision: revision.get,
			setRevision: revision.set,
			isSuspended: () => true,
		});
		expect(engine.enqueueDurable("a.md", "put")).rejects.toThrow(
			"suspended",
		);
		const result = await engine.tick();
		expect(result.ok).toBe(false);
		expect(transport.calls).toEqual([]);
		expect(await listOutbox(fs, OUTBOX)).toEqual([]);
	});

	test("deleteRemote for a never-uploaded path still succeeds via transport", async () => {
		const fs = new MemoryVaultFs();
		const transport = new FakeTransport();
		const revision = makeRevisionStore(0);

		await enqueueOutbox(fs, OUTBOX, {
			op: "delete",
			path: "never-uploaded.md",
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

		const result = await engine.tick();

		expect(result.ok).toBe(true);
		expect(transport.deletes).toEqual(["never-uploaded.md"]);
		expect(await listOutbox(fs, OUTBOX)).toEqual([]);
	});
});
