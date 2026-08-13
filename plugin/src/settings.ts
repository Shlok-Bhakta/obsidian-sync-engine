import {
	App,
	Notice,
	PluginSettingTab,
	Setting,
	requestUrl,
	type TextComponent,
} from 'obsidian';
import ObsidianSyncPlugin from './main';
import { deserialize, MessageType, serialize } from 'obsidian-sync-protocol';
import type { ClientConfig } from "obsidian-sync-protocol";
import {
	normalizeServerUrl,
	serverIdentityFor,
} from "./sync/serverIdentity";
import type {
	ClientArchiveBuildProgress,
	ClientInvite,
	ClientInviteStatus,
} from "./clientInvites";
import type { ServerConnectionState } from "./serverConnection";
import { describeClientArchiveProgress } from "./ui/clientInviteProgress";
import { formatClientInviteRemainingTime } from "./ui/clientInviteStatus";

export {
	normalizeServerUrl,
	legacyServerIdentityFor,
	resetServerCredentials,
	serverIdentityFor,
	transitionServerSettings,
} from "./sync/serverIdentity";

export interface ObsidianSyncSettings extends ClientConfig {
	serverIdentity: string;
}

export const DEFAULT_SETTINGS: ObsidianSyncSettings = {
	serverUrl: 'https://...',
	clientName: 'Main computer',
	clientSecret: 'Made by server',
	revision: 0,
	serverIdentity: serverIdentityFor("https://..."),
};

const isHttpUrl = (value: string): boolean => {
	try {
		return new URL(value.trim()).protocol === 'http:';
	} catch {
		return value.trim().toLowerCase().startsWith('http://');
	}
};

const CLIENT_INVITE_STATUS_POLL_INTERVAL_MS = 1_000;

export class SyncSettingTab extends PluginSettingTab {
	plugin: ObsidianSyncPlugin;
	private clientInvite: ClientInvite | null = null;
	private clientNameInput: TextComponent | null = null;
	private clientSecretInput: TextComponent | null = null;
	private serverUrlInput: TextComponent | null = null;
	private serverStatusIndicator: HTMLElement | null = null;
	private clientInviteBuilding = false;
	private clientInviteProgress: ClientArchiveBuildProgress | null = null;
	private clientInviteProgressEl: HTMLElement | null = null;
	private clientInviteProgressBar: HTMLProgressElement | null = null;
	private clientInviteStatus: ClientInviteStatus | null = null;
	private clientInviteStatusCheckFailed = false;
	private clientInviteStatusTimer: number | null = null;
	private clientInviteStatusPollGeneration = 0;
	private clientInviteLinkEl: HTMLElement | null = null;
	private clientInviteUrlEl: HTMLAnchorElement | null = null;
	private clientInviteExpiryEl: HTMLElement | null = null;

	constructor(app: App, plugin: ObsidianSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.plugin.register(
			this.plugin.onServerConnectionStateChanged((state) => {
				this.refreshConnectionControls(state);
			}),
		);
	}

