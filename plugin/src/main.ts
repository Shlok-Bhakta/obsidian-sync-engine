import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, SyncSettingTab, type SyncPluginSettings } from "./settings";
import { SyncCoordinator } from "./sync/SyncCoordinator";
import { ConflictModal } from "./ui/ConflictModal";
import { SyncStatus } from "./ui/SyncStatus";
import { presenceExtension } from "./presence/PresenceExtension";

export default class ObsidianSyncPlugin extends Plugin {
  settings!: SyncPluginSettings;
  coordinator!: SyncCoordinator;
  syncStatus!: SyncStatus;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.syncStatus = new SyncStatus(this.addStatusBarItem());
    this.coordinator = new SyncCoordinator(this, this.settings, () => this.saveSettings(), this.syncStatus);
    this.addSettingTab(new SyncSettingTab(this.app, this));
    this.registerEditorExtension(presenceExtension());

    this.registerEvent(this.app.workspace.on("editor-change", (editor, info) => {
      if (info.file) void this.coordinator.handleEditorChange(editor, info.file);
    }));
    this.addCommand({ id: "retry-sync", name: "Retry sync", callback: () => void this.coordinator.retry() });
    this.addCommand({ id: "resolve-sync-conflicts", name: "Resolve sync conflicts", callback: () => this.openConflictModal() });
    this.addCommand({ id: "generate-bootstrap-zip", name: "Generate bootstrap zip", callback: () => void this.coordinator.generateBootstrapZip() });
    await this.coordinator.start();
  }

  onunload(): void { void this.coordinator?.stop(); }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<SyncPluginSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
    this.settings.revision = String(saved?.revision ?? "0");
    this.settings.vaultId ||= crypto.randomUUID();
  }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  openConflictModal(): void {
    const records = this.coordinator.metadata.conflicts;
    if (records.length === 0) return;
    new ConflictModal(this.app, records, (choices) => this.coordinator.resolveConflicts(choices)).open();
  }
}
