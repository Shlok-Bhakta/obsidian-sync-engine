import {App, Notice, PluginSettingTab, Setting} from "obsidian";
import SyncEngine from "./main";

export interface SyncEngineSettings {
	backendUrl: string;
	clientId: string;
	clientKey: string;
	clientName: string;
	lastPulledRevision: string;
}

export const DEFAULT_SETTINGS: SyncEngineSettings = {
	backendUrl: 'http://localhost:3000',
	clientId: '',
	clientKey: 'To Be Generated',
	clientName: 'Obsidian',
	lastPulledRevision: '0',
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
			// clientId and lastPulledRevision are server/sync-managed; exclude from dirty check
			// so background sync cannot make the tab look dirty or roll back on save.
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
			.setName("Client ID")
			.setDesc("Stable identity for this vault on the sync server.")
			.addText(text => text
				.setValue(this.plugin.settings.clientId)
				.setDisabled(true));

		new Setting(containerEl)
			.setName("Last pulled revision")
			.setDesc("Last server revision applied locally.")
			.addText(text => text
				.setValue(this.plugin.settings.lastPulledRevision)
				.setDisabled(true));

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

						this.plugin.settings = {
							...this.pendingSettings,
							clientId: this.plugin.settings.clientId,
							lastPulledRevision: this.plugin.settings.lastPulledRevision,
						};
						await this.plugin.saveSettings();
						this.plugin.updateSyncSettings();

						this.pendingSettings = {...this.plugin.settings};
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
