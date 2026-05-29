export type Path = string;

export type Revision = string;

export type MutationOperation =
    | "CreateFolder"
    | "UpsertFile"
    | "Delete"
    | "Rename"
    | "YjsUpdate";

export type SyncMutation = {
    mutationId: string;
    operation: MutationOperation;
    path: Path;
    toPath?: Path;
    content?: string;
    contentBytes?: Uint8Array;
    data?: Uint8Array;
    yjsState?: Uint8Array;
    isFolder?: boolean;
    isYjs?: boolean;
    storageKind?: "text" | "bytea" | "lo";
    blobUploadId?: string;
    byteSize?: number;
    contentSha256?: string;
    created: number;
};

export type outboxData = SyncMutation & {
    id?: number;
    fileId?: Path;
};

export type ServerChange = SyncMutation & {
    revision: Revision;
    clientId: string;
    yjsState?: Uint8Array;
};

export type DocSyncPath = {
    path: Path;
    stateVector: Uint8Array;
    /** Current local markdown; used to skip redundant server catch-up when already ahead. */
    content?: string;
};

export type DocSyncResult = {
    path: Path;
    /** Update the client is missing (server → client). */
    data: Uint8Array;
    /** Server document state vector before upload; use as origin for client → server diff. */
    stateVector: Uint8Array;
    /** Full persisted server Yjs state for this path. */
    yjsState: Uint8Array;
};

export type EditorPresencePosition = {
    line: number;
    ch: number;
};

export type EditorPresence = {
    clientId: string;
    clientName: string;
    path: Path;
    from: EditorPresencePosition;
    to: EditorPresencePosition;
    head: EditorPresencePosition;
    anchor: EditorPresencePosition;
    color: string;
};

export type BootstrapStatusValue =
    | "building"
    | "uploading"
    | "ready"
    | "downloaded"
    | "complete"
    | "expired"
    | "failed";

export type BootstrapStatus = {
    type: opType.BootstrapStatus;
    status: BootstrapStatusValue;
    vaultName: string;
    phase?: string;
    progressCurrent?: number;
    progressTotal?: number;
    downloadUrl?: string;
    expiresAt?: number;
    remainingMs?: number;
    message?: string;
};

export enum opType {
    Ack = "Ack",
    BatchAck = "BatchAck",
    DocSync = "DocSync",
    DocSyncAck = "DocSyncAck",
    Update = "Update",
    UpdateBatch = "UpdateBatch",
    InitUploadBatch = "InitUploadBatch",
    BootstrapUpload = "BootstrapUpload",
    BootstrapUploadAck = "BootstrapUploadAck",
    PullSince = "PullSince",
    InitRequired = "InitRequired",
    ChangeBatch = "ChangeBatch",
    SnapshotReset = "SnapshotReset",
    BootstrapCreate = "BootstrapCreate",
    BootstrapStatus = "BootstrapStatus",
    EditorPresenceUpdate = "EditorPresenceUpdate",
    EditorPresenceDisconnect = "EditorPresenceDisconnect",
    Auth = "Auth",
    AuthAck = "AuthAck",
    Deny = "Deny",
}

export type wsPacket =
    | {
        type: opType.Ack;
        id: number;
    }
    | {
        type: opType.Update;
        id: number;
        fileId: Path;
        data: Uint8Array;
        updateTime: number;
    }
    | {
        type: opType.UpdateBatch;
        segmentId: string;
        jsonl: string;
    }
    | {
        type: opType.InitUploadBatch;
        segmentId: string;
        changes: SyncMutation[];
    }
    | {
        type: opType.BootstrapUpload;
        bootstrapId: string;
        manifestSha256: string;
        jsonl: string;
    }
    | {
        type: opType.BootstrapUploadAck;
        bootstrapId: string;
        revision: Revision;
        files: number;
    }
    | {
        type: opType.BatchAck;
        segmentId: string;
        revision: Revision;
    }
    | {
        type: opType.PullSince;
        revision: Revision;
        requestId?: string;
    }
    | {
        type: opType.InitRequired;
        serverRevision: Revision;
        requestId?: string;
    }
    | {
        type: opType.ChangeBatch;
        fromRevision: Revision;
        serverRevision: Revision;
        changes: ServerChange[];
        requestId?: string;
    }
    | {
        type: opType.SnapshotReset;
        targetRevision: Revision;
        files: ServerChange[];
        requestId?: string;
    }
    | {
        type: opType.BootstrapCreate;
        vaultName: string;
        backendUrl: string;
        configDir: string;
        pluginId: string;
    }
    | BootstrapStatus
    | ({
        type: opType.EditorPresenceUpdate;
    } & EditorPresence)
    | {
        type: opType.EditorPresenceDisconnect;
        clientId: string;
    }
    | {
        type: opType.Auth;
        clientId: string;
        clientKey: string;
        clientName: string;
        protocolVersion: number;
        lastPulledRevision: Revision;
    }
    | {
        type: opType.AuthAck;
        newClientKey: string;
        serverRevision: Revision;
    }
    | {
        type: opType.Deny;
        message: string;
    }
    | {
        type: opType.DocSync;
        paths: DocSyncPath[];
    }
    | {
        type: opType.DocSyncAck;
        paths: DocSyncResult[];
    };
