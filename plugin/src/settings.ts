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
	private unsubscribeBootstrapStatus: (() => void) | null = null;

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

		this.unsubscribeBootstrapStatus?.();
		this.unsubscribeBootstrapStatus = null;
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

		const bootstrapStatusEl = containerEl.createEl("div");
		bootstrapStatusEl.setCssStyles({
			marginTop: "12px",
			color: "var(--text-muted)",
		});

		const renderBootstrapStatus = () => {
			const status = this.plugin.bootstrapStatus;
			bootstrapStatusEl.empty();
			if (!status) {
				return;
			}
			if (status.status === "building") {
				bootstrapStatusEl.createDiv({
					cls: "sync-engine-bootstrap-status",
					text: status.message ?? "Building vault zip...",
				});
			} else if (status.status === "ready" && status.downloadUrl) {
				const seconds = Math.max(0, Math.ceil((status.remainingMs ?? 0) / 1000));
				const panel = bootstrapStatusEl.createDiv({ cls: "sync-engine-bootstrap-link" });
				panel.createDiv({
					cls: "sync-engine-bootstrap-link__meta",
					text: `Vault link ready. Expires in ${seconds}s.`,
				});
				const row = panel.createDiv({ cls: "sync-engine-bootstrap-link__row" });
				const input = row.createEl("input", {
					type: "text",
					value: status.downloadUrl,
				});
				input.readOnly = true;
				input.addEventListener("focus", () => input.select());
				const copyButton = row.createEl("button", {
					cls: "mod-cta",
					text: "Copy",
				});
				copyButton.addEventListener("click", async () => {
					try {
						await navigator.clipboard.writeText(status.downloadUrl!);
						new Notice("Vault link copied");
					} catch (error) {
						input.select();
						new Notice("Could not copy automatically. Link selected.");
					}
				});
				panel.createEl("a", {
					cls: "sync-engine-bootstrap-link__open",
					text: "Open download link",
					href: status.downloadUrl,
				});
			} else if (status.status === "downloaded") {
				bootstrapStatusEl.createDiv({
					cls: "sync-engine-bootstrap-status sync-engine-bootstrap-status--success",
					text: "Vault link downloaded.",
				});
			} else if (status.status === "expired") {
				bootstrapStatusEl.createDiv({
					cls: "sync-engine-bootstrap-status",
					text: "Vault link expired.",
				});
			} else if (status.status === "failed") {
				bootstrapStatusEl.createDiv({
					cls: "sync-engine-bootstrap-status sync-engine-bootstrap-status--error",
					text: `Vault link failed: ${status.message ?? "Unknown error"}`,
				});
			}
		};

		new Setting(containerEl)
			.setName("Bootstrap vault")
			.setDesc("Generate a one-time zip link for setting up another device.")
			.addButton(button => {
				button
					.setButtonText("Generate vault link")
					.setTooltip("Generate vault link")
					.onClick(async () => {
						try {
							await this.plugin.generateVaultLink();
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							new Notice(`Vault link failed: ${message}`);
						}
					});
			});
		this.unsubscribeBootstrapStatus = this.plugin.subscribeBootstrapStatus(renderBootstrapStatus);
		renderBootstrapStatus();

		refresh();
	}

	hide(): void {
		this.unsubscribeBootstrapStatus?.();
		this.unsubscribeBootstrapStatus = null;
		if (this.hasUnsavedChanges) {
			new Notice("Make sure to save");
		}
		super.hide();
	}
}
