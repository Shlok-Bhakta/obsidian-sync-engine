
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



// WS Protocol
export enum opType {
    Ack,
    Update,
    CreateFile,
    RenameFile,
    DeleteFile,
    CreateFolder,
    RenameFolder,
    DeleteFolder,
}
export type wsPacket = { // ping pong thing but simpler
    type: opType.Ack;
    id: number;
} | { // literally the same thing as outboxData just used in the protocol context
    type: opType.Update;
    id: number;
    fileId: Path;
    data: Uint8Array;
    updateTime: number;
} | { // File Creation 
    type: opType.CreateFile;
    path: Path;
    initialContent: string;
} | { // File Renaming
    type: opType.RenameFile;
    fromPath: Path;
    toPath: Path;
} | { // File Deletion
    type: opType.DeleteFile;
    path: Path;
} | { // Folder Creation
    type: opType.CreateFolder;
    path: Path;
} | { // Folder Renaming
    type: opType.RenameFolder;
    fromPath: Path;
    toPath: Path;
} | { // Folder Deletion
    type: opType.DeleteFolder;
    path: Path;
}