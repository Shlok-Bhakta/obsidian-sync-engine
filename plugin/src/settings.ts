import { App, Notice, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import ObsidianSyncPlugin from './main';
import { deserialize, MessageType, serialize } from 'obsidian-sync-protocol';

export interface ObsidianSyncSettings {
	serverUrl: string;
	clientName: string;
	clientSecret: string;
	revision: number;
}

export const DEFAULT_SETTINGS: ObsidianSyncSettings = {
	serverUrl: 'https://...',
	clientName: 'Main computer',
	clientSecret: 'Made by server',
	revision: 0
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
				.setTooltip('Refresh client secret')
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
						this.plugin.settings.serverUrl = value;
						updateServerUrlWarning(value);
						await this.plugin.saveSettings();
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
		.setDesc("Do not share this with anyone!!!")			
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
				.setDisabled(true)
				.onChange(async (value) => {
					this.plugin.settings.clientSecret = value;
					await this.plugin.saveSettings();
				}),
		);

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
				new Notice('Error refreshing client secret: ' + message.type);
			}
		} catch (error) {
			new Notice('Error refreshing client secret: ' + String(error));
		}
	}


}
