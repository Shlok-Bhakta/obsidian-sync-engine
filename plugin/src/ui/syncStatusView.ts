import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type MyPlugin from '../main';
import { list as listOutbox } from '../sync/outbox';
import type { VaultSync } from '../vaultSync';

export const SYNC_STATUS_VIEW_TYPE = 'obsidian-sync-engine-status';

const TICK_REFRESH_MS = 3000;

/** Minimal read-only view of sync health: revision, pending outbox depth, last tick. */
export class SyncStatusView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: MyPlugin,
		private readonly sync: VaultSync,
	) {
		super(leaf);
	}

	getViewType(): string {
		return SYNC_STATUS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Sync status';
	}

	getIcon(): string {
		return 'refresh-cw';
	}

	async onOpen(): Promise<void> {
		await this.render();
		this.registerInterval(
			window.setInterval(() => void this.render(), TICK_REFRESH_MS),
		);
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const outboxOps = await listOutbox(this.sync.fs, this.sync.outboxPath).catch(
			() => [],
		);
		const { status } = this.sync;

		const container = this.contentEl;
		container.empty();
		container.addClass('obsidian-sync-status-view');
		container.createEl('h4', { text: 'Sync status' });

		const list = container.createEl('ul');
		list.createEl('li', {
			text: `Revision: ${this.plugin.settings.revision}`,
		});
		list.createEl('li', {
			text: `Pending outbox items: ${outboxOps.length}`,
		});
		list.createEl('li', {
			text: `Last tick: ${
				status.lastTickAt
					? new Date(status.lastTickAt).toLocaleTimeString()
					: 'never'
			}`,
		});
		if (status.lastError) {
			list.createEl('li', { text: `Last error: ${status.lastError}` });
		}
	}
}
