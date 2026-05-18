import {App, Notice, PluginSettingTab, Setting} from "obsidian";
import SyncEngine from "./main";

export interface SyncEngineSettings {
	backendUrl: string;
	clientKey: string;
	clientName: string;
}

export const DEFAULT_SETTINGS: SyncEngineSettings = {
	backendUrl: 'http://localhost:3000',
	clientKey: 'To Be Generated',
	clientName: 'Obsidian'
}

export class SyncEngineSettingTab extends PluginSettingTab {
	plugin: SyncEngine;
	private pendingSettings: SyncEngineSettings;
	private hasUnsavedChanges = false;

	constructor(app: App, plugin: SyncEngine) {
		super(app, plugin);
		this.plugin = plugin;
		this.pendingSettings = {...plugin.settings};

		this.plugin.registerDomEvent(window, "beforeunload", (event: BeforeUnloadEvent) => {
			if (this.hasUnsavedChanges) {
				event.preventDefault();
			}
		});
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		if (!this.hasUnsavedChanges) {
			this.pendingSettings = {...this.plugin.settings};
		}

		let saveButtonEl: HTMLButtonElement | null = null;
		let backendUrlWarningEl: HTMLElement | null = null;

		const refresh = () => {
			this.hasUnsavedChanges =
				this.pendingSettings.backendUrl !== this.plugin.settings.backendUrl ||
				this.pendingSettings.clientKey !== this.plugin.settings.clientKey ||
				this.pendingSettings.clientName !== this.plugin.settings.clientName;

			if (saveButtonEl) {
				saveButtonEl.setText(this.hasUnsavedChanges ? "Save settings" : "Saved");
				saveButtonEl.toggleClass("mod-warning", this.hasUnsavedChanges);
				saveButtonEl.toggleClass("mod-cta", !this.hasUnsavedChanges);
			}

			if (backendUrlWarningEl) {
				backendUrlWarningEl.toggle(!this.pendingSettings.backendUrl.trim().toLowerCase().startsWith("https://"));
			}
		};

		const backendUrlSetting = new Setting(containerEl)
			.setName('Backend URL')
			.setDesc('The URL of the server that will be used to sync the files')
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.backendUrl)
				.setValue(this.pendingSettings.backendUrl)
					.onChange((value) => {
						this.pendingSettings.backendUrl = value;
						refresh();
					}));

		backendUrlWarningEl = backendUrlSetting.descEl.createEl("div", {
			text: "This connection is not encrypted. Use a trusted vpn or private network, because data may be unencrypted and easy to intercept.",
		});
		backendUrlWarningEl.setCssStyles({
			color: "var(--text-warning)",
			marginTop: "6px",
		});
		
		new Setting(containerEl)
			.setName("Client name")
			.setDesc("This name identifies this device to the sync server.")
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.clientName)
				.setValue(this.pendingSettings.clientName)
				.onChange((value) => {
					this.pendingSettings.clientName = value;
					refresh();
				}));

		new Setting(containerEl)
			.setName("Client key")
			.setDesc("This is the key used to secure the connection.")
			.addText(text => text
				.setPlaceholder(DEFAULT_SETTINGS.clientKey)
				.setValue(this.pendingSettings.clientKey)
				.onChange((value) => {
					this.pendingSettings.clientKey = value;
					refresh();
				}));

		new Setting(containerEl)
			.addButton(button => {
				saveButtonEl = button.buttonEl;
				button
					.setButtonText(this.hasUnsavedChanges ? "Save settings" : "Saved")
					.setTooltip("Save settings")
					.onClick(async () => {
						if (!this.hasUnsavedChanges) {
							return;
						}

						this.plugin.settings = {...this.pendingSettings};
						await this.plugin.saveSettings();
						this.plugin.updateSyncSettings();

						this.hasUnsavedChanges = false;
						refresh();
					});
			});

		refresh();
	}

	hide(): void {
		if (this.hasUnsavedChanges) {
			new Notice("Make sure to save");
		}
		super.hide();
	}
}