	display(): void {
		const { containerEl } = this;
		this.stopClientInviteStatusPolling();

		containerEl.empty();
		new Setting(containerEl)
		.setName("Client name")
		.setDesc("Name that this client is registered as")	
		.addButton((button) =>
			button
				.setIcon('upload')
				.setTooltip('Refresh client name on server')
				.setCta()
				.setClass('obsidian-sync-client-secret-refresh')
				.onClick(() => this.refreshClientName(this.plugin.settings.clientName)),
		)
		.addText((text) =>
			(this.clientNameInput = text)
				.setPlaceholder('Main computer')
				.setValue(this.plugin.settings.clientName)
				.onChange(async (value) => {
					this.plugin.logger.info("settings.client_name_changed", {
						clientName: value,
					});
					this.plugin.settings.clientName = value;
					await this.plugin.saveSettings();
				}),
		);
		const serverUrlDesc = activeDocument.createDocumentFragment();
		serverUrlDesc.appendText("Enter the URL of the server to connect to");
		const serverUrlWarning = serverUrlDesc.createDiv({
			cls: 'obsidian-sync-server-url-warning',
			text: 'Warning: use HTTPS instead of regular HTTP for your server URL.',
		});

		const serverUrlSetting = new Setting(containerEl)
			.setName("Server URL")
			.setDesc(serverUrlDesc)
			.addText((text) =>
				(this.serverUrlInput = text)
					.setPlaceholder('HTTPS://...')
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						updateServerUrlWarning(value);
						const connection = this.plugin.changeServerUrl(value);
						this.updateConnectionIndicator(value);
						await connection;
						const currentValue = this.serverUrlInput?.getValue() ?? value;
						this.updateConnectionIndicator(currentValue);
						const state = this.plugin.getServerConnectionState();
						if (
							state.status === "connected" &&
							state.serverUrl === normalizeServerUrl(currentValue)
						) {
							this.clientNameInput?.setValue(
								this.plugin.settings.clientName,
							);
							this.clientSecretInput?.setValue(
								this.plugin.settings.clientSecret,
							);
						}
					}),
			);
		this.serverStatusIndicator = serverUrlSetting.controlEl.createSpan({
			cls: "obsidian-sync-connection-status",
		});

		const updateServerUrlWarning = (value: string) => {
			const showWarning = isHttpUrl(value);
			serverUrlSetting.settingEl.toggleClass(
				'obsidian-sync-server-url-setting--warning',
				showWarning,
			);
			serverUrlWarning.toggle(showWarning);
		};

		updateServerUrlWarning(this.plugin.settings.serverUrl);
		this.updateConnectionIndicator(this.plugin.settings.serverUrl);

		new Setting(containerEl)
		.setName("Client secret")
		.setDesc("Issued automatically by the server. Do not share it.")
		.addButton((button) =>
			button
				.setIcon('refresh-cw')
				.setTooltip('Refresh client secret')
				.setCta()
				.setClass('obsidian-sync-client-secret-refresh')
				.onClick(() => this.refreshClientSecret()),
		)
		.addText((text) =>
			(this.clientSecretInput = text)
				.setPlaceholder('Made by server')
				.setValue(this.plugin.settings.clientSecret)
				.onChange(async (value) => {
					this.plugin.logger.warn("settings.client_secret_changed_manually", {
						valuePresent: value.length > 0,
					});
					this.plugin.settings.clientSecret = value;
					await this.plugin.saveSettings();
				}),
		);

		const clientPackageDesc = activeDocument.createDocumentFragment();
		clientPackageDesc.appendText(
			"Create a one-time vault package. Its link expires in five minutes.",
		);
		this.clientInviteProgressEl = activeDocument.createElement("div");
		this.clientInviteProgressEl.className = "obsidian-sync-client-invite-progress";
		this.clientInviteProgressEl.setAttribute("role", "status");
		this.clientInviteProgressEl.setAttribute("aria-live", "polite");
		this.clientInviteProgressBar = activeDocument.createElement("progress");
		this.clientInviteProgressBar.max = 100;
		this.clientInviteProgressBar.className = "obsidian-sync-client-invite-progress__bar";
		this.clientInviteProgressEl.append(this.clientInviteProgressBar);
		this.clientInviteProgressEl.append(
			activeDocument.createElement("span"),
			activeDocument.createElement("small"),
		);
		clientPackageDesc.append(this.clientInviteProgressEl);

		const clientPackageSetting = new Setting(containerEl)
		.setName("Add another client")
		.setDesc(clientPackageDesc)
		.addButton((button) =>
			button
				.setButtonText(
					this.clientInviteBuilding ? "Building package" : "Create client package",
				)
				.setDisabled(this.clientInviteBuilding)
				.setCta()
				.onClick(async () => {
					if (this.clientInviteBuilding) return;
					this.clientInviteBuilding = true;
					this.clientInviteProgress = {
						phase: "preparing",
						processedFiles: 0,
						totalFiles: 0,
						percent: 0,
						estimatedSecondsRemaining: null,
					};
					button.setDisabled(true);
					button.setButtonText("Building package");
					this.renderClientInviteProgress();
					try {
						this.clientInvite = await this.plugin.createClientInvite((progress) => {
							this.clientInviteProgress = progress;
							this.renderClientInviteProgress();
						});
						this.clientInviteBuilding = false;
						this.clientInviteProgress = null;
						this.display();
						try {
							await navigator.clipboard.writeText(this.clientInvite.url);
							this.plugin.logger.info("client_invite.clipboard_copy_completed");
							new Notice("Client link copied to clipboard");
						} catch (error) {
							this.plugin.logger.warn("client_invite.clipboard_copy_failed", {
								error,
							});
							new Notice("Client package created. Copy its link below.");
						}
					} catch (error) {
						this.plugin.logger.error("client_invite.create_failed", {
							error,
						});
						this.clientInviteBuilding = false;
						this.clientInviteProgress = null;
						new Notice(
							"Could not create client package: " +
								(error instanceof Error ? error.message : String(error)),
						);
						this.display();
					}
				}),
		);
		clientPackageSetting.settingEl.addClass("obsidian-sync-client-package-setting");
		this.clientInviteLinkEl = activeDocument.createElement("div");
		this.clientInviteLinkEl.className = "obsidian-sync-client-invite-link";
		const clientInviteLinkRow = activeDocument.createElement("div");
		clientInviteLinkRow.className = "obsidian-sync-client-invite-link__row";
		this.clientInviteUrlEl = activeDocument.createElement("a");
		this.clientInviteUrlEl.className = "obsidian-sync-client-invite-link__url";
		this.clientInviteUrlEl.target = "_blank";
		this.clientInviteUrlEl.rel = "noopener noreferrer";
		const copyClientInviteButton = activeDocument.createElement("button");
		copyClientInviteButton.type = "button";
		copyClientInviteButton.textContent = "Copy";
		copyClientInviteButton.addEventListener("click", () => {
			void this.copyClientInviteLink();
		});
		clientInviteLinkRow.append(
			this.clientInviteUrlEl,
			copyClientInviteButton,
		);
		this.clientInviteExpiryEl = activeDocument.createElement("small");
		this.clientInviteExpiryEl.setAttribute("role", "status");
		this.clientInviteExpiryEl.setAttribute("aria-live", "polite");
		this.clientInviteLinkEl.append(clientInviteLinkRow, this.clientInviteExpiryEl);
		clientPackageSetting.settingEl.append(this.clientInviteLinkEl);
		this.renderClientInviteProgress();
		this.renderClientInviteLink();
		if (this.clientInvite) this.startClientInviteStatusPolling();

		new Setting(containerEl)
		.setName("Last synced revision")
		.setDesc("Last synced revision of the client")
		.addText((text) =>
			text
				.setPlaceholder('0')
				.setValue(this.plugin.settings.revision.toString())
				.setDisabled(true)
		);
	}

	hide(): void {
		this.stopClientInviteStatusPolling();
		super.hide();
	}

	private renderClientInviteProgress(): void {
		const container = this.clientInviteProgressEl;
		const progressBar = this.clientInviteProgressBar;
		const progress = this.clientInviteProgress;
		if (!container || !progressBar) return;
		container.toggle(this.clientInviteBuilding && progress !== null);
		if (!this.clientInviteBuilding || !progress) return;
		const copy = describeClientArchiveProgress(progress);
		progressBar.value = progress.percent;
		progressBar.setAttribute("aria-label", `${copy.summary}. ${copy.detail}`);
		const summary = container.querySelector("span");
		const detail = container.querySelector("small");
		if (summary) summary.textContent = copy.summary;
		if (detail) detail.textContent = copy.detail;
	}

	private renderClientInviteLink(): void {
		const container = this.clientInviteLinkEl;
		const url = this.clientInviteUrlEl;
		const expiry = this.clientInviteExpiryEl;
		const invite = this.clientInvite;
		if (!container || !url || !expiry) return;
		container.toggle(invite !== null);
		if (!invite) return;
		url.href = invite.url;
		url.textContent = invite.url;
		if (this.clientInviteStatus?.status === "available") {
			expiry.textContent =
				`Expires in ${formatClientInviteRemainingTime(this.clientInviteStatus.remainingSeconds)}` +
				" · verified by server";
		} else if (this.clientInviteStatusCheckFailed) {
			expiry.textContent = "Could not confirm expiry with the server. Retrying…";
		} else {
			expiry.textContent = "Checking expiry with the server…";
		}
	}

	private startClientInviteStatusPolling(): void {
		this.stopClientInviteStatusPolling();
		const invite = this.clientInvite;
		if (!invite) return;
		const generation = this.clientInviteStatusPollGeneration;
		this.clientInviteStatus = null;
		this.clientInviteStatusCheckFailed = false;
		this.renderClientInviteLink();
		const poll = async (): Promise<void> => {
			try {
				const status = await this.plugin.getClientInviteStatus(invite);
				if (
					generation !== this.clientInviteStatusPollGeneration ||
					this.clientInvite !== invite
				) return;
				if (status.status === "unavailable") {
					this.plugin.logger.info("client_invite.became_unavailable");
					this.clientInvite = null;
					this.clientInviteStatus = status;
					this.clientInviteStatusCheckFailed = false;
					this.renderClientInviteLink();
					new Notice("Client link expired or was already used");
					return;
				}
				this.clientInviteStatus = status;
				this.clientInviteStatusCheckFailed = false;
				this.renderClientInviteLink();
			} catch (error) {
				if (
					generation !== this.clientInviteStatusPollGeneration ||
					this.clientInvite !== invite
				) return;
				this.clientInviteStatusCheckFailed = true;
				this.plugin.logger.warn("client_invite.status_check_failed", { error });
				this.renderClientInviteLink();
			}
			if (
				generation === this.clientInviteStatusPollGeneration &&
				this.clientInvite === invite
			) {
				this.clientInviteStatusTimer = window.setTimeout(
					() => void poll(),
					CLIENT_INVITE_STATUS_POLL_INTERVAL_MS,
				);
			}
		};
		void poll();
	}

	private stopClientInviteStatusPolling(): void {
		this.clientInviteStatusPollGeneration += 1;
		if (this.clientInviteStatusTimer !== null) {
			window.clearTimeout(this.clientInviteStatusTimer);
			this.clientInviteStatusTimer = null;
		}
	}

	private async copyClientInviteLink(): Promise<void> {
		if (!this.clientInvite) return;
		try {
			await navigator.clipboard.writeText(this.clientInvite.url);
			this.plugin.logger.info("client_invite.clipboard_copy_completed");
			new Notice("Client link copied to clipboard");
		} catch (error) {
			this.plugin.logger.warn("client_invite.clipboard_copy_failed", { error });
			new Notice("Could not copy the client link");
		}
	}

	private updateConnectionIndicator(value: string): void {
		if (!this.serverStatusIndicator) return;
		const state = this.plugin.getServerConnectionState();
		const status =
			state.serverUrl === normalizeServerUrl(value)
				? state.status
				: "unknown";
		const tooltip = {
			unknown: "Connection not checked",
			checking: "Checking sync server connection",
			connected: "Connected to sync server",
			failed: "Could not connect to sync server",
		}[status];
		this.serverStatusIndicator.className =
			`obsidian-sync-connection-status obsidian-sync-connection-status--${status}`;
		this.serverStatusIndicator.title = tooltip;
		this.serverStatusIndicator.setAttribute("aria-label", tooltip);
	}

	private refreshConnectionControls(state: ServerConnectionState): void {
		const currentValue = this.serverUrlInput?.getValue();
		if (currentValue === undefined) return;
		this.updateConnectionIndicator(currentValue);
		if (
			state.status === "connected" &&
			state.serverUrl === normalizeServerUrl(currentValue)
		) {
			this.clientNameInput?.setValue(this.plugin.settings.clientName);
			this.clientSecretInput?.setValue(this.plugin.settings.clientSecret);
		}
	}

	private async refreshClientSecret(): Promise<void> {
		const logger = this.plugin.logger.child("settings_http");
		try {
			const startedAt = Date.now();
			logger.info("client_secret_reset.started", {
				serverUrl: this.plugin.settings.serverUrl,
				clientName: this.plugin.settings.clientName,
			});
			const response = await requestUrl({
				url: this.plugin.settings.serverUrl + '/reset-client-secret',
				method: 'POST',
				contentType: 'application/json',
				body: serialize({
					type: MessageType.AUTH_ACK,
					client_name: this.plugin.settings.clientName,
					token: this.plugin.settings.clientSecret
				}),
				throw: false,
			});
			logger.info("client_secret_reset.response", {
				status: response.status,
				durationMs: Date.now() - startedAt,
			});
			const raw = typeof response.json === 'string' ? response.json : response.text;
			let message = deserialize(raw);
			if(message.type === MessageType.AUTH_INIT){
				this.plugin.settings.clientSecret = message.token;
				// refresh setting pane
				this.display();
				await this.plugin.saveSettings();
				logger.info("client_secret_reset.completed", {
					clientName: message.client_name,
				});
			}else{
				logger.warn("client_secret_reset.rejected", {
					messageType: message.type,
					status: response.status,
				});
				new Notice('Error refreshing client secret: ' + message.type);
			}
		} catch (error) {
			logger.error("client_secret_reset.failed", { error });
			new Notice('Error refreshing client secret: ' + String(error));
		}
	}

	private async refreshClientName(newClientName: string): Promise<void> {
		const logger = this.plugin.logger.child("settings_http");
		try {
			const startedAt = Date.now();
			logger.info("client_name_reset.started", {
				serverUrl: this.plugin.settings.serverUrl,
				clientName: newClientName,
			});
			const response = await requestUrl({
				url: this.plugin.settings.serverUrl + '/reset-client-name',
				method: 'POST',
				contentType: 'application/json',
				body: serialize({
					type: MessageType.RESET_CLIENT_NAME,
					new_client_name: newClientName,
					token: this.plugin.settings.clientSecret
				}),
				throw: false,
			});
			logger.info("client_name_reset.response", {
				status: response.status,
				durationMs: Date.now() - startedAt,
			});
			const raw = typeof response.json === 'string' ? response.json : response.text;
			let message = deserialize(raw);
			if(message.type === MessageType.AUTH_INIT){
				this.plugin.settings.clientName = message.client_name;
				// refresh setting pane
				this.display();
				await this.plugin.saveSettings();
				logger.info("client_name_reset.completed", {
					clientName: message.client_name,
				});
			}else{
				logger.warn("client_name_reset.rejected", {
					messageType: message.type,
					status: response.status,
				});
				new Notice('Error refreshing client name: ' + message.type);
			}
		} catch (error) {
			logger.error("client_name_reset.failed", { error });
			new Notice('Error refreshing client name: ' + String(error));
		}
	}


}
