import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { TFile, TFolder } from "obsidian";
import SyncEngine from "./main";
import { OutboxStore } from "./db/db";
import { outboxData } from "../../shared/types";
import { MARKDOWN_FIELD } from "../../shared/yjsSeed";

class MemoryOutboxStore implements OutboxStore {
	rows: outboxData[] = [];

	async open(): Promise<void> {}
	async close(): Promise<void> {}
	async putInOutbox(row: outboxData): Promise<number> {
		this.rows.push(row);
		return this.rows.length;
	}
	async hasPendingChanges(): Promise<boolean> { return this.rows.length > 0; }
	async claimNextSegment(): Promise<null> { return null; }
	async readSegmentJsonl(): Promise<string> { return ""; }
	async readSegment(): Promise<outboxData[]> { return this.rows; }
	async completeSegment(): Promise<void> {}
	async releaseSegment(): Promise<void> {}
}

class MemoryYjsStateStore {
	states = new Map<string, Uint8Array>();
	hashes = new Map<string, string>();

	async putWithContentHash(path: string, state: Uint8Array, hash: string): Promise<void> {
		this.states.set(path, new Uint8Array(state));
		this.hashes.set(path, hash);
	}

	async get(path: string): Promise<Uint8Array | null> {
		return this.states.get(path) ?? null;
	}

	async has(path: string): Promise<boolean> {
		return this.states.has(path);
	}

	async getContentHash(path: string): Promise<string | null> {
		return this.hashes.get(path) ?? null;
	}

	async put(path: string, state: Uint8Array): Promise<void> {
		this.states.set(path, new Uint8Array(state));
	}

	async putContentHash(path: string, hash: string): Promise<void> {
		this.hashes.set(path, hash);
	}
}

function readYjsContent(state: Uint8Array): string {
	const doc = new Y.Doc();
	Y.applyUpdateV2(doc, state);
	const content = doc.getText(MARKDOWN_FIELD).toString();
	doc.destroy();
	return content;
}

function makeFile(path: string): TFile {
	const file = new TFile();
	(file as TFile & { path: string; extension: string }).path = path;
	(file as TFile & { path: string; extension: string }).extension = path.split(".").pop() ?? "";
	return file;
}

function makeFolder(path: string): TFolder {
	const folder = new TFolder();
	(folder as TFolder & { path: string }).path = path;
	return folder;
}

function makeHarness(files: Record<string, string | Uint8Array> = {}) {
	const outbox = new MemoryOutboxStore();
	const yjsStateStore = new MemoryYjsStateStore();
	const wakeSoon = vi.fn();
	const syncClient = {
		isApplyingRemoteChanges: vi.fn(() => false),
		wakeSoon,
		uploadBlob: vi.fn(),
	};
	const textEncoder = new TextEncoder();
	const app = {
		vault: {
			configDir: ".obsidian",
			read: async (file: { path: string }) => {
				const value = files[file.path] ?? "";
				return typeof value === "string" ? value : new TextDecoder().decode(value);
			},
			adapter: {
				readBinary: async (path: string) => {
					const value = files[path] ?? "";
					const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
					return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
				},
			},
		},
	};
	const plugin = Object.create(SyncEngine.prototype) as Record<string, unknown>;
	plugin.db = outbox;
	plugin.yjsStateStore = yjsStateStore;
	plugin.syncClient = syncClient;
	plugin.app = app;
	plugin.manifest = { id: "obsidian-sync-engine" };
	plugin.settings = {};
	plugin.docs = new Map();
	plugin.pendingDocs = new Map();
	plugin.pendingFileTimers = new Map();
	return { plugin: plugin as unknown as SyncEngine, outbox, yjsStateStore, wakeSoon };
}

