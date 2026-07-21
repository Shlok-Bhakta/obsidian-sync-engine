export type SyncState = "offline" | "syncing" | "conflict" | "up-to-date" | "error";

export class SyncStatus {
  private state: SyncState = "offline";
  private revision = "0";
  private listeners = new Set<() => void>();

  constructor(private readonly element: HTMLElement) { this.render(); }
  get current(): SyncState { return this.state; }
  get lastRevision(): string { return this.revision; }

  set(state: SyncState, revision = this.revision): void {
    this.state = state;
    this.revision = revision;
    this.render();
    for (const listener of this.listeners) listener();
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private render(): void {
    const labels: Record<SyncState, string> = {
      offline: "Sync: offline", syncing: "Sync: syncing…", conflict: "Sync: conflicts", "up-to-date": "Sync: up to date", error: "Sync: attention needed",
    };
    this.element.setText(labels[this.state]);
    this.element.className = `obsidian-sync-status obsidian-sync-status--${this.state}`;
    this.element.setAttr("aria-label", `${labels[this.state]}; revision ${this.revision}`);
  }
}
