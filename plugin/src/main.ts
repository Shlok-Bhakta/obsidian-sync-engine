import {
	Editor,
	MarkdownView,
	MarkdownFileInfo,
	Modal,
	Notice,
	Plugin,
} from 'obsidian';
import {
	DEFAULT_SETTINGS,
	MyPluginSettings,
	SampleSettingTab,
} from './settings';
import { deserialize, Message, MessageType, PROTOCOL_VERSION, serialize } from 'obsidian-sync-protocol';
// Remember to rename these classes and interfaces!

export default class MyPlugin extends Plugin {
	settings!: MyPluginSettings;
	ws: WebSocket | null = null;

	async onload() {
		await this.loadSettings();

		// connect to server over ws
		let socketUrl = this.settings.serverUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws?version=' + PROTOCOL_VERSION;
		this.ws = new WebSocket(socketUrl);
		

		this.ws.onopen = () => {
			console.log('Connected to server');
			if(this.ws){
				let message: Message = {
					type: MessageType.AUTH_ACK,
					client_name: this.settings.clientName,
					token: this.settings.clientSecret
				};
				this.ws.send(serialize(message));
			}
		};

		// // This creates an icon in the left ribbon.
		this.addRibbonIcon('dice', 'Sample', (_evt: MouseEvent) => {
			// Called when the user clicks the icon.
			if(this.ws){
				let message: Message = {
					type: MessageType.MESSAGE,
					payload: 'Hello from Obsidian'
				};
				this.ws.send(
					serialize(message)
				);
			}
		});

		this.ws.onmessage = async (event) => {
			console.log(event.data);
			const data = deserialize(event.data.toString());
			switch(data.type){
				case MessageType.AUTH_INIT:
					this.settings.clientSecret = data.token;
					await this.saveSettings();
					break;
				case MessageType.AUTH_SUCCESS:
					console.log('Authenticated');
					break;
				case MessageType.AUTH_FAILED:
					new Notice(data.reason);
					break;
				case MessageType.MESSAGE:
					new Notice(data.payload);
					break;
				case MessageType.ERROR:
					new Notice(data.reason);
					break;
			}
		};
		this.ws.onclose = () => {
			console.log('Disconnected from server');
		};
		this.ws.onerror = (error) => {
			console.error('Error: ', error);
		};

		// // This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		// const statusBarItemEl = this.addStatusBarItem();
		// statusBarItemEl.setText('Status bar text');

		// // This adds a simple command that can be triggered anywhere
		// this.addCommand({
		// 	id: 'open-modal-simple',
		// 	name: 'Open modal (simple)',
		// 	callback: () => {
		// 		new SampleModal(this.app).open();
		// 	},
		// });
		// // This adds an editor command that can perform some operation on the current editor instance
		// this.addCommand({
		// 	id: 'replace-selected',
		// 	name: 'Replace selected content',
		// 	editorCallback: (
		// 		editor: Editor,
		// 		_ctx: MarkdownView | MarkdownFileInfo,
		// 	) => {
		// 		editor.replaceSelection('Sample editor command');
		// 	},
		// });
		// // This adds a complex command that can check whether the current state of the app allows execution of the command
		// this.addCommand({
		// 	id: 'open-modal-complex',
		// 	name: 'Open modal (complex)',
		// 	checkCallback: (checking: boolean) => {
		// 		// Conditions to check
		// 		const markdownView =
		// 			this.app.workspace.getActiveViewOfType(MarkdownView);
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
		// 	},
		// });

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		// this.registerDomEvent(activeDocument, 'click', (_evt: MouseEvent) => {
		// 	new Notice('Click');
		// });

		// // When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		// this.registerInterval(
		// 	window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000),
		// );
	}

	onunload() {
		if(this.ws){
			this.ws.close();
			this.ws = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MyPluginSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class SampleModal extends Modal {
	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
