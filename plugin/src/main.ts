import { MarkdownView, Notice, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import * as Y from 'yjs';
import {DEFAULT_SETTINGS, SyncEngineSettings, SyncEngineSettingTab} from "./settings";
import { JsonlOutboxStore, OutboxStore } from 'db/db';
import { EditorView, ViewUpdate } from "@codemirror/view";
import { BootstrapStatus, outboxData, Path } from "../../shared/types";
import { DocSync } from 'yjs/DocSync';
import { SyncClient } from 'sync/SyncClient';
import { fileForEditorView } from 'utils/editorFile';
import { YjsStateStore } from 'yjs/YjsStateStore';
import { VaultYjsIndexer } from 'yjs/VaultYjsIndexer';
import { docStateFromContent } from "../../shared/yjsSeed";
import { isPluginInternalPath, shouldSyncPath, shouldUseYjs } from "../../shared/pathPolicy";
import { errorContext } from "../../shared/logger";
import { log } from "./logger";

const INLINE_BYTES_LIMIT = 64 * 1024;
const CONFIG_DIR_POLL_MS = 2000;
type ConfigDirScanMode = "baseline" | "enqueue";

function generateClientId(): string {
	return "obs_client_" + crypto.randomUUID();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default class SyncEngine extends Plugin {
	settings: SyncEngineSettings;
	db: OutboxStore;
	docs: Map<Path, DocSync>;
	pendingDocs: Map<Path, Promise<DocSync>>;
	pruningDocs: Set<Path>;
	yjsStateStore: YjsStateStore;
	yjsIndexer: VaultYjsIndexer;
	syncClient: SyncClient;
	bootstrapStatus: BootstrapStatus | null = null;
	private bootstrapStatusListeners: Set<() => void> = new Set();
	private pendingFileTimers: Map<Path, number> = new Map();
	private configDirStats: Map<Path, string> = new Map();
	async onload() {
		await this.loadSettings();
		log.info("plugin loading", {
			vaultName: this.app.vault.getName(),
			configDir: this.app.vault.configDir,
			clientId: this.settings.clientId.slice(0, 18),
			clientName: this.settings.clientName,
			lastPulledRevision: this.settings.lastPulledRevision,
		});
		this.db = new JsonlOutboxStore(this.app, this.manifest);
		this.yjsStateStore = new YjsStateStore(this.app, this.manifest);
		this.docs = new Map<Path, DocSync>();
		this.pendingDocs = new Map<Path, Promise<DocSync>>();
		this.pruningDocs = new Set<Path>();
		await this.db.open();
		await this.yjsStateStore.open();
		this.yjsIndexer = new VaultYjsIndexer(
			this.app,
			this.yjsStateStore,
			(path) => !shouldUseYjs(path, this.app.vault.configDir) || this.isPluginInternalPath(path),
		);
		this.syncClient = new SyncClient(
			this.app,
			this.db,
			this.yjsStateStore,
			this.settings,
			async (clientKey) => {
				this.settings = {
					...this.settings,
					clientKey,
				};
				await this.saveSettings();
			},
			async (revision) => {
				this.settings = {
					...this.settings,
					lastPulledRevision: revision,
				};
				await this.saveSettings();
			},
			(path) => this.docs.get(path),
			(status) => {
				this.bootstrapStatus = status;
				for (const listener of this.bootstrapStatusListeners) {
					listener();
				}
			},
		);
		this.app.workspace.onLayoutReady(() => {
			log.info("workspace ready; starting Yjs indexer");
			this.yjsIndexer.start();
			void this.yjsIndexer.waitForInitialScan().finally(() => {
				log.info("initial Yjs index complete; starting sync client");
				this.syncClient.start();
				this.startConfigDirPoller();
			});
		});

		this.registerEvent(this.app.workspace.on("layout-change", () => {
			void this.pruneClosedDocs();
		}));
		this.registerEvent(this.app.vault.on("create", file => {
			log.debug("vault create event", { path: file.path, type: file instanceof TFolder ? "folder" : "file" });
			void this.yjsIndexer.ensureFile(file);
			void this.queueNonMarkdownUpsert(file);
		}));
		this.registerEvent(this.app.vault.on("modify", file => {
			log.debug("vault modify event", { path: file.path, type: file instanceof TFolder ? "folder" : "file" });
			void this.yjsIndexer.ensureFile(file);
			void this.queueNonMarkdownUpsert(file);
		}));
		this.registerEvent(this.app.vault.on("delete", file => {
			log.info("vault delete event", { path: file.path, type: file instanceof TFolder ? "folder" : "file" });
			void this.enqueueLocalDelete(file).catch(error => {
				log.error("failed to enqueue local delete", { path: file.path, ...errorContext(error) });
				new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
			});
			void this.yjsIndexer.delete(file);
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			log.info("vault rename event", { oldPath, path: file.path, type: file instanceof TFolder ? "folder" : "file" });
			void this.enqueueLocalRename(file, oldPath).catch(error => {
				log.error("failed to enqueue local rename", { oldPath, path: file.path, ...errorContext(error) });
				new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
			});
			void this.yjsIndexer.rename(file, oldPath);
		}));

		this.addSettingTab(new SyncEngineSettingTab(this.app, this));
		this.registerEditorExtension(this.makeEditorOutboxExtension());
	}

	private makeEditorOutboxExtension(){
		return EditorView.updateListener.of((update: ViewUpdate) => {
			if (this.syncClient?.isApplyingRemoteChanges()) {
				return;
			}
			if (!update.docChanged) {
				return;
			}
			const file = fileForEditorView(this.app, update.view);
			if (!file) {
				return;
			}
			const pathID = file.path;
			if (!shouldUseYjs(pathID, this.app.vault.configDir)) {
				return;
			}
			void this.handleEditorChange(update, pathID);
		});
	}

	private async handleEditorChange(update: ViewUpdate, pathID: Path): Promise<void> {
		const doc = await this.getOrCreateDoc(pathID, update.startState.doc.toString());
		const row: outboxData = {
			mutationId: crypto.randomUUID(),
			operation: "YjsUpdate",
			path: pathID,
			data: new Uint8Array(),
			created: Date.now(),
		};
		doc.applyChanges(update.changes, row, (error) => {
			log.error("failed to enqueue editor Yjs update", { path: pathID, mutationId: row.mutationId, ...errorContext(error) });
			new Notice(`Sync outbox write failed: ${error.message}`);
		});
		log.debug("queued editor Yjs update", { path: pathID, mutationId: row.mutationId });
		this.syncClient.wakeSoon();
	}

	private getOrCreateDoc(pathID: Path, initialContent: string): Promise<DocSync> {
		const existing = this.docs.get(pathID);
		if (existing) {
			return Promise.resolve(existing);
		}
		const pending = this.pendingDocs.get(pathID);
		if (pending) {
			return pending;
		}
		const created = this.newDoc(pathID, initialContent).finally(() => {
			this.pendingDocs.delete(pathID);
		});
		this.pendingDocs.set(pathID, created);
		return created;
	}

	private async newDoc(pathID: Path, initialContent: string): Promise<DocSync> {
		let initialState = await this.yjsStateStore.get(pathID);
		if (!initialState) {
			initialState = docStateFromContent(initialContent, Y);
			await this.yjsStateStore.put(pathID, initialState);
			log.debug("seeded Yjs state for open document", { path: pathID, chars: initialContent.length });
		}
		const dsync = new DocSync(this.db, this.yjsStateStore, pathID, initialState);
		this.docs.set(pathID, dsync);
		log.debug("created DocSync", { path: pathID });
		return dsync;
	}

	private async enqueueLocalDelete(file: TAbstractFile): Promise<void> {
		if (this.syncClient?.isApplyingRemoteChanges() || !shouldSyncPath(file.path, this.app.vault.configDir, this.manifest.id)) {
			return;
		}
		await this.db.putInOutbox({
			mutationId: crypto.randomUUID(),
			operation: "Delete",
			path: file.path,
			isFolder: file instanceof TFolder,
			created: Date.now(),
		});
		log.info("queued local delete", { path: file.path, isFolder: file instanceof TFolder });
		this.syncClient.wakeSoon();
	}

	private async enqueueLocalRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (
			this.syncClient?.isApplyingRemoteChanges() ||
			!shouldSyncPath(oldPath, this.app.vault.configDir, this.manifest.id) ||
			!shouldSyncPath(file.path, this.app.vault.configDir, this.manifest.id)
		) {
			return;
		}
		await this.db.putInOutbox({
			mutationId: crypto.randomUUID(),
			operation: "Rename",
			path: oldPath,
			toPath: file.path,
			isFolder: file instanceof TFolder,
			created: Date.now(),
		});
		log.info("queued local rename", { oldPath, path: file.path, isFolder: file instanceof TFolder });
		this.syncClient.wakeSoon();
	}

	private startConfigDirPoller(): void {
		void this.scanConfigDirForChanges("baseline");
		this.registerInterval(window.setInterval(() => {
			void this.scanConfigDirForChanges("enqueue");
		}, CONFIG_DIR_POLL_MS));
	}

	private async scanConfigDirForChanges(mode: ConfigDirScanMode): Promise<void> {
		if (this.syncClient?.isApplyingRemoteChanges()) {
			return;
		}
		const seen = new Set<string>();
		for (const path of await this.listConfigDirFiles(this.app.vault.configDir)) {
			if (!shouldSyncPath(path, this.app.vault.configDir, this.manifest.id) || shouldUseYjs(path, this.app.vault.configDir)) {
				continue;
			}
			const stat = await this.app.vault.adapter.stat(path);
			if (!stat || stat.type !== "file") {
				continue;
			}
			seen.add(path);
			const fingerprint = `${stat.mtime}:${stat.size}`;
			if (this.configDirStats.get(path) === fingerprint) {
				continue;
			}
			this.configDirStats.set(path, fingerprint);
			if (mode === "enqueue") {
				this.queuePathUpsertDebounced(path);
			}
		}

		for (const path of [...this.configDirStats.keys()]) {
			if (seen.has(path)) {
				continue;
			}
			this.configDirStats.delete(path);
			if (mode === "enqueue" && shouldSyncPath(path, this.app.vault.configDir, this.manifest.id)) {
				void this.enqueueLocalPathDelete(path).catch(error => {
					log.error("failed to enqueue config dir delete", { path, ...errorContext(error) });
					new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
				});
			}
		}
	}

	private async listConfigDirFiles(dir: string): Promise<string[]> {
		if (!(await this.app.vault.adapter.exists(dir))) {
			return [];
		}
		const listed = await this.app.vault.adapter.list(dir);
		const files = [...listed.files];
		for (const folder of listed.folders) {
			files.push(...await this.listConfigDirFiles(folder));
		}
		return files;
	}

	private async enqueueLocalPathDelete(path: string): Promise<void> {
		if (this.syncClient?.isApplyingRemoteChanges() || !shouldSyncPath(path, this.app.vault.configDir, this.manifest.id)) {
			return;
		}
		await this.db.putInOutbox({
			mutationId: crypto.randomUUID(),
			operation: "Delete",
			path,
			isFolder: false,
			created: Date.now(),
		});
		log.info("queued local path delete", { path });
		this.syncClient.wakeSoon();
	}

	private async pruneClosedDocs(): Promise<void> {
		const openPaths = new Set<string>();
		const pruned: Promise<void>[] = [];
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file) {
				openPaths.add(view.file.path);
			}
		}
		for (const [path, doc] of this.docs) {
			if (!openPaths.has(path) && !this.pruningDocs.has(path)) {
				this.pruningDocs.add(path);
				pruned.push(this.pruneClosedDoc(path, doc).finally(() => {
					this.pruningDocs.delete(path);
				}));
			}
		}
		await Promise.all(pruned);
	}

	private async pruneClosedDoc(path: Path, doc: DocSync): Promise<void> {
		try {
			await doc.persistState();
		} catch (error) {
			log.error("failed to persist closed Yjs doc", { path, ...errorContext(error) });
			return;
		}
		if (this.docs.get(path) !== doc || this.isMarkdownPathOpen(path)) {
			return;
		}
		doc.destroy();
		this.docs.delete(path);
		log.debug("pruned closed DocSync", { path });
	}

	private isMarkdownPathOpen(path: Path): boolean {
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) {
				return true;
			}
		}
		return false;
	}

	private queueNonMarkdownUpsert(file: TAbstractFile): void {
		if (
			this.syncClient?.isApplyingRemoteChanges() ||
			!(file instanceof TFile) ||
			this.isConfigDirPath(file.path) ||
			shouldUseYjs(file.path, this.app.vault.configDir) ||
			!shouldSyncPath(file.path, this.app.vault.configDir, this.manifest.id)
		) {
			return;
		}
		this.queuePathUpsertDebounced(file.path);
	}

	private queuePathUpsertDebounced(path: string): void {
		const existing = this.pendingFileTimers.get(path);
		if (existing !== undefined) {
			window.clearTimeout(existing);
		}
		const timer = window.setTimeout(() => {
			this.pendingFileTimers.delete(path);
			void this.queuePathUpsert(path).catch(error => {
				log.error("failed to enqueue file upsert", { path, ...errorContext(error) });
				new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
			});
		}, 500);
		this.pendingFileTimers.set(path, timer);
	}

	private async queuePathUpsert(path: string): Promise<void> {
		if (this.syncClient?.isApplyingRemoteChanges() || !shouldSyncPath(path, this.app.vault.configDir, this.manifest.id)) {
			return;
		}
		const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
		if (bytes.byteLength > INLINE_BYTES_LIMIT) {
			const metadata = await this.syncClient.uploadBlob(path, bytes);
			await this.db.putInOutbox({
				mutationId: crypto.randomUUID(),
				operation: "UpsertFile",
				path,
				isFolder: false,
				isYjs: false,
				storageKind: "lo",
				byteSize: metadata.byteSize,
				contentSha256: metadata.contentSha256,
				created: Date.now(),
			});
			log.info("queued large file upsert", { path, byteSize: metadata.byteSize, contentSha256: metadata.contentSha256 });
			this.syncClient.wakeSoon();
			return;
		}
		await this.db.putInOutbox({
			mutationId: crypto.randomUUID(),
			operation: "UpsertFile",
			path,
			contentBytes: bytes,
			isFolder: false,
			isYjs: false,
			storageKind: "bytea",
			byteSize: bytes.byteLength,
			created: Date.now(),
		});
		log.info("queued file upsert", { path, byteSize: bytes.byteLength });
		this.syncClient.wakeSoon();
	}

	private isPluginInternalPath(path: string): boolean {
		return isPluginInternalPath(path, this.app.vault.configDir, this.manifest.id);
	}

	private isConfigDirPath(path: string): boolean {
		const configDir = this.app.vault.configDir.replace(/^\/+|\/+$/g, "");
		return path === configDir || path.startsWith(`${configDir}/`);
	}

	onunload() {
		log.info("plugin unloading");
		for (const timer of this.pendingFileTimers.values()) {
			window.clearTimeout(timer);
		}
		this.pendingFileTimers.clear();
		this.syncClient?.stop();
		this.yjsIndexer?.stop();
		void this.db.close().catch(error => {
			log.error("failed to close outbox store", errorContext(error));
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<SyncEngineSettings>);
		if (!this.settings.clientId.trim()) {
			this.settings = {
				...this.settings,
				clientId: generateClientId(),
			};
			await this.saveSettings();
		}
		if (!this.settings.lastPulledRevision.trim()) {
			this.settings = {
				...this.settings,
				lastPulledRevision: "0",
			};
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	updateSyncSettings() {
		this.syncClient?.updateSettings(this.settings);
	}

	subscribeBootstrapStatus(listener: () => void): () => void {
		this.bootstrapStatusListeners.add(listener);
		return () => this.bootstrapStatusListeners.delete(listener);
	}

	async generateVaultLink(): Promise<void> {
		await this.syncClient.generateBootstrapLink(
			this.app.vault.getName(),
			this.app.vault.configDir,
			this.manifest.id,
		);
	}
}
