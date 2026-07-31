import { Notice, Plugin, requestUrl, type WorkspaceLeaf } from 'obsidian';
import { ensureAuthenticated } from './auth';
import {
	DEFAULT_SETTINGS,
	ObsidianSyncSettings,
	SyncSettingTab,
	normalizeServerUrl,
	legacyServerIdentityFor,
	resetServerCredentials,
	serverIdentityFor,
	transitionServerSettings,
} from './settings';
import { SyncStatusView, SYNC_STATUS_VIEW_TYPE } from './ui/syncStatusView';
import {
	registerVaultSync,
	seedServerFromVault,
	type VaultSync,
} from './vaultSync';
import { seedVaultIfRevisionZero } from "./sync/autoSeed";
import { migrateServerState } from "./sync/stateMigration";
import {
	requestClientInvite,
	type ClientInvite,
} from "./clientInvites";
import { createClientLogger, type Logger } from "./logger";

export default class ObsidianSyncPlugin extends Plugin {
	settings!: ObsidianSyncSettings;
	sync!: VaultSync;
	readonly logger: Logger = createClientLogger(__CLIENT_LOGGING_ENABLED__);
	private reloadRequired = false;

	async onload() {
		this.logger.info("plugin.loading", {
			version: this.manifest.version,
			vaultName: this.app.vault.getName(),
		});
		await this.loadSettings();

		this.sync = registerVaultSync(this);
		this.logger.info("plugin.sync_registered", {
			serverUrl: this.settings.serverUrl,
			serverIdentity: this.settings.serverIdentity,
			revision: this.settings.revision,
		});

		this.registerView(
			SYNC_STATUS_VIEW_TYPE,
			(leaf) => new SyncStatusView(leaf, this, this.sync),
		);

		this.addRibbonIcon('refresh-cw', 'Open sync status', () => {
			void this.openSyncStatusView();
		});

		this.addCommand({
			id: 'open-sync-status',
			name: 'Open sync status',
			callback: () => void this.openSyncStatusView(),
		});
		this.addSettingTab(new SyncSettingTab(this.app, this));

		// Best-effort: obtain / verify credentials once the plugin is up so a
		// fresh install does not sit on the placeholder secret forever.
		if (this.settings.serverUrl && !this.settings.serverUrl.includes('...')) {
			this.logger.info("plugin.initial_sync_scheduled", {
				revision: this.settings.revision,
			});
			void this.initializeSync().catch((error) => {
				this.logger.warn("plugin.initial_sync_failed", { error });
			});
		} else {
			this.logger.info("plugin.initial_sync_skipped", {
				reason: "server_url_not_configured",
			});
		}
	}

