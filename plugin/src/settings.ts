import {App, PluginSettingTab, Setting} from "obsidian";
import SyncEngine from "./main";

export interface SyncEngineSettings {
	backendUrl: string;
}

export const DEFAULT_SETTINGS: SyncEngineSettings = {
	backendUrl: 'http://localhost:3000'
}

export class SyncEngineSettingTab extends PluginSettingTab {
	plugin: SyncEngine;

	constructor(app: App, plugin: SyncEngine) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('Backend URL')
			.setDesc('The URL of the server that will be used to sync the files')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.backendUrl)
				.setValue(this.plugin.settings.backendUrl)
					.onChange(async (value) => {
						this.plugin.settings.backendUrl = value;
						await this.plugin.saveSettings();
						this.plugin.updateWorkerBackendUrl();
					}));
	}
}
