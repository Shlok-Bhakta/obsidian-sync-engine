import { Platform, setIcon } from "obsidian";
import type ObsidianSyncPlugin from "../main";
import type { SyncEngine } from "../sync/engine";
import type { VaultSync } from "../vaultSync";
import {
	formatShortRelativeTime,
	ManualSyncCoordinator,
	type SyncControlSnapshot,
} from "./syncStatusState";

const RELATIVE_TIME_REFRESH_MS = 10_000;

export class SyncStatusControl {
	private readonly button: HTMLButtonElement;
	private readonly unsubscribe: () => void;
	private readonly manualSync: ManualSyncCoordinator;

	private constructor(
		private readonly plugin: ObsidianSyncPlugin,
		private readonly sync: VaultSync,
		container: HTMLElement,
	) {
		container.addClass("obsidian-sync-status-control-container");
		this.button = container.createEl("button", {
			cls: "obsidian-sync-status-control",
			type: "button",
		});
		this.manualSync = new ManualSyncCoordinator(sync.status);
		this.unsubscribe = sync.status.subscribe((state) => this.render(state));
		plugin.registerDomEvent(this.button, "click", () => {
			void this.requestManualSync();
		});
		plugin.registerInterval(
			window.setInterval(
				() => this.render(this.sync.status.get()),
				RELATIVE_TIME_REFRESH_MS,
			),
		);
		plugin.register(() => this.destroy());
	}

	static create(
		plugin: ObsidianSyncPlugin,
		sync: VaultSync,
	): SyncStatusControl | null {
		if (!Platform.isDesktopApp) return null;
		return new SyncStatusControl(plugin, sync, plugin.addStatusBarItem());
	}

	destroy(): void {
		this.unsubscribe();
	}

	private async requestManualSync(): Promise<void> {
		const engine: SyncEngine = this.sync.engine;
		await this.manualSync.request(engine);
	}

	private render(state: Readonly<SyncControlSnapshot>): void {
		this.button.empty();
		this.button.toggleClass("obsidian-sync-status-control--error", state.lastError !== null);
		if (state.manualInboxRequestInFlight) {
			const spinner = this.button.createSpan({
				cls: "obsidian-sync-status-control__spinner",
			});
			setIcon(spinner, "loader-circle");
		} else {
			this.renderCount("arrow-up", state.outboxDepth);
			this.renderCount("arrow-down", state.inboxDepth);
		}

		const action = "Activate to sync now.";
		const errorDescription = state.lastError
			? ` Sync error: ${state.lastError}.`
			: "";
		this.button.setAttribute(
			"aria-label",
			`Outbox queue: ${state.outboxDepth}. Inbox queue: ${state.inboxDepth}.${errorDescription} ${action}`,
		);
		this.button.title = state.lastError
			? `${state.lastError}\nCheck the console for details.`
			: `Revision: ${this.plugin.settings.revision}\nSynced: ${formatShortRelativeTime(state.lastSuccessfulSyncAt)}`;
	}

	private renderCount(icon: string, count: number): void {
		const indicator = this.button.createSpan({
			cls: "obsidian-sync-status-control__indicator",
		});
		const iconElement = indicator.createSpan({
			cls: "obsidian-sync-status-control__icon",
		});
		setIcon(iconElement, icon);
		indicator.createSpan({ text: String(count) });
	}
}
