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

class FakeTransport implements SyncTransport {
	revision = 0;
	readonly remoteFiles = new Map<string, string>();
	readonly uploads: { path: string; body: ArrayBuffer | string }[] = [];
	readonly deletes: string[] = [];
	readonly fetchInboxCalls: number[] = [];
	readonly calls: string[] = [];
	/** Ops to return the next time fetchInbox is called with a matching `since` rev. */
	presetInbox: InboxOp[] = [];

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
		return { revision: this.revision };
	}

	async deleteRemote(path: string): Promise<{ revision: number }> {
		this.calls.push("delete");
		this.revision++;
		this.deletes.push(path);
		this.remoteFiles.delete(path);
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
		return this.presetInbox.filter((op) => op.rev > rev);
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
		transport.remoteFiles.set("remote.md", "from the server");
		// rev 2: our own push consumes rev 1, so the inbox line must be beyond that.
		transport.presetInbox = [{ rev: 2, op: "put", path: "remote.md" }];
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
		expect(revision.get()).toBe(2);
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

	test("self-echo: after a push advances the revision, the matching fetchInbox call comes back empty and nothing re-applies", async () => {
		const fs = new MemoryVaultFs();
		await fs.write("a.md", "content");
		const transport = new FakeTransport();
		// No inbox ops beyond rev 0 are preset, so once the revision moves to 5,
		// fetchInbox(5) naturally returns [] — simulating the server not
		// echoing our own just-pushed change back to us.
		const revision = makeRevisionStore(0);

		await enqueueOutbox(fs, OUTBOX, {
			op: "put",
			path: "a.md",
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

		// Force the transport to report a big jump in revision, as if other
		// clients had pushed in between.
		transport.revision = 4;

		await engine.tick();

		expect(revision.get()).toBe(5);
		expect(transport.fetchInboxCalls).toEqual([5]);
		expect(await readInbox(fs, INBOX)).toEqual([]);
		// download was never called — nothing was re-applied for our own echo.
		expect(transport.calls).toEqual(["upload", "fetchInbox"]);
	});
});
