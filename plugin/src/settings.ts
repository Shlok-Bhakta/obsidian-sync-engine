import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type { Revision } from "obsidian-sync-protocol";
import type ObsidianSyncPlugin from "./main";

export interface SyncPluginSettings {
  serverUrl: string;
  clientName: string;
  clientId: string;
  clientSecret: string;
  revision: Revision;
  vaultId: string;
  snapshotRevision?: Revision;
  bootstrapStatus?: string;
  bootstrapUrl?: string;
  bootstrapExpiresAt?: string;
}

export const DEFAULT_SETTINGS: SyncPluginSettings = {
  serverUrl: "",
  clientName: "Main computer",
  clientId: "",
  clientSecret: "",
  revision: "0",
  vaultId: "",
};

export class SyncSettingTab extends PluginSettingTab {
  private countdownTimer: number | null = null;
  constructor(app: App, readonly plugin: ObsidianSyncPlugin) { super(app, plugin); }

  display(): void {
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
    const { containerEl } = this;
    containerEl.empty();
    const warning = activeDocument.createDocumentFragment();
    warning.appendText("HTTP carries encrypted-in-transit vault data only when the server uses HTTPS.");
    if (this.plugin.settings.serverUrl.startsWith("http://")) warning.createEl("div", { cls: "obsidian-sync-server-url-warning", text: "Warning: credentials and vault contents are exposed on untrusted networks over HTTP." });
    new Setting(containerEl).setName("Server URL").setDesc(warning).addText((text) => text
      .setPlaceholder("https://sync.example.com")
      .setValue(this.plugin.settings.serverUrl)
      .onChange(async (value) => { this.plugin.settings.serverUrl = value.trim().replace(/\/$/, ""); await this.plugin.saveSettings(); }));

    let pendingClientName = this.plugin.settings.clientName;
    new Setting(containerEl).setName("Client name").setDesc("A unique readable name shown to other clients.").addText((text) => text
      .setValue(this.plugin.settings.clientName)
      .onChange((value) => { pendingClientName = value.trim(); }))
      .addButton((button) => button.setButtonText("Update").onClick(async () => {
        try {
          this.plugin.settings.clientName = await this.plugin.coordinator.http.renameClient(pendingClientName);
          await this.plugin.saveSettings();
        } catch (error) { new Notice(`Could not update client name: ${formatError(error)}`); }
      }));

    new Setting(containerEl).setName("Client ID").setDesc("Stable identity assigned by the server.").addText((text) => text
      .setValue(this.plugin.settings.clientId || "Not registered").setDisabled(true));

    new Setting(containerEl).setName("Client secret").setDesc("Keep this bearer credential private.")
      .addText((text) => { text.setValue(this.plugin.settings.clientSecret).setDisabled(true); text.inputEl.type = "password"; })
      .addButton((button) => button.setButtonText("Rotate").onClick(async () => {
        try {
          this.plugin.settings.clientSecret = await this.plugin.coordinator.http.rotateSecret();
          await this.plugin.saveSettings();
          this.display();
        } catch (error) { new Notice(`Could not rotate secret: ${formatError(error)}`); }
      }));

    new Setting(containerEl).setName("Sync state").setDesc(`${this.plugin.syncStatus.current}; last fully applied revision ${this.plugin.coordinator.metadata.revision}`)
      .addButton((button) => button.setButtonText("Retry sync").onClick(() => void this.plugin.coordinator.retry()));

    new Setting(containerEl).setName("Pending conflicts").setDesc(`${this.plugin.coordinator.metadata.conflicts.length} unresolved`)
      .addButton((button) => button.setButtonText("Resolve conflicts").setDisabled(this.plugin.coordinator.metadata.conflicts.length === 0)
        .onClick(() => this.plugin.openConflictModal()));

    new Setting(containerEl).setName("Bootstrap another client").setDesc("Captures a revision and creates a single-use download link valid for five minutes.")
      .addButton((button) => button.setButtonText("Generate bootstrap zip").setCta().onClick(async () => {
        try { await this.plugin.coordinator.generateBootstrapZip(); this.plugin.settings.bootstrapStatus = "building"; this.display(); }
        catch (error) { new Notice(formatError(error)); }
      }));

    if (this.plugin.settings.bootstrapStatus) {
      const setting = new Setting(containerEl).setName("Bootstrap status");
      const countdown = activeDocument.createElement("span");
      setting.descEl.append(countdown);
      const update = () => {
        const expiry = this.plugin.settings.bootstrapExpiresAt ? new Date(this.plugin.settings.bootstrapExpiresAt).getTime() : 0;
        const remaining = Math.max(0, expiry - Date.now());
        countdown.setText(this.plugin.settings.bootstrapStatus === "ready" ? `Ready — expires in ${Math.ceil(remaining / 1000)} seconds` : this.plugin.settings.bootstrapStatus ?? "");
      };
      update();
      this.countdownTimer = window.setInterval(update, 1000);
      if (this.plugin.settings.bootstrapUrl) {
        const bootstrapUrl = this.plugin.settings.bootstrapUrl;
        setting.addButton((button) => button.setButtonText("Copy link").onClick(async () => { await navigator.clipboard.writeText(bootstrapUrl); }))
          .addButton((button) => button.setButtonText("Open").onClick(() => window.open(bootstrapUrl, "_blank")));
      }
    }
  }

  hide(): void {
    if (this.countdownTimer !== null) window.clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  }
}

function formatError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
