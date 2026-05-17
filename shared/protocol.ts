// shared protocol between client and server that is used to communicate over websockets
import { wsPacket, opType } from "./types";


function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary);
  }

function base64ToBytes(base64: string): Uint8Array {
const binary = atob(base64);
const bytes = new Uint8Array(binary.length);

for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
}

return bytes;
}



export function encodePacket(packet: wsPacket) : string{
    if(packet.type === opType.Update){
        return JSON.stringify({
            type: packet.type,
            id: packet.id,
            fileId: packet.fileId,
            data: bytesToBase64(packet.data),
            updateTime: packet.updateTime
        })
    }else{
        return JSON.stringify(packet)
    }
}

export function decodePacket(packet: string): wsPacket{
    let data = JSON.parse(packet);
    if(data.type === opType.Update){
        return {
            type: data.type,
            id: data.id,
            fileId: data.fileId,
            data: base64ToBytes(data.data),
            updateTime: data.updateTime
        }
    }else{
        return data;
    }
}