import { DocSyncPath, DocSyncResult, opType, outboxData, ServerChange, SyncMutation, wsPacket } from "./types";
import { validatePacket } from "./validate";

export const PROTOCOL_VERSION: number = 6;

type EncodedMutation = Omit<SyncMutation, "data" | "contentBytes" | "yjsState"> & {
    data?: string;
    contentBytes?: string;
    yjsState?: string;
};

type EncodedServerChange = Omit<ServerChange, "data" | "contentBytes" | "yjsState"> & {
    data?: string;
    contentBytes?: string;
    yjsState?: string;
};

type EncodedOutboxRow = Omit<outboxData, "data" | "contentBytes" | "yjsState"> & {
    id: number;
    data?: string;
    contentBytes?: string;
    yjsState?: string;
};

type EncodedDocSyncPath = {
    path: string;
    stateVector: string;
    content?: string;
};

type EncodedDocSyncResult = {
    path: string;
    data: string;
    stateVector: string;
    yjsState: string;
};

export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }

    return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
    return bytesToBase64(bytes)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
    const base64 = value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "=");
    return base64ToBytes(base64);
}

export function encodePathToken(path: string): string {
    return encodeURIComponent(bytesToBase64Url(new TextEncoder().encode(path)));
}

export function decodePathToken(token: string): string {
    return new TextDecoder().decode(base64UrlToBytes(decodeURIComponent(token)));
}

function encodeMutation(mutation: SyncMutation): EncodedMutation {
    return {
        ...mutation,
        data: mutation.data ? bytesToBase64(mutation.data) : undefined,
        contentBytes: mutation.contentBytes ? bytesToBase64(mutation.contentBytes) : undefined,
        yjsState: mutation.yjsState ? bytesToBase64(mutation.yjsState) : undefined,
    };
}

function decodeMutation(mutation: EncodedMutation): SyncMutation {
    return {
        ...mutation,
        data: mutation.data ? base64ToBytes(mutation.data) : undefined,
        contentBytes: mutation.contentBytes ? base64ToBytes(mutation.contentBytes) : undefined,
        yjsState: mutation.yjsState ? base64ToBytes(mutation.yjsState) : undefined,
    };
}

function encodeServerChange(change: ServerChange): EncodedServerChange {
    return {
        ...change,
        data: change.data ? bytesToBase64(change.data) : undefined,
        contentBytes: change.contentBytes ? bytesToBase64(change.contentBytes) : undefined,
        yjsState: change.yjsState ? bytesToBase64(change.yjsState) : undefined,
    };
}

function decodeServerChange(change: EncodedServerChange): ServerChange {
    return {
        ...change,
        data: change.data ? base64ToBytes(change.data) : undefined,
        contentBytes: change.contentBytes ? base64ToBytes(change.contentBytes) : undefined,
        yjsState: change.yjsState ? base64ToBytes(change.yjsState) : undefined,
    };
}

function encodeDocSyncPath(entry: DocSyncPath): EncodedDocSyncPath {
    return {
        path: entry.path,
        stateVector: bytesToBase64(entry.stateVector),
        content: entry.content,
    };
}

function decodeDocSyncPath(entry: EncodedDocSyncPath): DocSyncPath {
    return {
        path: entry.path,
        stateVector: base64ToBytes(entry.stateVector),
        content: entry.content,
    };
}

function encodeDocSyncResult(entry: DocSyncResult): EncodedDocSyncResult {
    return {
        path: entry.path,
        data: bytesToBase64(entry.data),
        stateVector: bytesToBase64(entry.stateVector),
        yjsState: bytesToBase64(entry.yjsState),
    };
}

function decodeDocSyncResult(entry: EncodedDocSyncResult): DocSyncResult {
    return {
        path: entry.path,
        data: base64ToBytes(entry.data),
        stateVector: base64ToBytes(entry.stateVector),
        yjsState: base64ToBytes(entry.yjsState),
    };
}

