
export type Path = string;

export type syncPacket = {

}

export type outboxData = {
    id?: number;
    fileId: Path;
    operation: "Update";
    data: Uint8Array;
    created: number;
}

export type updatePacket = {
    fileId: Path;
    updateState: Uint8Array;
    // on send, this is the time the update was made **determined by client**
    // on receive, this is the time the server says the update happened **not determined by client**
    updateTime: number; 
    // clientId: string; prolly better if websocket just remembers this



}
