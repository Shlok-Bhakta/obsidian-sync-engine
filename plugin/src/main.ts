import { Modal, Notice, Plugin, type WorkspaceLeaf } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	MyPluginSettings,
	SampleSettingTab,
} from './settings';
import { SyncStatusView, SYNC_STATUS_VIEW_TYPE } from './ui/syncStatusView';
import {
	registerVaultSync,
	seedServerFromVault,
	type VaultSync,
} from './vaultSync';
// Remember to rename these classes and interfaces!

export default class MyPlugin extends Plugin {
	settings!: MyPluginSettings;
	sync!: VaultSync;
	private isSeeding = false;

	async onload() {
		await this.loadSettings();

		this.sync = registerVaultSync(this);

		this.registerView(
			SYNC_STATUS_VIEW_TYPE,
			(leaf) => new SyncStatusView(leaf, this, this.sync),
		);

		this.addRibbonIcon('upload', 'Seed server from this vault', () => {
			void this.seedFromVault();
		});
		this.addRibbonIcon('refresh-cw', 'Open sync status', () => {
			void this.openSyncStatusView();
		});

		this.addCommand({
			id: 'seed-server-from-vault',
			name: 'Seed server from this vault',
			callback: () => void this.seedFromVault(),
		});
		this.addCommand({
			id: 'open-sync-status',
			name: 'Open sync status',
			callback: () => void this.openSyncStatusView(),
		});

		this.addSettingTab(new SampleSettingTab(this.app, this));
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MyPluginSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** Enqueues every file currently in the vault and pushes them out. Used for first-time bootstrap. */
	async seedFromVault(): Promise<void> {
		if (this.isSeeding) {
			new Notice('Seeding is already running');
			return;
		}

		this.isSeeding = true;
		try {
			new Notice('Seeding server from this vault…');
			await seedServerFromVault(this, this.sync);
			new Notice('Vault seeded');
		} catch (error) {
			console.error('Seeding server from vault failed', error);
			new Notice('Seeding failed: ' + this.formatError(error));
		} finally {
			this.isSeeding = false;
		}
	}

	async openSyncStatusView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(SYNC_STATUS_VIEW_TYPE);
		const leaf: WorkspaceLeaf =
			existing[0] ?? this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		if (existing.length === 0) {
			await leaf.setViewState({ type: SYNC_STATUS_VIEW_TYPE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	private formatError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

class SampleModal extends Modal {
	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
