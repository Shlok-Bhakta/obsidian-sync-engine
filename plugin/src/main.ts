import { Notice, Plugin, type WorkspaceLeaf } from 'obsidian';
import { ensureAuthenticated } from './auth';
import {
	DEFAULT_SETTINGS,
	ObsidianSyncSettings,
	SyncSettingTab,
	normalizeServerUrl,
	serverIdentityFor,
} from './settings';
import { SyncStatusView, SYNC_STATUS_VIEW_TYPE } from './ui/syncStatusView';
import {
	registerVaultSync,
	seedServerFromVault,
	type VaultSync,
} from './vaultSync';

export default class ObsidianSyncPlugin extends Plugin {
	settings!: ObsidianSyncSettings;
	sync!: VaultSync;
	private isSeeding = false;

	async onload() {
		await this.loadSettings();

		this.sync = registerVaultSync(this);

		this.registerView(
			SYNC_STATUS_VIEW_TYPE,
			(leaf) => new SyncStatusView(leaf, this, this.sync),
		);

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
		this.addCommand({
			id: 'authenticate-with-server',
			name: 'Authenticate with server',
			callback: () => void this.authenticate(),
		});

		this.addSettingTab(new SyncSettingTab(this.app, this));

		// Best-effort: obtain / verify credentials once the plugin is up so a
		// fresh install does not sit on the placeholder secret forever.
		if (this.settings.serverUrl && !this.settings.serverUrl.includes('...')) {
			void this.authenticate().catch((error) => {
				console.warn('Initial auth failed', error);
			});
		}
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<ObsidianSyncSettings>;
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			loaded,
		);
		this.settings.serverUrl = normalizeServerUrl(this.settings.serverUrl);
		if (!loaded.serverIdentity) {
			this.settings.serverIdentity = serverIdentityFor(this.settings.serverUrl);
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async changeServerUrl(value: string): Promise<void> {
		const serverUrl = normalizeServerUrl(value);
		const identity = serverIdentityFor(serverUrl);
		if (identity !== this.settings.serverIdentity) {
			this.settings.revision = 0;
			this.settings.clientSecret = DEFAULT_SETTINGS.clientSecret;
			this.settings.serverIdentity = identity;
			new Notice("Server changed. Reload Obsidian before pairing; sync state is isolated per server.");
		}
		this.settings.serverUrl = serverUrl;
		await this.saveSettings();
	}

	async authenticate(): Promise<void> {
		try {
			await ensureAuthenticated(this);
			new Notice('Authenticated with sync server');
		} catch (error) {
			console.error('Authentication failed', error);
			new Notice('Authentication failed: ' + this.formatError(error));
			throw error;
		}
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
			await ensureAuthenticated(this);
			const result = await seedServerFromVault(this, this.sync);
			if (!result.ok) {
				throw new Error(result.error);
			}
			new Notice('Vault seeded');
		} catch (error) {
			console.error('Seeding server from vault failed', error);
			new Notice('Seeding failed: ' + this.formatError(error));
			throw error;
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
