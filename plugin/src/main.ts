import { Plugin } from 'obsidian';
import {DEFAULT_SETTINGS, SyncEngineSettings, SyncEngineSettingTab} from "./settings";
import { JsonlOutboxStore, OutboxStore } from 'db/db';
import { EditorView, ViewUpdate } from "@codemirror/view";
import { outboxData, Path } from "../../shared/types";
import { DocSync } from 'yjs/DocSync';
import { SyncClient } from 'sync/SyncClient';

function generateClientKey(): string {
	return "obs_sync_" + crypto.randomUUID();
}

export default class SyncEngine extends Plugin {
	settings: SyncEngineSettings;
	db: OutboxStore;
	docs: Map<Path, DocSync>;
	syncClient: SyncClient;
	async onload() {
		await this.loadSettings();
		this.db = new JsonlOutboxStore(this.app, this.manifest);
		this.docs = new Map<Path, DocSync>();
		await this.db.open();
		this.syncClient = new SyncClient(this.db, this.settings, async (clientKey) => {
			this.settings = {
				...this.settings,
				clientKey,
			};
			await this.saveSettings();
		});
		this.app.workspace.onLayoutReady(() => {
			this.syncClient.start();
		});

		this.addSettingTab(new SyncEngineSettingTab(this.app, this));
		this.registerEditorExtension(this.makeEditorOutboxExtension());
	}

	private makeEditorOutboxExtension(){
		return EditorView.updateListener.of((update: ViewUpdate) => {
			if(update){
				if (update.docChanged) {
					let file = this.app.workspace.getActiveFile();
					if(!file){
						return;
					}
					let pathID = file.path;
					let doc = this.docs.get(pathID);
					if(!doc){
						console.debug("new doc");
						doc = this.newDoc(pathID, update.startState.doc.toString());
					}
					let row: outboxData = {
						fileId: pathID,
						operation: "Update",
						data: new Uint8Array(),
						created: Date.now()
					}
					doc.applyChanges(update.changes, row);
					this.syncClient.wakeSoon();
				}
			}
		})
	}

	private newDoc(pathID : Path, initialContent: string): DocSync{
		// 10 is a random ahh number I picked. This is so opening 50 docs in a session doesnt eat all the ram of 50 y.Doc() objects
		if(this.docs.size > 10){
			let mintime = Infinity;
			let oldestpath: Path | null = null;
			for(let [path, doc] of this.docs){
				if(doc.getTimeOpened() < mintime){
					mintime = doc.getTimeOpened();
					oldestpath = path;
				}
			}
			if(oldestpath){
				console.debug("evicting " + oldestpath);
				this.docs.get(oldestpath)?.destroy();
				this.docs.delete(oldestpath);
			}
		}
		let dsync = new DocSync(this.db, initialContent);
		this.docs.set(pathID, dsync);
		return dsync
	}

	onunload() {
		this.syncClient?.stop();
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
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	updateSyncSettings() {
		this.syncClient?.updateSettings(this.settings);
	}
}