	async loadSettings() {
		this.logger.debug("settings.load_started");
		const loaded =
			((await this.loadData()) ?? {}) as Partial<ObsidianSyncSettings>;
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			loaded,
		);
		this.settings.serverUrl = normalizeServerUrl(this.settings.serverUrl);
		const nextIdentity = serverIdentityFor(this.settings.serverUrl);
		const previousIdentity = loaded.serverIdentity;
		const isLegacyIdentity =
			previousIdentity === legacyServerIdentityFor(this.settings.serverUrl);
		if (previousIdentity && previousIdentity !== nextIdentity && isLegacyIdentity) {
			this.logger.info("settings.state_migration_started", {
				previousIdentity,
				nextIdentity,
			});
			const pluginDir =
				this.manifest.dir ??
				`${this.app.vault.configDir}/plugins/${this.manifest.id}`;
			await migrateServerState(
				this.app.vault.adapter,
				`${pluginDir}/state`,
				previousIdentity,
				nextIdentity,
				this.logger,
			);
			this.logger.info("settings.state_migration_completed", {
				previousIdentity,
				nextIdentity,
			});
		} else if (
			previousIdentity &&
			previousIdentity !== nextIdentity
		) {
			this.logger.warn("settings.server_identity_changed", {
				previousIdentity,
				nextIdentity,
			});
			resetServerCredentials(
				this.settings,
				nextIdentity,
				DEFAULT_SETTINGS.clientSecret,
			);
		}
		// Recompute to migrate the legacy 32-bit identity and ensure the queue
		// namespace is derived from the exact normalized server URL.
		this.settings.serverIdentity = nextIdentity;
		if (previousIdentity !== nextIdentity) await this.saveSettings();
		this.logger.info("settings.loaded", {
			serverUrl: this.settings.serverUrl,
			serverIdentity: this.settings.serverIdentity,
			revision: this.settings.revision,
			clientName: this.settings.clientName,
			credentialsPresent:
				this.settings.clientSecret !== DEFAULT_SETTINGS.clientSecret,
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.logger.debug("settings.saved", {
			serverIdentity: this.settings.serverIdentity,
			revision: this.settings.revision,
			clientName: this.settings.clientName,
		});
	}

	async changeServerUrl(value: string): Promise<void> {
		const serverUrl = normalizeServerUrl(value);
		if (serverUrl !== this.settings.serverUrl) {
			this.logger.info("settings.server_change_started", {
				previousServerUrl: this.settings.serverUrl,
				nextServerUrl: serverUrl,
			});
			// Gate new work first, then wait for any old-server Vault mutation
			// to finish before committing the new identity and credentials.
			this.reloadRequired = true;
			await this.sync.engine.quiesce();
			transitionServerSettings(
				this.settings,
				serverUrl,
				DEFAULT_SETTINGS.clientSecret,
			);
			new Notice("Server changed. Reload Obsidian to reconnect; sync state is isolated per server.");
			this.logger.info("settings.server_change_completed", {
				serverUrl,
				serverIdentity: this.settings.serverIdentity,
			});
		}
		await this.saveSettings();
	}

	isSyncSuspended(): boolean {
		return this.reloadRequired;
	}

	async authenticate(): Promise<void> {
		if (this.reloadRequired) {
			throw new Error("Reload Obsidian before reconnecting to the new server");
		}
		try {
			this.logger.info("auth.started", {
				serverUrl: this.settings.serverUrl,
				clientName: this.settings.clientName,
			});
			await ensureAuthenticated(this);
			this.logger.info("auth.completed", {
				serverUrl: this.settings.serverUrl,
				clientName: this.settings.clientName,
			});
			new Notice('Authenticated with sync server');
		} catch (error) {
			this.logger.error("auth.failed", {
				serverUrl: this.settings.serverUrl,
				clientName: this.settings.clientName,
				error,
			});
			new Notice('Authentication failed: ' + this.formatError(error));
			throw error;
		}
	}

	private async initializeSync(): Promise<void> {
		await this.authenticate();
		this.logger.info("auto_seed.evaluating", {
			revision: this.settings.revision,
		});
		const seeded = await seedVaultIfRevisionZero(
			this.settings.revision,
			async () => {
				this.logger.info("auto_seed.started", {
					revision: this.settings.revision,
				});
				new Notice('Seeding server from this vault…');
				try {
					const result = await seedServerFromVault(this, this.sync);
					if (!result.ok) {
						throw new Error(result.error);
					}
					this.logger.info("auto_seed.completed", {
						pushed: result.pushed,
						applied: result.applied,
						deadLettered: result.deadLettered,
						revision: this.settings.revision,
					});
					new Notice('Vault seeded');
				} catch (error) {
					this.logger.error("auto_seed.failed", {
						revision: this.settings.revision,
						error,
					});
					new Notice(
						'Automatic seeding failed: ' + this.formatError(error),
					);
					throw error;
				}
			},
			this.logger,
		);
		if (!seeded) {
			this.logger.info("auto_seed.skipped", {
				revision: this.settings.revision,
				reason: "revision_not_zero",
			});
		}
	}

	async createClientInvite(): Promise<ClientInvite> {
		if (this.reloadRequired) {
			throw new Error("Reload Obsidian before creating a client package");
		}
		await ensureAuthenticated(this);
		this.logger.info("client_invite.request_started");
		const invite = await requestClientInvite({
			serverUrl: this.settings.serverUrl,
			clientSecret: this.settings.clientSecret,
			request: requestUrl,
			logger: this.logger,
		});
		this.logger.info("client_invite.request_completed", {
			expiresAt: invite.expiresAt,
		});
		return invite;
	}

	async openSyncStatusView(): Promise<void> {
		this.logger.debug("sync_status.open_started");
		const existing = this.app.workspace.getLeavesOfType(SYNC_STATUS_VIEW_TYPE);
		const leaf: WorkspaceLeaf =
			existing[0] ?? this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		if (existing.length === 0) {
			await leaf.setViewState({ type: SYNC_STATUS_VIEW_TYPE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		this.logger.debug("sync_status.open_completed");
	}

	private formatError(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}