export function encodePacket(packet: wsPacket): string {
    if (packet.type === opType.Update) {
        return JSON.stringify({
            type: packet.type,
            id: packet.id,
            fileId: packet.fileId,
            data: bytesToBase64(packet.data),
            updateTime: packet.updateTime,
        });
    }
    if (packet.type === opType.InitUploadBatch) {
        return JSON.stringify({
            ...packet,
            changes: packet.changes.map(encodeMutation),
        });
    }
    if (packet.type === opType.ChangeBatch) {
        return JSON.stringify({
            ...packet,
            changes: packet.changes.map(encodeServerChange),
        });
    }
    if (packet.type === opType.SnapshotReset) {
        return JSON.stringify({
            ...packet,
            files: packet.files.map(encodeServerChange),
        });
    }
    if (packet.type === opType.DocSync) {
        return JSON.stringify({
            type: packet.type,
            paths: packet.paths.map(encodeDocSyncPath),
        });
    }
    if (packet.type === opType.DocSyncAck) {
        return JSON.stringify({
            type: packet.type,
            paths: packet.paths.map(encodeDocSyncResult),
        });
    }
    return JSON.stringify(packet);
}

export function decodePacket(packet: string): wsPacket {
    let data: unknown;
    try {
        data = JSON.parse(packet);
    } catch {
        throw new Error("Packet is not valid JSON");
    }

    if (!data || typeof data !== "object" || !("type" in data)) {
        throw new Error("Packet is missing type");
    }

    const typed = data as { type: opType };
    if (typed.type === opType.Update) {
        const update = data as Extract<wsPacket, { type: opType.Update }>;
        return {
            type: update.type,
            id: update.id,
            fileId: update.fileId,
            data: base64ToBytes(update.data as unknown as string),
            updateTime: update.updateTime,
        };
    }
    if (typed.type === opType.InitUploadBatch) {
        const batch = data as { type: opType.InitUploadBatch; segmentId: string; changes: EncodedMutation[] };
        return validatePacket({
            ...batch,
            changes: batch.changes.map(decodeMutation),
        });
    }
    if (typed.type === opType.ChangeBatch) {
        const batch = data as { type: opType.ChangeBatch; fromRevision: string; serverRevision: string; changes: EncodedServerChange[] };
        return validatePacket({
            ...batch,
            changes: batch.changes.map(decodeServerChange),
        });
    }
    if (typed.type === opType.SnapshotReset) {
        const reset = data as { type: opType.SnapshotReset; targetRevision: string; files: EncodedServerChange[] };
        return validatePacket({
            ...reset,
            files: reset.files.map(decodeServerChange),
        });
    }
    if (typed.type === opType.DocSync) {
        const docSync = data as { type: opType.DocSync; paths: EncodedDocSyncPath[] };
        return validatePacket({
            type: docSync.type,
            paths: docSync.paths.map(decodeDocSyncPath),
        });
    }
    if (typed.type === opType.DocSyncAck) {
        const docSyncAck = data as { type: opType.DocSyncAck; paths: EncodedDocSyncResult[] };
        return validatePacket({
            type: docSyncAck.type,
            paths: docSyncAck.paths.map(decodeDocSyncResult),
        });
    }
    return validatePacket(data);
}

export function encodeUpdateBatchJsonl(mutations: SyncMutation[]): string {
    if (mutations.length === 0) {
        return "";
    }
    return mutations.map((row, index) => JSON.stringify({
        ...encodeMutation(row),
        id: index + 1,
    })).join("\n") + "\n";
}

export function decodeUpdateBatchJsonl(jsonl: string): SyncMutation[] {
    const updates: SyncMutation[] = [];

    for (const line of jsonl.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        const row = JSON.parse(line) as EncodedOutboxRow;
        const path = row.path ?? row.fileId;
        if (!path) {
            throw new Error("Outbox row is missing path");
        }
        updates.push({
            mutationId: row.mutationId ?? String(row.id),
            operation: row.operation ?? "YjsUpdate",
            path,
            toPath: row.toPath,
            data: row.data ? base64ToBytes(row.data) : undefined,
            contentBytes: row.contentBytes ? base64ToBytes(row.contentBytes) : undefined,
            yjsState: row.yjsState ? base64ToBytes(row.yjsState) : undefined,
            isFolder: row.isFolder,
            isYjs: row.isYjs,
            storageKind: row.storageKind,
            byteSize: row.byteSize,
            contentSha256: row.contentSha256,
            content: row.content,
            created: row.created,
        });
    }

    return updates;
}
