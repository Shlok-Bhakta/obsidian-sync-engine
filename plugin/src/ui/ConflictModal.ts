import { App, Modal, Setting } from "obsidian";
import type { ConflictRecord } from "../sync/MetadataStore";

export type ConflictChoice = "local" | "remote";

export class ConflictModal extends Modal {
  private choices = new Map<string, ConflictChoice>();
  private submitted = false;

  constructor(
    app: App,
    private readonly records: readonly ConflictRecord[],
    private readonly onSubmit: (choices: Map<string, ConflictChoice>) => Promise<void>,
  ) { super(app); }

  onOpen(): void {
    this.titleEl.setText("Resolve sync conflicts");
    this.contentEl.createEl("p", { text: "Sync is paused. Choose which version becomes authoritative for each item." });
    const controls = new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("Use local for all").onClick(() => { this.setAll("local"); this.onOpenAgain(); }))
      .addButton((button) => button.setButtonText("Use remote for all").onClick(() => { this.setAll("remote"); this.onOpenAgain(); }));
    controls.settingEl.addClass("obsidian-sync-conflict-controls");

    for (const record of this.records) {
      const conflict = record.conflict;
      new Setting(this.contentEl)
        .setName(conflict.currentPath ?? conflict.path)
        .setDesc(`${conflict.code.replaceAll("_", " ").toLowerCase()} at server revision ${conflict.currentRevision}`)
        .addDropdown((dropdown) => dropdown
          .addOption("", "Choose…")
          .addOption("local", "Use local")
          .addOption("remote", "Use remote")
          .setValue(this.choices.get(record.localMutation.mutationId) ?? "")
          .onChange((value) => {
            if (value === "local" || value === "remote") this.choices.set(record.localMutation.mutationId, value);
            else this.choices.delete(record.localMutation.mutationId);
          }));
    }
    new Setting(this.contentEl).addButton((button) => button
      .setButtonText("Apply choices").setCta().onClick(async () => {
        if (this.choices.size !== this.records.length) return;
        this.submitted = true;
        button.setDisabled(true);
        try { await this.onSubmit(new Map(this.choices)); this.close(); }
        catch {
          this.submitted = false;
          this.choices.clear();
          button.setDisabled(false);
          this.onOpenAgain();
        }
      }));
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) this.choices.clear();
  }

  private setAll(choice: ConflictChoice): void {
    for (const record of this.records) this.choices.set(record.localMutation.mutationId, choice);
  }

  private onOpenAgain(): void { this.contentEl.empty(); this.onOpen(); }
}
