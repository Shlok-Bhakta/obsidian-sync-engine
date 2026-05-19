import { MarkdownView, Notice, Plugin, TAbstractFile, TFolder } from 'obsidian';
import * as Y from 'yjs';
import {DEFAULT_SETTINGS, SyncEngineSettings, SyncEngineSettingTab} from "./settings";
import { JsonlOutboxStore, OutboxStore } from 'db/db';
import { EditorView, ViewUpdate } from "@codemirror/view";
import { outboxData, Path } from "../../shared/types";
import { DocSync } from 'yjs/DocSync';
import { SyncClient } from 'sync/SyncClient';
import { fileForEditorView } from 'utils/editorFile';
import { YjsStateStore } from 'yjs/YjsStateStore';
import { VaultYjsIndexer } from 'yjs/VaultYjsIndexer';
import { docStateFromContent } from "../../shared/yjsSeed";

function generateClientKey(): string {
	return "obs_sync_" + crypto.randomUUID();
}

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
	async onload() {
		await this.loadSettings();
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
			(path) => this.isPluginPrivatePath(path),
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
		);
		this.app.workspace.onLayoutReady(() => {
			this.yjsIndexer.start();
			void this.yjsIndexer.waitForInitialScan().finally(() => {
				this.syncClient.start();
			});
		});

		this.registerEvent(this.app.workspace.on("layout-change", () => {
			void this.pruneClosedDocs();
		}));
		this.registerEvent(this.app.vault.on("create", file => {
			void this.yjsIndexer.ensureFile(file);
		}));
		this.registerEvent(this.app.vault.on("modify", file => {
			void this.yjsIndexer.ensureFile(file);
		}));
		this.registerEvent(this.app.vault.on("delete", file => {
			void this.enqueueLocalDelete(file).catch(error => {
				new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
			});
			void this.yjsIndexer.delete(file);
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			void this.enqueueLocalRename(file, oldPath).catch(error => {
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
			new Notice(`Sync outbox write failed: ${error.message}`);
		});
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
		}
		const dsync = new DocSync(this.db, this.yjsStateStore, pathID, initialState);
		this.docs.set(pathID, dsync);
		return dsync;
	}

	private async enqueueLocalDelete(file: TAbstractFile): Promise<void> {
		if (this.syncClient?.isApplyingRemoteChanges() || this.isPluginPrivatePath(file.path)) {
			return;
		}
		await this.db.putInOutbox({
			mutationId: crypto.randomUUID(),
			operation: "Delete",
			path: file.path,
			isFolder: file instanceof TFolder,
			created: Date.now(),
		});
		this.syncClient.wakeSoon();
	}

	private async enqueueLocalRename(file: TAbstractFile, oldPath: string): Promise<void> {
		if (this.syncClient?.isApplyingRemoteChanges() || this.isPluginPrivatePath(oldPath) || this.isPluginPrivatePath(file.path)) {
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
			console.error("failed to persist closed Yjs doc", error);
			return;
		}
		if (this.docs.get(path) !== doc || this.isMarkdownPathOpen(path)) {
			return;
		}
		doc.destroy();
		this.docs.delete(path);
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

	private isPluginPrivatePath(path: string): boolean {
		return path.startsWith(`${this.app.vault.configDir}/`);
	}

	onunload() {
		this.syncClient?.stop();
		this.yjsIndexer?.stop();
		void this.db.close().catch(error => {
			console.error("failed to close outbox store", error);
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<SyncEngineSettings>);
		if (!this.settings.clientKey.trim() || this.settings.clientKey === DEFAULT_SETTINGS.clientKey) {
			this.settings = {
				...this.settings,
				clientKey: generateClientKey(),
			};
			await this.saveSettings();
		}
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
}