describe("SyncEngine local CRUD enqueueing", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", globalThis);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("queues folder creates immediately", async () => {
		const { plugin, outbox, wakeSoon } = makeHarness();

		await (plugin as unknown as {
			enqueueLocalCreate: (file: TFolder) => Promise<void>;
		}).enqueueLocalCreate(makeFolder("Projects"));

		expect(outbox.rows).toMatchObject([{
			operation: "CreateFolder",
			path: "Projects",
			isFolder: true,
		}]);
		expect(wakeSoon).toHaveBeenCalledTimes(1);
	});

	it("queues markdown file creates with full Yjs state without waiting for a typed edit", async () => {
		const { plugin, outbox, yjsStateStore, wakeSoon } = makeHarness({
			"Notes/new.md": "draft",
		});

		await (plugin as unknown as {
			enqueueLocalCreate: (file: TFile) => Promise<void>;
		}).enqueueLocalCreate(makeFile("Notes/new.md"));

		expect(outbox.rows).toHaveLength(1);
		expect(outbox.rows[0]).toMatchObject({
			operation: "UpsertFile",
			path: "Notes/new.md",
			content: "draft",
			isFolder: false,
			isYjs: true,
			storageKind: "text",
		});
		expect(outbox.rows[0]?.yjsState).toBeInstanceOf(Uint8Array);
		expect(readYjsContent(outbox.rows[0]!.yjsState!)).toBe("draft");
		expect(yjsStateStore.states.get("Notes/new.md")).toEqual(outbox.rows[0]?.yjsState);
		expect(wakeSoon).toHaveBeenCalledTimes(1);
	});

	it("rebuilds stale persisted Yjs state when opening a markdown document", async () => {
		const { plugin, yjsStateStore } = makeHarness();
		yjsStateStore.states.set("Notes/open.md", new Uint8Array());
		yjsStateStore.hashes.set("Notes/open.md", "stale-hash");

		await (plugin as unknown as {
			newDoc: (path: string, content: string) => Promise<unknown>;
		}).newDoc("Notes/open.md", "current text");

		const stored = yjsStateStore.states.get("Notes/open.md");
		expect(stored).toBeInstanceOf(Uint8Array);
		expect(readYjsContent(stored!)).toBe("current text");
		expect(yjsStateStore.hashes.get("Notes/open.md")).not.toBe("stale-hash");
	});

	it("queues closed markdown modifies as Yjs updates", async () => {
		const { plugin, outbox, yjsStateStore, wakeSoon } = makeHarness({
			"Notes/existing.md": "hello world",
		});
		const previous = new Y.Doc();
		previous.getText(MARKDOWN_FIELD).insert(0, "hello");
		const previousState = Y.encodeStateAsUpdateV2(previous);
		previous.destroy();
		yjsStateStore.states.set("Notes/existing.md", previousState);
		yjsStateStore.hashes.set("Notes/existing.md", "old-hash");

		await (plugin as unknown as {
			queueExternalMarkdownChange: (file: TFile) => Promise<void>;
		}).queueExternalMarkdownChange(makeFile("Notes/existing.md"));

		expect(outbox.rows).toHaveLength(1);
		expect(outbox.rows[0]).toMatchObject({
			operation: "YjsUpdate",
			path: "Notes/existing.md",
		});
		expect(outbox.rows[0]?.data).toBeInstanceOf(Uint8Array);
		expect(readYjsContent(yjsStateStore.states.get("Notes/existing.md")!)).toBe("hello world");
		expect(wakeSoon).toHaveBeenCalledTimes(1);
	});

	it("does not enqueue a duplicate closed markdown update when content hash is unchanged", async () => {
		const { plugin, outbox, wakeSoon } = makeHarness({
			"Notes/new.md": "draft",
		});
		const testPlugin = plugin as unknown as {
			enqueueLocalCreate: (file: TFile) => Promise<void>;
			queueExternalMarkdownChange: (file: TFile) => Promise<void>;
		};

		await testPlugin.enqueueLocalCreate(makeFile("Notes/new.md"));
		await testPlugin.queueExternalMarkdownChange(makeFile("Notes/new.md"));

		expect(outbox.rows).toHaveLength(1);
		expect(outbox.rows[0]).toMatchObject({
			operation: "UpsertFile",
			path: "Notes/new.md",
		});
		expect(wakeSoon).toHaveBeenCalledTimes(1);
	});

	it("queues non-markdown file creates through the debounced upsert path", async () => {
		const { plugin, outbox, wakeSoon } = makeHarness({
			"assets/image.bin": new Uint8Array([1, 2, 3]),
		});

		await (plugin as unknown as {
			enqueueLocalCreate: (file: TFile) => Promise<void>;
		}).enqueueLocalCreate(makeFile("assets/image.bin"));
		expect(outbox.rows).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(500);

		expect(outbox.rows).toHaveLength(1);
		expect(outbox.rows[0]).toMatchObject({
			operation: "UpsertFile",
			path: "assets/image.bin",
			isFolder: false,
			isYjs: false,
			storageKind: "bytea",
			byteSize: 3,
		});
		expect(outbox.rows[0]?.contentBytes).toEqual(new Uint8Array([1, 2, 3]));
		expect(wakeSoon).toHaveBeenCalledTimes(1);
	});

	it("cancels stale pending file upserts when the path is deleted", async () => {
		const { plugin, outbox } = makeHarness({
			"assets/image.bin": new Uint8Array([1, 2, 3]),
		});
		const testPlugin = plugin as unknown as {
			queuePathUpsertDebounced: (path: string) => void;
			enqueueLocalDelete: (file: TFile) => Promise<void>;
		};

		testPlugin.queuePathUpsertDebounced("assets/image.bin");
		await testPlugin.enqueueLocalDelete(makeFile("assets/image.bin"));
		await vi.advanceTimersByTimeAsync(500);

		expect(outbox.rows).toHaveLength(1);
		expect(outbox.rows[0]).toMatchObject({
			operation: "Delete",
			path: "assets/image.bin",
			isFolder: false,
		});
	});
});
