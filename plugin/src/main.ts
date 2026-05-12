import {App, Editor, MarkdownFileInfo, MarkdownView, Modal, Notice, Plugin, TFile} from 'obsidian';
import {DEFAULT_SETTINGS, SyncEngineSettings, SyncEngineSettingTab} from "./settings";
import { yDb } from 'db/db';
import { EditorView, ViewUpdate } from "@codemirror/view";
import { outboxData, Path } from "../../shared/types";
import { DocSync } from 'yjs/DocSync';
// @ts-expect-error esbuild-plugin-inline-worker turns this worker entry into a Worker factory.
import createSyncWorker from "./worker/SyncWorker.worker";

// Remember to rename these classes and interfaces!


export default class SyncEngine extends Plugin {
	settings: SyncEngineSettings;
	db: yDb;
	docs: Map<Path, DocSync>;
	syncWorker: Worker;
	async onload() {
		await this.loadSettings();
		this.db = new yDb();
		this.docs = new Map<Path, DocSync>();
		await this.db.open();
		this.syncWorker = createSyncWorker();
		this.syncWorker.onmessage = (event) => {
			console.log("worker msg", event.data);
			if (event.data.type === "ready") {
				this.syncWorker.postMessage({ type: "start" });
			}
		};
		this.syncWorker.onerror = (event) => {
			console.error("worker failed", event.message);
		};
		// send init wait for ready
		this.syncWorker.postMessage({ type: "init", serverurl: this.settings.backendUrl });
		

		
		// // This creates an icon in the left ribbon.
		// this.addRibbonIcon('dice', 'Sample', (evt: MouseEvent) => {
		// 	// Called when the user clicks the icon.
		// 	// try to call the backend API here
		// 	fetch(this.settings.backendUrl + "health").then(async data => {
		// 		new Notice('Response: ' + await data.text());
		// 	}).catch(error => {
		// 		new Notice('Error: ' + error.message);
		// 	})
		// });

		// // This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		// const statusBarItemEl = this.addStatusBarItem();
		// statusBarItemEl.setText('Status bar text');

		// // This adds a simple command that can be triggered anywhere
		// this.addCommand({
		// 	id: 'open-modal-simple',
		// 	name: 'Open modal (simple)',
		// 	callback: () => {
		// 		new SampleModal(this.app).open();
		// 	}
		// });
		// // This adds an editor command that can perform some operation on the current editor instance
		// this.addCommand({
		// 	id: 'replace-selected',
		// 	name: 'Replace selected content',
		// 	editorCallback: (editor: Editor, view: MarkdownView) => {
		// 		editor.replaceSelection('Sample editor command');
		// 	}
		// });
		// // This adds a complex command that can check whether the current state of the app allows execution of the command
		// this.addCommand({
		// 	id: 'open-modal-complex',
		// 	name: 'Open modal (complex)',
		// 	checkCallback: (checking: boolean) => {
		// 		// Conditions to check
		// 		const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		// 		if (markdownView) {
		// 			// If checking is true, we're simply "checking" if the command can be run.
		// 			// If checking is false, then we want to actually perform the operation.
		// 			if (!checking) {
		// 				new SampleModal(this.app).open();
		// 			}

		// 			// This command will only show up in Command Palette when the check function returns true
		// 			return true;
		// 		}
		// 		return false;
		// 	}
		// });

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SyncEngineSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		// this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
		// 	new Notice("Click");
		// });

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		// this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
		

		// // try out getting the content
		// this.registerEvent(
		// 	this.app.workspace.on('editor-change', (editor: Editor, info: MarkdownFileInfo) => {
		// 		new Notice('Editor changed: ' + editor.getDoc());
		// 	}))
		// );
		
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
						console.log("new doc");
						doc = this.newDoc(pathID, update.startState.doc.toString());
					}
					let row: outboxData = {
						fileId: pathID,
						operation: "Update",
						data: new Uint8Array(),
						created: Date.now()
					}
					doc.applyChanges(update.changes, row);
					this.syncWorker.postMessage({ type: "wake" });
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
				console.log("evicting " + oldestpath);
				this.docs.get(oldestpath)?.destroy();
				this.docs.delete(oldestpath);
			}
		}
		let dsync = new DocSync(this.db, initialContent);
		this.docs.set(pathID, dsync);
		return dsync
	}

	onunload() {
		this.syncWorker?.terminate();
		this.db.close();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<SyncEngineSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		let {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}
