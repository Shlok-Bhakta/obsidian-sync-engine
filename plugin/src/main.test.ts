import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { TFile, TFolder } from "obsidian";
import { EditorState } from "@codemirror/state";
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
	const content = doc.getText(MARKDOWN_FIELD).toJSON();
	doc.destroy();
	return content;
}

function readYjsContentAfterUpdate(state: Uint8Array, update: Uint8Array): string {
	const doc = new Y.Doc();
	Y.applyUpdateV2(doc, state);
	Y.applyUpdateV2(doc, update);
	const content = doc.getText(MARKDOWN_FIELD).toJSON();
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
			getAbstractFileByPath: (path: string) => files[path] === undefined ? null : makeFile(path),
			adapter: {
				readBinary: async (path: string) => {
					const value = files[path] ?? "";
					const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
					return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
				},
				read: async (path: string) => {
					const value = files[path] ?? "";
					return typeof value === "string" ? value : new TextDecoder().decode(value);
				},
				stat: async (path: string) => {
					const value = files[path];
					if (value === undefined) {
						return null;
					}
					const size = typeof value === "string" ? textEncoder.encode(value).byteLength : value.byteLength;
					return { type: "file", mtime: 1, size };
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
	plugin.settings = { lastPulledRevision: "0" };
	plugin.docs = new Map();
	plugin.pendingDocs = new Map();
	plugin.pendingFileTimers = new Map();
	plugin.startupSyncCompleted = false;
	plugin.bootVaultEntries = new Map();
	plugin.preStartupLocalEvents = new Map();
	return { plugin: plugin as unknown as SyncEngine, outbox, yjsStateStore, wakeSoon, syncClient };
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
		expect(outbox.rows[0]?.data?.byteLength).toBe(0);
		expect(readYjsContent(yjsStateStore.states.get("Notes/existing.md")!)).toBe("hello world");
		expect(wakeSoon).toHaveBeenCalledTimes(1);
	});

	it("queues real editor updates while a remote apply is in progress", async () => {
		const { plugin, outbox, syncClient, yjsStateStore } = makeHarness();
		syncClient.isApplyingRemoteChanges.mockImplementation((path?: string) => path === "Notes/open.md");
		const transaction = EditorState.create({ doc: "abcd" }).update({
			changes: { from: 4, insert: "efg" },
		});

		await (plugin as unknown as {
			handleEditorChange: (update: unknown, path: string) => Promise<void>;
		}).handleEditorChange(transaction, "Notes/open.md");

		expect(outbox.rows).toHaveLength(1);
		expect(readYjsContentAfterUpdate(yjsStateStore.states.get("Notes/open.md")!, outbox.rows[0]!.data!)).toBe("abcdefg");
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

	it("defers bootstrapped vault discovery creates before startup sync completes", async () => {
		const { plugin, outbox, wakeSoon } = makeHarness({
			"assets/image.bin": new Uint8Array([1, 2, 3]),
		});
		(plugin as unknown as {
			settings: { lastPulledRevision: string };
		}).settings.lastPulledRevision = "3105";

		await (plugin as unknown as {
			enqueueLocalCreate: (file: TFile) => Promise<void>;
		}).enqueueLocalCreate(makeFile("assets/image.bin"));
		await vi.advanceTimersByTimeAsync(500);

		expect(outbox.rows).toHaveLength(0);
		expect(wakeSoon).not.toHaveBeenCalled();
	});

	it("drops deferred bootstrapped discovery creates when the file matches the boot snapshot", async () => {
		const { plugin, outbox, wakeSoon } = makeHarness({
			"assets/image.bin": new Uint8Array([1, 2, 3]),
		});
		const testPlugin = plugin as unknown as {
			settings: { lastPulledRevision: string };
			bootVaultEntries: Map<string, { isFolder: boolean; fingerprint: string | null }>;
			enqueueLocalCreate: (file: TFile) => Promise<void>;
			flushDeferredPreStartupLocalEvents: () => Promise<void>;
		};
		testPlugin.settings.lastPulledRevision = "3105";
		testPlugin.bootVaultEntries.set("assets/image.bin", { isFolder: false, fingerprint: "1:3" });

		await testPlugin.enqueueLocalCreate(makeFile("assets/image.bin"));
		await testPlugin.flushDeferredPreStartupLocalEvents();
		await vi.advanceTimersByTimeAsync(500);

		expect(outbox.rows).toHaveLength(0);
		expect(wakeSoon).not.toHaveBeenCalled();
	});

	it("replays deferred pre-startup creates for files created after boot", async () => {
		const { plugin, outbox, wakeSoon } = makeHarness({
			"Notes/quick.md": "urgent thought",
		});
		const testPlugin = plugin as unknown as {
			settings: { lastPulledRevision: string };
			enqueueLocalCreate: (file: TFile) => Promise<void>;
			flushDeferredPreStartupLocalEvents: () => Promise<void>;
		};
		testPlugin.settings.lastPulledRevision = "3105";

		await testPlugin.enqueueLocalCreate(makeFile("Notes/quick.md"));
		await testPlugin.flushDeferredPreStartupLocalEvents();

		expect(outbox.rows).toHaveLength(1);
		expect(outbox.rows[0]).toMatchObject({
			operation: "UpsertFile",
			path: "Notes/quick.md",
			content: "urgent thought",
		});
		expect(wakeSoon).toHaveBeenCalledTimes(1);
	});

	it("queues local creates after startup sync completes for an existing synced vault", async () => {
		const { plugin, outbox, wakeSoon } = makeHarness({
			"assets/image.bin": new Uint8Array([1, 2, 3]),
		});
		const testPlugin = plugin as unknown as {
			settings: { lastPulledRevision: string };
			startupSyncCompleted: boolean;
			enqueueLocalCreate: (file: TFile) => Promise<void>;
		};
		testPlugin.settings.lastPulledRevision = "3105";
		testPlugin.startupSyncCompleted = true;

		await testPlugin.enqueueLocalCreate(makeFile("assets/image.bin"));
		await vi.advanceTimersByTimeAsync(500);

		expect(outbox.rows).toHaveLength(1);
		expect(outbox.rows[0]).toMatchObject({
			operation: "UpsertFile",
			path: "assets/image.bin",
		});
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
