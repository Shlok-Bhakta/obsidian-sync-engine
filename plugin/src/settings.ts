import { App, Notice, PluginSettingTab, Setting, requestUrl } from 'obsidian';
import MyPlugin from './main';
import { deserialize, MessageType, serialize } from 'obsidian-sync-protocol';

export interface MyPluginSettings {
	serverUrl: string;
	clientName: string;
	clientSecret: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	serverUrl: 'https://...',
	clientName: 'Main Computer',
	clientSecret: 'Made by server',
};

const isHttpUrl = (value: string): boolean => {
	try {
		return new URL(value.trim()).protocol === 'http:';
	} catch {
		return value.trim().toLowerCase().startsWith('http://');
	}
};

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();
		new Setting(containerEl)
		.setName("Client Name")
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
				.setPlaceholder('Main Computer')
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
					.setPlaceholder('https://...')
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
		.setName("Client Secret")
		.setDesc("DO NOT SHARE THIS WITH ANYONE!!!")			
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
			new Notice('Error refreshing client secret: ' + error);
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
			new Notice('Error refreshing client secret: ' + error);
		}
	}


}
