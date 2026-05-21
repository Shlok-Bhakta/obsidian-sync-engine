import { MarkdownView, Notice, Platform, Plugin, TAbstractFile, TFile, TFolder } from 'obsidian';
import * as Y from 'yjs';
import {DEFAULT_SETTINGS, SyncEngineSettings, SyncEngineSettingTab} from "./settings";
import { JsonlOutboxStore, OutboxStore } from 'db/db';
import { EditorView, ViewUpdate } from "@codemirror/view";
import { EditorSelection } from "@codemirror/state";
import { BootstrapStatus, outboxData, Path } from "../../shared/types";
import { DocSync } from 'yjs/DocSync';
import { SyncClient } from 'sync/SyncClient';
import { editorViewFor, fileForEditorView } from 'utils/editorFile';
import { YjsStateStore } from 'yjs/YjsStateStore';
import { VaultYjsIndexer } from 'yjs/VaultYjsIndexer';
import { docStateFromContent } from "../../shared/yjsSeed";
import { isPluginInternalPath, shouldSyncPath, shouldUseYjs } from "../../shared/pathPolicy";
import { errorContext } from "../../shared/logger";
import { log } from "./logger";

const INLINE_BYTES_LIMIT = 64 * 1024;
const CONFIG_DIR_POLL_MS = Platform.isMobile ? 30_000 : 2000;
type ConfigDirScanMode = "baseline" | "enqueue";

function generateClientId(): string {
	return "obs_client_" + crypto.randomUUID();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function changedRange(before: string, after: string): { from: number; to: number; insert: string } | null {
	if (before === after) {
		return null;
	}
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
		prefix++;
	}
	let beforeSuffix = before.length;
	let afterSuffix = after.length;
	while (
		beforeSuffix > prefix &&
		afterSuffix > prefix &&
		before.charCodeAt(beforeSuffix - 1) === after.charCodeAt(afterSuffix - 1)
	) {
		beforeSuffix--;
		afterSuffix--;
	}
	return {
		from: prefix,
		to: beforeSuffix,
		insert: after.slice(prefix, afterSuffix),
	};
}

