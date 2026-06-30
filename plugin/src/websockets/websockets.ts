import { deserialize, Message, MessageType, PROTOCOL_VERSION, serialize } from "obsidian-sync-protocol";
import { MyPluginSettings } from "../settings";
import MyPlugin from "../main";
import { Notice } from "obsidian";

export class WebsocketsHelper {
    private ws: WebSocket | null = null;
    private socketUrl: string;
    constructor(plugin: MyPlugin) {
        this.socketUrl = plugin.settings.serverUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws?version=' + PROTOCOL_VERSION;
        this.connect(plugin.settings.clientName, plugin.settings.clientSecret, plugin.settings);

        // routing

        if(this.ws) this.ws.onmessage = (event) => {
            console.log(event.data);
            const data = deserialize(event.data.toString());
            switch(data.type){
                case MessageType.AUTH_INIT:
                    plugin.settings.clientSecret = data.token;
                    plugin.saveSettings();
                    break;
				case MessageType.AUTH_SUCCESS:
					console.log('Authenticated');
					break;
				case MessageType.AUTH_FAILED:
					new Notice(data.reason);
					break;
				case MessageType.MESSAGE:
					new Notice(data.payload);
					break;
				case MessageType.ERROR:
					new Notice(data.reason);
					break;
            }
        };

        if(this.ws) this.ws.onclose = () => {
			console.log('Disconnected from server');
		};
		if(this.ws) this.ws.onerror = (error) => {
			console.error('Error: ', error);
		};


    }

    public async connect(clientName: string, clientSecret: string, settings: MyPluginSettings) {
        this.ws = new WebSocket(this.socketUrl);

		this.ws.onopen = () => {
			console.log('Connected to server');
			if(this.ws){
				let message: Message = {
					type: MessageType.AUTH_ACK,
					client_name: clientName,
					token: clientSecret
				};
				this.ws.send(serialize(message));
			}
		};
    }

    public async close() {
        if(this.ws){
            this.ws.close();
            this.ws = null;
        }
    }

    public sendMessage(message: string) {
        let data: Message = {
            type: MessageType.MESSAGE,
            payload: message
        };
        if(this.ws) this.ws.send(serialize(data));
    }

}