import { App, Notice, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import ObsidianSyncPlugin from './main';
import { deserialize, MessageType, serialize } from 'obsidian-sync-protocol';
import { serverIdentityFor } from "./sync/serverIdentity";
import type { ClientInvite } from "./clientInvites";

export {
	normalizeServerUrl,
	legacyServerIdentityFor,
	resetServerCredentials,
	serverIdentityFor,
	transitionServerSettings,
} from "./sync/serverIdentity";

export interface ObsidianSyncSettings {
	serverUrl: string;
	clientName: string;
	clientSecret: string;
	revision: number;
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

export class SyncSettingTab extends PluginSettingTab {
	plugin: ObsidianSyncPlugin;
	private clientInvite: ClientInvite | null = null;

	constructor(app: App, plugin: ObsidianSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

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
			text
				.setPlaceholder('Main computer')
				.setValue(this.plugin.settings.clientName)
				.onChange(async (value) => {
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
				text
					.setPlaceholder('HTTPS://...')
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						await this.plugin.changeServerUrl(value);
						updateServerUrlWarning(value);
					}),
			);

		const updateServerUrlWarning = (value: string) => {
			const showWarning = isHttpUrl(value);
			serverUrlSetting.settingEl.toggleClass(
				'obsidian-sync-server-url-setting--warning',
				showWarning,
			);
			serverUrlWarning.toggle(showWarning);
		};

		updateServerUrlWarning(this.plugin.settings.serverUrl);

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
			text
				.setPlaceholder('Made by server')
				.setValue(this.plugin.settings.clientSecret)
				.onChange(async (value) => {
					this.plugin.settings.clientSecret = value;
					await this.plugin.saveSettings();
				}),
		);

		new Setting(containerEl)
		.setName("Add another client")
		.setDesc("Create a one-time vault package. Its link expires in five minutes.")
		.addButton((button) =>
			button
				.setButtonText("Create client package")
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					try {
						this.clientInvite = await this.plugin.createClientInvite();
						this.display();
						try {
							await navigator.clipboard.writeText(this.clientInvite.url);
							new Notice("Client link copied to clipboard");
						} catch {
							new Notice("Client package created. Copy its link below.");
						}
					} catch (error) {
						new Notice(
							"Could not create client package: " +
								(error instanceof Error ? error.message : String(error)),
						);
						button.setDisabled(false);
					}
				}),
		);

		if (this.clientInvite) {
			new Setting(containerEl)
				.setName("New client link")
				.setDesc("Send this link to the other device. The zip can be downloaded once.")
				.addText((text) =>
					text
						.setValue(this.clientInvite?.url ?? "")
						.setDisabled(true),
				)
				.addButton((button) =>
					button
						.setButtonText("Copy")
						.onClick(async () => {
							if (!this.clientInvite) return;
							try {
								await navigator.clipboard.writeText(this.clientInvite.url);
								new Notice("Client link copied to clipboard");
							} catch {
								new Notice("Could not copy the client link");
							}
						}),
				);
		}

		new Setting(containerEl)
		.setName("Last synced revision")
		.setDesc("Last synced revision of the client")
		.addText((text) =>
			text
				.setPlaceholder('0')
				.setValue(this.plugin.settings.revision.toString())
				.setDisabled(true)
		);

		new Setting(containerEl)
		.setName("Seed server from this vault")
		.setDesc("Enqueue every file currently in the vault to push to the server. Use this once to bootstrap a fresh server, or after restoring a vault.")
		.addButton((button) =>
			button
				.setButtonText('Seed server')
				.setCta()
				.onClick(() => void this.plugin.seedFromVault()),
		);
	}

	private async refreshClientSecret(): Promise<void> {
		try {
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
			const raw = typeof response.json === 'string' ? response.json : response.text;
			let message = deserialize(raw);
			if(message.type === MessageType.AUTH_INIT){
				this.plugin.settings.clientSecret = message.token;
				// refresh setting pane
				this.display();
				await this.plugin.saveSettings();
			}else{
				new Notice('Error refreshing client secret: ' + message.type);
			}
		} catch (error) {
			new Notice('Error refreshing client secret: ' + String(error));
		}
	}

	private async refreshClientName(newClientName: string): Promise<void> {
		try {
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
			const raw = typeof response.json === 'string' ? response.json : response.text;
			let message = deserialize(raw);
			if(message.type === MessageType.AUTH_INIT){
				this.plugin.settings.clientName = message.client_name;
				// refresh setting pane
				this.display();
				await this.plugin.saveSettings();
			}else{
				new Notice('Error refreshing client name: ' + message.type);
			}
		} catch (error) {
			new Notice('Error refreshing client name: ' + String(error));
		}
	}


}
