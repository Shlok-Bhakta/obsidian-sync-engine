import { z } from "zod";
import { opType, wsPacket } from "./types";

const revisionSchema = z.union([z.string(), z.number()]).transform(String);

const authPacketSchema = z.object({
    type: z.literal(opType.Auth),
    clientId: z.string().min(1),
    clientKey: z.string().min(1),
    clientName: z.string(),
    protocolVersion: z.number().int(),
    lastPulledRevision: revisionSchema,
});

const pullSincePacketSchema = z.object({
    type: z.literal(opType.PullSince),
    revision: revisionSchema,
});

const updateBatchPacketSchema = z.object({
    type: z.literal(opType.UpdateBatch),
    segmentId: z.string().min(1),
    jsonl: z.string(),
});

const initUploadBatchPacketSchema = z.object({
    type: z.literal(opType.InitUploadBatch),
    segmentId: z.string().min(1),
    changes: z.array(z.record(z.unknown())),
});

const bootstrapUploadPacketSchema = z.object({
    type: z.literal(opType.BootstrapUpload),
    bootstrapId: z.string().min(1),
    manifestSha256: z.string().min(1),
    jsonl: z.string().min(1),
});

const bootstrapUploadAckPacketSchema = z.object({
    type: z.literal(opType.BootstrapUploadAck),
    bootstrapId: z.string().min(1),
    revision: revisionSchema,
    files: z.number().int().nonnegative(),
});

const denyPacketSchema = z.object({
    type: z.literal(opType.Deny),
    message: z.string(),
});

const authAckPacketSchema = z.object({
    type: z.literal(opType.AuthAck),
    newClientKey: z.string().min(1),
    serverRevision: revisionSchema,
});

const batchAckPacketSchema = z.object({
    type: z.literal(opType.BatchAck),
    segmentId: z.string().min(1),
    revision: revisionSchema,
});

const initRequiredPacketSchema = z.object({
    type: z.literal(opType.InitRequired),
    serverRevision: revisionSchema,
});

const changeBatchPacketSchema = z.object({
    type: z.literal(opType.ChangeBatch),
    fromRevision: revisionSchema,
    serverRevision: revisionSchema,
    changes: z.array(z.record(z.unknown())),
});

const snapshotResetPacketSchema = z.object({
    type: z.literal(opType.SnapshotReset),
    targetRevision: revisionSchema,
    files: z.array(z.record(z.unknown())),
});

const bootstrapCreatePacketSchema = z.object({
    type: z.literal(opType.BootstrapCreate),
    vaultName: z.string().min(1),
    backendUrl: z.string().min(1),
    configDir: z.string().min(1),
    pluginId: z.string().min(1),
});

const bootstrapStatusPacketSchema = z.object({
    type: z.literal(opType.BootstrapStatus),
    status: z.enum(["building", "uploading", "ready", "downloaded", "complete", "expired", "failed"]),
    vaultName: z.string(),
    phase: z.string().optional(),
    progressCurrent: z.number().optional(),
    progressTotal: z.number().optional(),
    downloadUrl: z.string().optional(),
    expiresAt: z.number().optional(),
    remainingMs: z.number().optional(),
    message: z.string().optional(),
});

const editorPresencePositionSchema = z.object({
    line: z.number().int().nonnegative(),
    ch: z.number().int().nonnegative(),
});

const editorPresenceUpdatePacketSchema = z.object({
    type: z.literal(opType.EditorPresenceUpdate),
    clientId: z.string(),
    clientName: z.string(),
    path: z.string().min(1),
    from: editorPresencePositionSchema,
    to: editorPresencePositionSchema,
    head: editorPresencePositionSchema,
    anchor: editorPresencePositionSchema,
    color: z.string().min(1),
});

const editorPresenceDisconnectPacketSchema = z.object({
    type: z.literal(opType.EditorPresenceDisconnect),
    clientId: z.string().min(1),
});

const docSyncPathSchema = z.object({
    path: z.string().min(1),
    stateVector: z.instanceof(Uint8Array),
    content: z.string().optional(),
});

const docSyncPacketSchema = z.object({
    type: z.literal(opType.DocSync),
    paths: z.array(docSyncPathSchema).min(1),
});

const docSyncAckPacketSchema = z.object({
    type: z.literal(opType.DocSyncAck),
    paths: z.array(z.object({
        path: z.string().min(1),
        data: z.instanceof(Uint8Array),
        stateVector: z.instanceof(Uint8Array),
        yjsState: z.instanceof(Uint8Array),
    })),
});

const packetSchemas: Record<string, z.ZodType<unknown>> = {
    [opType.Auth]: authPacketSchema,
    [opType.PullSince]: pullSincePacketSchema,
    [opType.UpdateBatch]: updateBatchPacketSchema,
    [opType.InitUploadBatch]: initUploadBatchPacketSchema,
    [opType.BootstrapUpload]: bootstrapUploadPacketSchema,
    [opType.BootstrapUploadAck]: bootstrapUploadAckPacketSchema,
    [opType.Deny]: denyPacketSchema,
    [opType.AuthAck]: authAckPacketSchema,
    [opType.BatchAck]: batchAckPacketSchema,
    [opType.InitRequired]: initRequiredPacketSchema,
    [opType.ChangeBatch]: changeBatchPacketSchema,
    [opType.SnapshotReset]: snapshotResetPacketSchema,
    [opType.BootstrapCreate]: bootstrapCreatePacketSchema,
    [opType.BootstrapStatus]: bootstrapStatusPacketSchema,
    [opType.EditorPresenceUpdate]: editorPresenceUpdatePacketSchema,
    [opType.EditorPresenceDisconnect]: editorPresenceDisconnectPacketSchema,
    [opType.DocSync]: docSyncPacketSchema,
    [opType.DocSyncAck]: docSyncAckPacketSchema,
};

export function validatePacket(packet: unknown): wsPacket {
    if (!packet || typeof packet !== "object" || !("type" in packet)) {
        throw new Error("Packet is missing type");
    }

    const type = (packet as { type: unknown }).type;
    if (typeof type !== "string") {
        throw new Error("Packet type must be a string");
    }

    const schema = packetSchemas[type];
    if (!schema) {
        return packet as wsPacket;
    }

    return schema.parse(packet) as wsPacket;
}
