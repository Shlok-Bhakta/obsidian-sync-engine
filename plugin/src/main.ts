import {
	Editor,
	MarkdownView,
	MarkdownFileInfo,
	Modal,
	Notice,
	Plugin,
	normalizePath,
	requestUrl,
	type RequestUrlResponse,
	type TFile,
} from 'obsidian';
import {
	DEFAULT_SETTINGS,
	MyPluginSettings,
	SampleSettingTab,
} from './settings';
import { WebsocketsHelper } from './websockets/websockets';
// Remember to rename these classes and interfaces!

export default class MyPlugin extends Plugin {
	settings!: MyPluginSettings;
	ws: WebsocketsHelper | null = null;
	private isUploadingVault = false;

	async onload() {
		await this.loadSettings();

		// connect to server over ws
		this.ws = new WebsocketsHelper(this);

		this.addRibbonIcon('upload', 'Upload entire vault', () => {
			void this.uploadEntireVaultToServer();
		});
		
		// on type push entire file to server
		this.registerEvent(
			this.app.workspace.on('editor-change', (editor, info) => {
				const file = info.file;
				if (!file) {
					return;
				}

				void this.uploadEditorFile(editor, file);
			}),
		);

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
			void this.ws.close();
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

	private async uploadEntireVaultToServer(): Promise<void> {
		if (this.isUploadingVault) {
			new Notice('Vault upload is already running');
			return;
		}

		this.isUploadingVault = true;

		try {
			const files = await this.listVaultFiles('');
			let uploaded = 0;
			let failed = 0;
			const concurrency = 8;

			new Notice(`Uploading ${files.length} vault files to server`);

			let nextIndex = 0;
			const uploadWorker = async () => {
				while (nextIndex < files.length) {
					const filePath = files[nextIndex];
					nextIndex += 1;

					if (filePath === undefined) {
						continue;
					}

					try {
						await this.uploadVaultFile(filePath);
						uploaded += 1;
					} catch (error) {
						failed += 1;
						console.error(`Failed to upload ${filePath}`, error);
					}
				}
			};

			const workerCount = Math.min(concurrency, files.length);
			await Promise.all(
				Array.from({ length: workerCount }, () => uploadWorker()),
			);

			new Notice(
				`Vault upload finished: ${uploaded} uploaded, ${failed} failed`,
			);
		} catch (error) {
			console.error('Vault upload failed', error);
			new Notice('Vault upload failed: ' + this.formatError(error));
		} finally {
			this.isUploadingVault = false;
		}
	}

	private async listVaultFiles(folderPath: string): Promise<string[]> {
		const listedFiles = await this.app.vault.adapter.list(folderPath);
		const nestedFiles = await Promise.all(
			listedFiles.folders.map((childFolderPath) =>
				this.listVaultFiles(childFolderPath),
			),
		);

		return [...listedFiles.files, ...nestedFiles.flat()];
	}

	private async uploadVaultFile(filePath: string): Promise<void> {
		const body = await this.app.vault.adapter.readBinary(filePath);
		const response = await requestUrl({
			url: this.settings.serverUrl + '/files',
			method: 'POST',
			contentType: 'application/octet-stream',
			headers: {
				'X-Obsidian-Path': encodeURIComponent(filePath),
			},
			body,
			throw: false,
		});

		if (response.status >= 400) {
			throw new Error(
				`Server returned ${response.status}: ${response.text}`,
			);
		}
	}

	private async uploadEditorFile(editor: Editor, file: TFile): Promise<void> {
		try {
			const response = await requestUrl({
				url: this.settings.serverUrl + '/files',
				method: 'POST',
				contentType: 'application/octet-stream',
				headers: {
					'X-Obsidian-Path': encodeURIComponent(file.path),
				},
				body: editor.getValue(),
				throw: false,
			});

			if (response.status >= 400) {
				throw new Error(
					`Server returned ${response.status}: ${response.text}`,
				);
			}

			await this.writeSyncMetadata(file, this.getUploadId(response));
		} catch (error) {
			console.error(`Failed to sync ${file.path}`, error);
			new Notice(`Failed to sync ${file.path}: ${this.formatError(error)}`);
		}
	}

	private getUploadId(response: RequestUrlResponse): string {
		const payload: unknown = response.json;
		const id =
			typeof payload === 'object' && payload !== null && 'id' in payload
				? payload.id
				: undefined;
		if (typeof id === 'string' && id.length > 0) {
			return id;
		}

		throw new Error('Server response did not include an upload id');
	}

	private async writeSyncMetadata(file: TFile, id: string): Promise<void> {
		const metadataDir = normalizePath(
			`${this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`}/sync-metadata`,
		);
		await this.ensureFolder(metadataDir);

		const metadataPath = normalizePath(
			`${metadataDir}/${file.path.replace(/[\\/]/g, '__')}.json`,
		);
		await this.app.vault.adapter.write(
			metadataPath,
			JSON.stringify(
				{
					id,
					path: file.path,
					timestamp: new Date().toISOString(),
				},
				null,
				2,
			),
		);
	}

	private async ensureFolder(path: string): Promise<void> {
		if (await this.app.vault.adapter.exists(path)) {
			return;
		}

		try {
			await this.app.vault.adapter.mkdir(path);
		} catch (error) {
			if (!(await this.app.vault.adapter.exists(path))) {
				throw error;
			}
		}
	}

	private formatError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
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
