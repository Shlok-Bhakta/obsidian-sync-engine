import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { opType } from "./types";
import {
    bytesToBase64,
    base64ToBytes,
    decodePacket,
    decodeUpdateBatchJsonl,
    encodePacket,
    PROTOCOL_VERSION,
} from "./protocol";

describe("protocol base64", () => {
    it("round-trips binary data", () => {
        const bytes = new Uint8Array([0, 1, 2, 255]);
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    });
});

describe("encodePacket / decodePacket", () => {
    it("round-trips Auth", () => {
        const packet = {
            type: opType.Auth as const,
            clientId: "client-1",
            clientKey: "obs_sync_test",
            clientName: "Test",
            protocolVersion: PROTOCOL_VERSION,
            lastPulledRevision: "42",
        };
        const decoded = decodePacket(encodePacket(packet));
        expect(decoded).toEqual(packet);
    });

    it("round-trips PullSince", () => {
        const packet = { type: opType.PullSince as const, revision: "7" };
        expect(decodePacket(encodePacket(packet))).toEqual(packet);
    });

    it("round-trips BatchAck", () => {
        const packet = { type: opType.BatchAck as const, segmentId: "seg-1", revision: "99" };
        expect(decodePacket(encodePacket(packet))).toEqual(packet);
    });

    it("round-trips DocSync and DocSyncAck", () => {
        const doc = new Y.Doc();
        doc.getText("markdown").insert(0, "hello");
        const stateVector = Y.encodeStateVector(doc);
        const data = Y.encodeStateAsUpdateV2(doc);
        doc.destroy();

        const request = {
            type: opType.DocSync as const,
            paths: [{ path: "notes/a.md", stateVector, content: "hello" }],
        };
        const response = {
            type: opType.DocSyncAck as const,
            paths: [{ path: "notes/a.md", data, stateVector, yjsState: data }],
        };

        expect(decodePacket(encodePacket(request))).toEqual(request);
        expect(decodePacket(encodePacket(response))).toEqual(response);
    });

    it("round-trips snapshot yjsState", () => {
        const yjsState = new Uint8Array([1, 2, 3, 4]);
        const packet = {
            type: opType.SnapshotReset as const,
            targetRevision: "10",
            files: [{
                revision: "10",
                clientId: "server",
                mutationId: "snapshot:notes/a.md:10",
                operation: "UpsertFile" as const,
                path: "notes/a.md",
                content: "hello",
                isFolder: false,
                isYjs: true,
                yjsState,
                created: 1,
            }],
        };

        expect(decodePacket(encodePacket(packet))).toEqual(packet);
    });

    it("round-trips init upload yjsState", () => {
        const yjsState = new Uint8Array([5, 6, 7, 8]);
        const packet = {
            type: opType.InitUploadBatch as const,
            segmentId: "init-1",
            changes: [{
                mutationId: "init-notes-a",
                operation: "UpsertFile" as const,
                path: "notes/a.md",
                content: "hello",
                yjsState,
                isFolder: false,
                isYjs: true,
                storageKind: "text" as const,
                created: 1,
            }],
        };

        expect(decodePacket(encodePacket(packet))).toEqual(packet);
    });

    it("round-trips BootstrapCreate and BootstrapStatus", () => {
        const create = {
            type: opType.BootstrapCreate as const,
            vaultName: "Work Vault",
            backendUrl: "https://sync.example.com",
            configDir: ".obsidian",
            pluginId: "obsidian-sync-engine",
        };
        const status = {
            type: opType.BootstrapStatus as const,
            status: "ready" as const,
            vaultName: "Work Vault",
            downloadUrl: "https://sync.example.com/v1/bootstrap/token",
            expiresAt: 1_700_000_000_000,
            remainingMs: 600_000,
        };

        expect(decodePacket(encodePacket(create))).toEqual(create);
        expect(decodePacket(encodePacket(status))).toEqual(status);
    });

    it("round-trips BYTEA file bodies", () => {
        const contentBytes = new Uint8Array([123, 34, 97, 34, 58, 49, 125]);
        const packet = {
            type: opType.ChangeBatch as const,
            fromRevision: "1",
            serverRevision: "2",
            changes: [{
                revision: "2",
                clientId: "client",
                mutationId: "m-1",
                operation: "UpsertFile" as const,
                path: ".obsidian/workspace.json",
                contentBytes,
                storageKind: "bytea" as const,
                byteSize: contentBytes.byteLength,
                contentSha256: "sha",
                isFolder: false,
                isYjs: false,
                created: 1,
            }],
        };

        expect(decodePacket(encodePacket(packet))).toEqual(packet);
    });

    it("rejects invalid JSON", () => {
        expect(() => decodePacket("{not json")).toThrow("not valid JSON");
    });

    it("rejects Auth missing clientId", () => {
        expect(() => decodePacket(JSON.stringify({
            type: opType.Auth,
            clientKey: "obs_sync_test",
            clientName: "Test",
            protocolVersion: PROTOCOL_VERSION,
            lastPulledRevision: "0",
        }))).toThrow();
    });
});

describe("decodeUpdateBatchJsonl", () => {
    it("parses YjsUpdate rows", () => {
        const data = bytesToBase64(new Uint8Array([9, 8, 7]));
        const jsonl = JSON.stringify({
            id: 1,
            mutationId: "m-1",
            operation: "YjsUpdate",
            path: "notes/a.md",
            data,
            created: 1,
        });
        const mutations = decodeUpdateBatchJsonl(jsonl);
        expect(mutations).toHaveLength(1);
        expect(mutations[0]?.path).toBe("notes/a.md");
        expect(mutations[0]?.data).toEqual(new Uint8Array([9, 8, 7]));
        expect(mutations[0]?.content).toBeUndefined();
    });

    it("parses BYTEA UpsertFile rows", () => {
        const contentBytes = bytesToBase64(new Uint8Array([1, 2, 3]));
        const jsonl = JSON.stringify({
            id: 1,
            mutationId: "m-1",
            operation: "UpsertFile",
            path: "asset.bin",
            contentBytes,
            storageKind: "bytea",
            byteSize: 3,
            created: 1,
        });
        const mutations = decodeUpdateBatchJsonl(jsonl);
        expect(mutations[0]?.contentBytes).toEqual(new Uint8Array([1, 2, 3]));
        expect(mutations[0]?.storageKind).toBe("bytea");
    });

    it("throws when path is missing", () => {
        expect(() => decodeUpdateBatchJsonl(JSON.stringify({ id: 1 }))).toThrow("missing path");
    });
});
