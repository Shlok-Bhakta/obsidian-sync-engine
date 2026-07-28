/**
 * Deferred: WebSocket client transport will be used for the second iteration
 * of sync (live push / lower latency). The MVP product path is HTTP polling
 * via ensureAuthenticated + SyncEngine.tick. Keep this helper for the
 * follow-up; do not construct it from main.ts until that iteration.
 */
import { deserialize, Message, MessageType, PROTOCOL_VERSION, serialize } from "obsidian-sync-protocol";
import { ObsidianSyncSettings } from "../settings";
import ObsidianSyncPlugin from "../main";
import { Notice } from "obsidian";

export class WebsocketsHelper {
    private ws: WebSocket | null = null;
    private socketUrl: string;
    constructor(plugin: ObsidianSyncPlugin) {
        this.socketUrl = plugin.settings.serverUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws?version=' + PROTOCOL_VERSION;
        void this.connect(plugin.settings.clientName, plugin.settings.clientSecret, plugin.settings);

        // routing

        if(this.ws) this.ws.onmessage = (event: MessageEvent<unknown>) => {
            const raw = typeof event.data === 'string' ? event.data : String(event.data);
            const data = deserialize(raw);
            switch(data.type){
                case MessageType.AUTH_INIT:
                    plugin.settings.clientSecret = data.token;
                    void plugin.saveSettings();
                    break;
				case MessageType.AUTH_SUCCESS:
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
			// Disconnected from server.
		};
		if(this.ws) this.ws.onerror = (error) => {
			console.error('Error: ', error);
		};


    }

    public async connect(clientName: string, clientSecret: string, settings: ObsidianSyncSettings) {
        this.ws = new WebSocket(this.socketUrl);

		this.ws.onopen = () => {
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