function mapPositionThroughReplacement(position: number, from: number, to: number, insertLength: number): number {
	if (position <= from) {
		return position;
	}
	if (position >= to) {
		return position + insertLength - (to - from);
	}
	return from + insertLength;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", exactArrayBuffer(bytes));
	return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export default class SyncEngine extends Plugin {
	settings: SyncEngineSettings;
	db: OutboxStore;
	docs: Map<Path, DocSync>;
	pendingDocs: Map<Path, Promise<DocSync>>;
	editorChangeQueues: Map<Path, Promise<void>>;
	pruningDocs: Set<Path>;
	yjsStateStore: YjsStateStore;
	yjsIndexer: VaultYjsIndexer;
	syncClient: SyncClient;
	bootstrapStatus: BootstrapStatus | null = null;
	private bootstrapStatusBarEl: HTMLElement | null = null;
	private bootstrapStatusListeners: Set<() => void> = new Set();
	private pendingFileTimers: Map<Path, number> = new Map();
	private configDirStats: Map<Path, string> = new Map();
	private remoteEditorDispatches: Set<EditorView> = new Set();
	private configDirPollerStarted = false;
	private yjsIndexerStarted = false;
	/** Content hashes of syncable config files on disk before the first startup pull. */
	private bootConfigSha = new Map<Path, string>();
	/** Last config file bytes applied from the server during startup/live pull. */
	private serverConfigBytes = new Map<Path, Uint8Array>();
	private serverConfigSha = new Map<Path, string>();
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
		this.editorChangeQueues = new Map<Path, Promise<void>>();
		this.pruningDocs = new Set<Path>();
		await this.db.open();
		await this.yjsStateStore.open();
		this.bootstrapStatusBarEl = this.addStatusBarItem();
		this.bootstrapStatusBarEl.addClass("sync-engine-bootstrap-statusbar");
		this.renderBootstrapStatusBar();
		void this.captureBootConfigShas();
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
			(status) => this.setBootstrapStatus(status),
			() => {
				this.startConfigDirPoller();
				if (!Platform.isMobile) {
					this.startYjsIndexer();
				}
			},
			(path, bytes) => {
				void this.recordRemoteConfigApplied(path, bytes);
			},
			(path, content) => this.applyRemoteYjsContentToOpenEditors(path, content),
			(path) => this.flushEditorChangeQueue(path),
			this.manifest.id,
		);
		this.app.workspace.onLayoutReady(() => {
			log.info("workspace ready; starting sync client");
			this.syncClient.start();
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
			if (this.remoteEditorDispatches.has(update.view)) {
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
			this.queueEditorChange(update, pathID);
		});
	}

	private queueEditorChange(update: ViewUpdate, pathID: Path): void {
		const previous = this.editorChangeQueues.get(pathID) ?? Promise.resolve();
		const next = previous
			.catch(() => {})
			.then(() => this.handleEditorChange(update, pathID))
			.catch(error => {
				log.error("failed to process editor change", { path: pathID, ...errorContext(error) });
				new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
			})
			.finally(() => {
				if (this.editorChangeQueues.get(pathID) === next) {
					this.editorChangeQueues.delete(pathID);
				}
			});
		this.editorChangeQueues.set(pathID, next);
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
		await doc.applyChanges(update.changes, row, (error) => {
			log.error("failed to enqueue editor Yjs update", { path: pathID, mutationId: row.mutationId, ...errorContext(error) });
			new Notice(`Sync outbox write failed: ${error.message}`);
		}, update.startState.doc.toString(), update.state.doc.toString());
		log.debug("queued editor Yjs update", { path: pathID, mutationId: row.mutationId });
		this.syncClient.wakeSoon();
	}

	private async flushEditorChangeQueue(pathID: Path): Promise<void> {
		await (this.editorChangeQueues.get(pathID) ?? Promise.resolve());
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
		if (this.syncClient?.isApplyingRemoteChanges(file.path) || !shouldSyncPath(file.path, this.app.vault.configDir, this.manifest.id)) {
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
			(this.syncClient?.isApplyingRemoteChanges(oldPath) || this.syncClient?.isApplyingRemoteChanges(file.path)) ||
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
		if (this.configDirPollerStarted) {
			return;
		}
		this.configDirPollerStarted = true;
		void this.scanConfigDirForChanges("baseline");
		this.registerInterval(window.setInterval(() => {
			void this.scanConfigDirForChanges("enqueue");
		}, CONFIG_DIR_POLL_MS));
	}

	private async scanConfigDirForChanges(mode: ConfigDirScanMode): Promise<void> {
		if (typeof document !== "undefined" && document.visibilityState === "hidden") {
			return;
		}
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

	private startYjsIndexer(): void {
		if (this.yjsIndexerStarted) {
			return;
		}
		this.yjsIndexerStarted = true;
		this.yjsIndexer.start();
	}

	private async enqueueLocalPathDelete(path: string): Promise<void> {
		if (this.syncClient?.isApplyingRemoteChanges(path) || !shouldSyncPath(path, this.app.vault.configDir, this.manifest.id)) {
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

	private async applyRemoteYjsContentToOpenEditors(path: Path, content: string): Promise<boolean> {
		let applied = false;
		for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
			const view = leaf.view;
			if (!(view instanceof MarkdownView) || view.file?.path !== path) {
				continue;
			}
			applied = true;
			const editorView = editorViewFor(view.editor);
			if (!editorView) {
				if (view.editor.getValue() !== content) {
					view.editor.setValue(content);
				}
				continue;
			}
			const before = editorView.state.doc.toString();
			const change = changedRange(before, content);
			if (!change) {
				continue;
			}
			const selection = editorView.state.selection.ranges.map(range => ({
				anchor: mapPositionThroughReplacement(range.anchor, change.from, change.to, change.insert.length),
				head: mapPositionThroughReplacement(range.head, change.from, change.to, change.insert.length),
			}));
			this.remoteEditorDispatches.add(editorView);
			try {
				editorView.dispatch({
					changes: change,
					selection: EditorSelection.create(selection.map(range => EditorSelection.range(range.anchor, range.head))),
				});
			} finally {
				this.remoteEditorDispatches.delete(editorView);
			}
		}
		return applied;
	}

	private queueNonMarkdownUpsert(file: TAbstractFile): void {
		if (
			this.syncClient?.isApplyingRemoteChanges(file.path) ||
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

	private async captureBootConfigShas(): Promise<void> {
		for (const path of await this.listConfigDirFiles(this.app.vault.configDir)) {
			if (!this.isSyncableConfigPath(path)) {
				continue;
			}
			try {
				const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
				this.bootConfigSha.set(path, await sha256Hex(bytes));
			} catch (error) {
				log.debug("failed to capture boot config hash", { path, ...errorContext(error) });
			}
		}
	}

	private async recordRemoteConfigApplied(path: string, bytes: Uint8Array): Promise<void> {
		if (!this.isSyncableConfigPath(path)) {
			return;
		}
		const snapshot = new Uint8Array(bytes);
		this.serverConfigBytes.set(path, snapshot);
		this.serverConfigSha.set(path, await sha256Hex(snapshot));
		const stat = await this.app.vault.adapter.stat(path);
		if (stat?.type === "file") {
			this.configDirStats.set(path, `${stat.mtime}:${stat.size}`);
		}
	}

	private async restoreServerConfig(path: string): Promise<boolean> {
		const bytes = this.serverConfigBytes.get(path);
		if (!bytes) {
			return false;
		}
		await this.app.vault.adapter.writeBinary(path, exactArrayBuffer(bytes));
		const stat = await this.app.vault.adapter.stat(path);
		if (stat?.type === "file") {
			this.configDirStats.set(path, `${stat.mtime}:${stat.size}`);
		}
		log.info("restored config file from last server version", { path });
		return true;
	}

	private isSyncableConfigPath(path: string): boolean {
		return this.isConfigDirPath(path)
			&& shouldSyncPath(path, this.app.vault.configDir, this.manifest.id)
			&& !shouldUseYjs(path, this.app.vault.configDir);
	}

	private async queuePathUpsert(path: string): Promise<void> {
		if (this.syncClient?.isApplyingRemoteChanges(path) || !shouldSyncPath(path, this.app.vault.configDir, this.manifest.id)) {
			return;
		}
		const bytes = new Uint8Array(await this.app.vault.adapter.readBinary(path));
		let localSha: string | undefined;
		if (this.isSyncableConfigPath(path)) {
			localSha = await sha256Hex(bytes);
			const serverSha = this.serverConfigSha.get(path);
			if (serverSha && localSha === serverSha) {
				log.debug("skip config upsert; matches last server version", { path });
				return;
			}
			const bootSha = this.bootConfigSha.get(path);
			if (serverSha && bootSha && localSha === bootSha && localSha !== serverSha) {
				if (await this.restoreServerConfig(path)) {
					log.warn("ignored obsidian config rewrite that reverted a synced change", { path });
					return;
				}
			}
		}
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
		if (this.isSyncableConfigPath(path)) {
			const appliedSha = localSha ?? await sha256Hex(bytes);
			this.bootConfigSha.set(path, appliedSha);
			this.serverConfigSha.set(path, appliedSha);
			this.serverConfigBytes.set(path, new Uint8Array(bytes));
		}
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

	private setBootstrapStatus(status: BootstrapStatus): void {
		this.bootstrapStatus = status;
		this.renderBootstrapStatusBar();
		for (const listener of this.bootstrapStatusListeners) {
			listener();
		}
	}

	private renderBootstrapStatusBar(): void {
		if (!this.bootstrapStatusBarEl) {
			return;
		}
		const status = this.bootstrapStatus;
		if (!status || !["building", "uploading", "complete", "failed"].includes(status.status)) {
			this.bootstrapStatusBarEl.setText("");
			this.bootstrapStatusBarEl.hide();
			return;
		}
		this.bootstrapStatusBarEl.show();
		if (status.status === "failed") {
			this.bootstrapStatusBarEl.setText(`Sync bootstrap failed: ${status.message ?? "Unknown error"}`);
			return;
		}
		if (status.status === "complete") {
			this.bootstrapStatusBarEl.setText("Sync bootstrap complete");
			return;
		}
		const total = status.progressTotal ?? 0;
		const current = status.progressCurrent ?? 0;
		const percent = total > 0 ? Math.min(100, Math.floor((current / total) * 100)) : 0;
		this.bootstrapStatusBarEl.setText(`Sync bootstrap ${percent}%`);
	}

	async generateVaultLink(): Promise<void> {
		await this.syncClient.generateBootstrapLink(
			this.app.vault.getName(),
			this.app.vault.configDir,
			this.manifest.id,
		);
	}
}
