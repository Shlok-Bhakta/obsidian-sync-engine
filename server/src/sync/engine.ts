import { sql } from "bun";
import { DocSyncPath, opType, ServerChange, SyncMutation, wsPacket } from "../../../shared/types";
import { isPluginInternalPath, shouldSyncPath, shouldUseYjs } from "../../../shared/pathPolicy";
import { folderDescendantLike } from "../sqlUtils";
import * as Y from "yjs";
import {
  applyYjsPayload,
  contentFromYjsState,
  docStateFromContent,
  encodeMissingUpdate,
  replayYjsPayloads,
} from "../yjs/apply";
import { createLargeObject, readLargeObject, readLargeObjectRange, unlinkLargeObject } from "../db/largeObject";
import { log } from "../logger";
import { consumeStagedBlob, StagedBlobUpload } from "./blobUpload";

export type CompactionConfig = {
  count: number;
  bytes: number;
};

export const defaultCompactionConfig: CompactionConfig = {
  count: 100,
  bytes: 1024 * 1024,
};

let compactionConfig: CompactionConfig = { ...defaultCompactionConfig };
const CHANGE_BATCH_ROW_LIMIT = 500;
const COMPACTION_SCHEDULE_DELAY_MS = 1000;
let compactionTimer: ReturnType<typeof setTimeout> | null = null;
let compactionPromise: Promise<void> | null = null;

export function setCompactionConfig(config: Partial<CompactionConfig>): void {
  compactionConfig = { ...compactionConfig, ...config };
}

export function resetCompactionConfig(): void {
  compactionConfig = { ...defaultCompactionConfig };
  if (compactionTimer) {
    clearTimeout(compactionTimer);
    compactionTimer = null;
  }
}

export function flushScheduledYjsCompaction(): void {
  if (compactionTimer) {
    clearTimeout(compactionTimer);
    compactionTimer = null;
  }
}

export function scheduleYjsCompaction(): void {
  if (compactionTimer || compactionPromise) {
    return;
  }
  compactionTimer = setTimeout(() => {
    compactionTimer = null;
    compactionPromise = compactYjsEvents()
      .catch(error => {
        log.error("background Yjs compaction failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        compactionPromise = null;
      });
  }, COMPACTION_SCHEDULE_DELAY_MS);
  compactionTimer.unref?.();
}

type RevisionRow = {
  revision: string;
};

export type ServerFileRow = {
  path: string;
  content: string | null;
  contentBytes: Uint8Array | null;
  contentOid: number | null;
  storageKind: "text" | "bytea" | "lo";
  byteSize: string | null;
  contentSha256: string | null;
  yjsState: Uint8Array | null;
  isFolder: boolean;
  isYjs: boolean;
  deleted: boolean;
  revision: string;
  createdAt: string;
};

export type EventRow = {
  revision: string;
  clientId: string;
  mutationId: string;
  operation: SyncMutation["operation"];
  path: string;
  toPath: string | null;
  content: string | null;
  contentBytes: Uint8Array | null;
  storageKind: "text" | "bytea" | "lo" | null;
  byteSize: string | null;
  contentSha256: string | null;
  payload: Uint8Array | null;
  yjsState: Uint8Array | null;
  compacted: boolean;
  isFolder: boolean | null;
  isYjs: boolean | null;
  createdAt: string;
};

type CompactionCandidate = {
  path: string;
  updates: string;
  bytes: string | null;
  maxRevision: string;
};

function latestRevisionFromRows(rows: RevisionRow[]): string {
  return rows[0]?.revision ?? "0";
}

function summarizeMutations(mutations: SyncMutation[]): Record<string, number> {
  return mutations.reduce<Record<string, number>>((summary, mutation) => {
    summary[mutation.operation] = (summary[mutation.operation] ?? 0) + 1;
    return summary;
  }, {});
}

export async function getServerRevision(): Promise<string> {
  const rows = await sql<RevisionRow[]>`
    SELECT GREATEST(
      COALESCE((SELECT MAX(revision) FROM sync_events), 0),
      COALESCE((SELECT MAX(revision) FROM files), 0)
    )::TEXT AS revision;
  `;
  return latestRevisionFromRows(rows);
}

export async function getCompactedRevision(): Promise<string> {
  const rows = await sql<{ compactedRevision: string }[]>`
    SELECT compacted_revision::TEXT AS "compactedRevision"
    FROM server_meta
    WHERE id = 1;
  `;
  return rows[0]?.compactedRevision ?? "0";
}

export async function serverHasAnyState(): Promise<boolean> {
  const rows = await sql<{ count: string }[]>`
    SELECT (
      (SELECT COUNT(*) FROM files) + (SELECT COUNT(*) FROM sync_events)
    )::TEXT AS count;
  `;
  return Number.parseInt(rows[0]?.count ?? "0", 10) > 0;
}

export async function getFile(path: string): Promise<ServerFileRow | null> {
  const rows = await sql<ServerFileRow[]>`
    SELECT
      path,
      content,
      content_bytes AS "contentBytes",
      content_oid AS "contentOid",
      storage_kind AS "storageKind",
      byte_size::TEXT AS "byteSize",
      content_sha256 AS "contentSha256",
      yjs_state AS "yjsState",
      is_folder AS "isFolder",
      is_yjs AS "isYjs",
      deleted,
      revision::TEXT AS revision,
      EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
    FROM files
    WHERE path = ${path};
  `;
  return rows[0] ?? null;
}

export async function listSyncEvents(path: string): Promise<EventRow[]> {
  return sql<EventRow[]>`
    SELECT
      revision::TEXT AS revision,
      client_id AS "clientId",
      mutation_id AS "mutationId",
      operation,
      path,
      to_path AS "toPath",
      content,
      content_bytes AS "contentBytes",
      storage_kind AS "storageKind",
      byte_size::TEXT AS "byteSize",
      content_sha256 AS "contentSha256",
      payload,
      NULL::BYTEA AS "yjsState",
      compacted,
      is_folder AS "isFolder",
      is_yjs AS "isYjs",
      EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
    FROM sync_events
    WHERE path = ${path}
    ORDER BY revision ASC;
  `;
}

export async function listYjsEvents(path: string): Promise<EventRow[]> {
  const events = await listSyncEvents(path);
  return events.filter(event => event.operation === "YjsUpdate");
}

export async function countYjsEvents(path: string, includeCompacted = true): Promise<number> {
  const rows = includeCompacted
    ? await sql<{ count: string }[]>`
        SELECT COUNT(*)::TEXT AS count
        FROM sync_events
        WHERE path = ${path}
          AND operation = 'YjsUpdate';
      `
    : await sql<{ count: string }[]>`
        SELECT COUNT(*)::TEXT AS count
        FROM sync_events
        WHERE path = ${path}
          AND operation = 'YjsUpdate'
          AND compacted = FALSE;
      `;
  return Number.parseInt(rows[0]?.count ?? "0", 10);
}

function rowToSnapshotChange(row: ServerFileRow): ServerChange {
  return {
    revision: row.revision,
    clientId: "server",
    mutationId: `snapshot:${row.path}:${row.revision}`,
    operation: row.deleted ? "Delete" : row.isFolder ? "CreateFolder" : "UpsertFile",
    path: row.path,
    content: row.content ?? undefined,
    contentBytes: row.storageKind === "bytea" ? row.contentBytes ?? undefined : undefined,
    yjsState: row.isYjs && !row.deleted && row.yjsState ? row.yjsState : undefined,
    isFolder: row.isFolder,
    isYjs: row.isYjs,
    storageKind: row.storageKind,
    byteSize: row.byteSize ? Number.parseInt(row.byteSize, 10) : undefined,
    contentSha256: row.contentSha256 ?? undefined,
    created: new Date(row.createdAt).getTime(),
  };
}

function rowToChange(row: EventRow): ServerChange {
  return {
    revision: row.revision,
    clientId: row.clientId,
    mutationId: row.mutationId,
    operation: row.operation,
    path: row.path,
    toPath: row.toPath ?? undefined,
    content: row.content ?? undefined,
    contentBytes: row.storageKind === "bytea" ? row.contentBytes ?? undefined : undefined,
    data: row.payload ?? undefined,
    yjsState: row.yjsState && (row.operation === "YjsUpdate" || (row.operation === "UpsertFile" && row.isYjs === true))
      ? row.yjsState
      : undefined,
    isFolder: row.isFolder ?? undefined,
    isYjs: row.isYjs ?? undefined,
    storageKind: row.storageKind ?? undefined,
    byteSize: row.byteSize ? Number.parseInt(row.byteSize, 10) : undefined,
    contentSha256: row.contentSha256 ?? undefined,
    created: new Date(row.createdAt).getTime(),
  };
}

export async function snapshotPacket(): Promise<Extract<wsPacket, { type: opType.SnapshotReset }>> {
  const files = await sql<ServerFileRow[]>`
    SELECT
      path,
      content,
      content_bytes AS "contentBytes",
      content_oid AS "contentOid",
      storage_kind AS "storageKind",
      byte_size::TEXT AS "byteSize",
      content_sha256 AS "contentSha256",
      yjs_state AS "yjsState",
      is_folder AS "isFolder",
      is_yjs AS "isYjs",
      deleted,
      revision::TEXT AS revision,
      EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
    FROM files
    WHERE deleted = FALSE
    ORDER BY is_folder DESC, path ASC;
  `;
  return {
    type: opType.SnapshotReset,
    targetRevision: await getServerRevision(),
    files: files.filter(row => shouldSyncPath(row.path)).map(rowToSnapshotChange),
  };
}

export async function changeBatchPacket(fromRevision: string): Promise<Extract<wsPacket, { type: opType.ChangeBatch }>> {
  const rows = await sql<EventRow[]>`
    SELECT
      e.revision::TEXT AS revision,
      e.client_id AS "clientId",
      e.mutation_id AS "mutationId",
      e.operation,
      e.path,
      e.to_path AS "toPath",
      e.content,
      e.content_bytes AS "contentBytes",
      e.storage_kind AS "storageKind",
      e.byte_size::TEXT AS "byteSize",
      e.content_sha256 AS "contentSha256",
      e.payload,
      f.yjs_state AS "yjsState",
      e.compacted,
      e.is_folder AS "isFolder",
      e.is_yjs AS "isYjs",
      EXTRACT(EPOCH FROM e.created_at) * 1000 AS "createdAt"
    FROM sync_events e
    LEFT JOIN files f ON f.path = e.path
    WHERE e.revision > ${fromRevision}
    ORDER BY e.revision ASC
    LIMIT ${CHANGE_BATCH_ROW_LIMIT};
  `;
  const serverRevision = rows.reduce((max, row) => {
    return BigInt(row.revision) > BigInt(max) ? row.revision : max;
  }, fromRevision);
  return {
    type: opType.ChangeBatch,
    fromRevision,
    serverRevision,
    changes: rows.map(rowToChange),
  };
}

export async function registerClient(
  clientId: string,
  clientName: string,
  currentKeyId: string | null = null,
  previousKeyId: string | null = null,
  lastPulledRevision = "0",
): Promise<void> {
  await sql`
    INSERT INTO clients (
      client_id,
      client_name,
      current_key_id,
      previous_key_id,
      last_seen_at,
      last_acked_revision
    )
    VALUES (
      ${clientId},
      ${clientName},
      ${currentKeyId},
      ${previousKeyId},
      NOW(),
      ${lastPulledRevision}
    )
    ON CONFLICT (client_id) DO UPDATE SET
      client_name = EXCLUDED.client_name,
      current_key_id = EXCLUDED.current_key_id,
      previous_key_id = EXCLUDED.previous_key_id,
      last_seen_at = NOW(),
      last_acked_revision = GREATEST(clients.last_acked_revision, EXCLUDED.last_acked_revision);
  `;
}

export async function applyMutation(
  tx: typeof sql,
  clientId: string,
  mutation: SyncMutation,
  options: { stagedBlob?: StagedBlobUpload | null } = {},
): Promise<string> {
  if (isPluginInternalPath(mutation.path) || (mutation.toPath && isPluginInternalPath(mutation.toPath))) {
    throw new Error(`Refusing to sync plugin-internal path: ${mutation.toPath ?? mutation.path}`);
  }
  if (!shouldSyncPath(mutation.path) || (mutation.toPath && !shouldSyncPath(mutation.toPath))) {
    throw new Error(`Refusing to sync ignored path: ${mutation.toPath ?? mutation.path}`);
  }

  const existing = await tx<RevisionRow[]>`
    SELECT revision::TEXT AS revision
    FROM sync_events
    WHERE client_id = ${clientId}
      AND mutation_id = ${mutation.mutationId};
  `;
  if (existing[0]) {
    log.debug("mutation already accepted", {
      clientId,
      mutationId: mutation.mutationId,
      revision: existing[0].revision,
      operation: mutation.operation,
      path: mutation.path,
    });
    return existing[0].revision;
  }

  let stagedBlob: StagedBlobUpload | null = options.stagedBlob ?? null;
  if (mutation.operation === "UpsertFile" && mutation.storageKind === "lo" && mutation.blobUploadId) {
    stagedBlob = await consumeStagedBlob(tx, clientId, mutation.blobUploadId, mutation.path);
    if (!stagedBlob) {
      log.warn("large object metadata mutation referenced missing staged blob", {
        clientId,
        mutationId: mutation.mutationId,
        path: mutation.path,
        blobUploadId: mutation.blobUploadId,
      });
    }
  }

  if (mutation.operation === "UpsertFile" && mutation.storageKind === "lo" && !mutation.contentBytes && !stagedBlob) {
    const current = await tx<RevisionRow[]>`
      SELECT GREATEST(
        COALESCE((SELECT MAX(revision) FROM sync_events), 0),
        COALESCE((SELECT MAX(revision) FROM files), 0)
      )::TEXT AS revision;
    `;
    const revision = latestRevisionFromRows(current);
    log.warn("skipping large object metadata mutation without uploaded blob content", {
      clientId,
      mutationId: mutation.mutationId,
      path: mutation.path,
      byteSize: mutation.byteSize,
      contentSha256: mutation.contentSha256,
      blobUploadId: mutation.blobUploadId,
      revision,
    });
    return revision;
  }

  if (mutation.operation === "UpsertFile") {
    const isYjs = mutation.isYjs ?? shouldUseYjs(mutation.path);
    const storageKind = mutation.storageKind ?? (isYjs ? "text" : mutation.contentBytes ? "bytea" : "text");
    if (isYjs && storageKind !== "text") {
      throw new Error(`Yjs markdown file ${mutation.path} must use text storage`);
    }
    if (isYjs && mutation.yjsState) {
      const yjsContent = contentFromYjsState(mutation.yjsState);
      const content = mutation.content ?? "";
      if (yjsContent !== content) {
        throw new Error(`Yjs state/content mismatch for ${mutation.path}`);
      }
    }
  }

  let yjsUpdateResult: { content: string; state: Uint8Array; contentOid: number | null } | null = null;
  if (mutation.operation === "YjsUpdate") {
    if (!mutation.data) {
      throw new Error(`Yjs update for ${mutation.path} is missing payload`);
    }
    const current = await tx<{ yjsState: Uint8Array | null; contentOid: number | null }[]>`
      SELECT yjs_state AS "yjsState", content_oid AS "contentOid"
      FROM files
      WHERE path = ${mutation.path}
      FOR UPDATE;
    `;
    const next = applyYjsPayload(current[0]?.yjsState ?? null, mutation.data);
    if (next.hasPendingUpdates) {
      throw new Error(`Yjs update for ${mutation.path} has unresolved dependencies; run DocSync before uploading`);
    }
    yjsUpdateResult = {
      content: next.content,
      state: next.state,
      contentOid: current[0]?.contentOid ?? null,
    };
  }

  const inserted = await tx<RevisionRow[]>`
    INSERT INTO sync_events (
      client_id,
      mutation_id,
      operation,
      path,
      to_path,
      content,
      content_bytes,
      payload,
      storage_kind,
      byte_size,
      content_sha256,
      is_folder,
      is_yjs
    )
    VALUES (
      ${clientId},
      ${mutation.mutationId},
      ${mutation.operation},
      ${mutation.path},
      ${mutation.toPath ?? null},
      ${mutation.operation === "YjsUpdate" ? null : mutation.content ?? null},
      ${mutation.operation === "UpsertFile" ? mutation.contentBytes ?? null : null},
      ${mutation.data ?? null},
      ${mutation.storageKind ?? null},
      ${mutation.byteSize ?? null},
      ${mutation.contentSha256 ?? null},
      ${mutation.isFolder ?? null},
      ${mutation.isYjs ?? null}
    )
    RETURNING revision::TEXT AS revision;
  `;
  const revision = inserted[0].revision;
  log.debug("applying mutation", {
    clientId,
    mutationId: mutation.mutationId,
    revision,
    operation: mutation.operation,
    path: mutation.path,
    toPath: mutation.toPath,
    storageKind: mutation.storageKind,
    byteSize: mutation.byteSize ?? mutation.contentBytes?.byteLength ?? mutation.data?.byteLength,
  });

  if (mutation.operation === "CreateFolder") {
    const rows = await tx<{ contentOid: number | null }[]>`
      SELECT content_oid AS "contentOid"
      FROM files
      WHERE path = ${mutation.path}
      FOR UPDATE;
    `;
    await unlinkLargeObject(rows[0]?.contentOid, tx);
    await tx`
      INSERT INTO files (path, content, yjs_state, is_folder, is_yjs, deleted, revision, updated_at)
      VALUES (${mutation.path}, NULL, NULL, TRUE, FALSE, FALSE, ${revision}, NOW())
      ON CONFLICT (path) DO UPDATE SET
        content = NULL,
        content_bytes = NULL,
        content_oid = NULL,
        storage_kind = 'text',
        byte_size = NULL,
        content_sha256 = NULL,
        yjs_state = NULL,
        is_folder = TRUE,
        is_yjs = FALSE,
        deleted = FALSE,
        revision = EXCLUDED.revision,
        updated_at = NOW();
    `;
  } else if (mutation.operation === "UpsertFile") {
    const isYjs = mutation.isYjs ?? shouldUseYjs(mutation.path);
    const storageKind = mutation.storageKind ?? (isYjs ? "text" : mutation.contentBytes ? "bytea" : "text");
    const yjsState = isYjs ? mutation.yjsState ?? docStateFromContent(mutation.content ?? "") : null;
    const existingFile = await tx<{ contentOid: number | null }[]>`
      SELECT content_oid AS "contentOid"
      FROM files
      WHERE path = ${mutation.path}
      FOR UPDATE;
    `;
    const previousOid = existingFile[0]?.contentOid ?? null;
    const contentOid = storageKind === "lo"
      ? stagedBlob?.contentOid ?? (mutation.contentBytes ? (await createLargeObject(mutation.contentBytes, tx)).oid : null)
      : null;
    const byteSize = storageKind === "lo"
      ? stagedBlob?.byteSize ?? mutation.byteSize ?? mutation.contentBytes?.byteLength ?? null
      : mutation.byteSize ?? (mutation.contentBytes?.byteLength ?? (mutation.content ? new TextEncoder().encode(mutation.content).byteLength : null));
    const contentSha256 = stagedBlob?.contentSha256 ?? mutation.contentSha256 ?? null;
    if (previousOid && (storageKind !== "lo" || contentOid)) {
      await unlinkLargeObject(previousOid, tx);
    }
    await tx`
      INSERT INTO files (
        path,
        content,
        content_bytes,
        content_oid,
        storage_kind,
        byte_size,
        content_sha256,
        yjs_state,
        is_folder,
        is_yjs,
        deleted,
        revision,
        updated_at
      )
      VALUES (
        ${mutation.path},
        ${storageKind === "text" ? mutation.content ?? "" : null},
        ${storageKind === "bytea" ? mutation.contentBytes ?? null : null},
        ${contentOid},
        ${storageKind},
        ${byteSize},
        ${contentSha256},
        ${yjsState},
        FALSE,
        ${isYjs},
        FALSE,
        ${revision},
        NOW()
      )
      ON CONFLICT (path) DO UPDATE SET
        content = EXCLUDED.content,
        content_bytes = EXCLUDED.content_bytes,
        content_oid = CASE
          WHEN EXCLUDED.storage_kind = 'lo' AND EXCLUDED.content_oid IS NULL THEN files.content_oid
          ELSE EXCLUDED.content_oid
        END,
        storage_kind = EXCLUDED.storage_kind,
        byte_size = EXCLUDED.byte_size,
        content_sha256 = EXCLUDED.content_sha256,
        yjs_state = EXCLUDED.yjs_state,
        is_folder = FALSE,
        is_yjs = EXCLUDED.is_yjs,
        deleted = FALSE,
        revision = EXCLUDED.revision,
        updated_at = NOW();
    `;
  } else if (mutation.operation === "YjsUpdate") {
    if (!yjsUpdateResult) {
      throw new Error(`Yjs update for ${mutation.path} was not prepared`);
    }
    await unlinkLargeObject(yjsUpdateResult.contentOid, tx);
    await tx`
      INSERT INTO files (path, content, yjs_state, is_folder, is_yjs, deleted, revision, updated_at)
      VALUES (${mutation.path}, ${yjsUpdateResult.content}, ${yjsUpdateResult.state}, FALSE, TRUE, FALSE, ${revision}, NOW())
      ON CONFLICT (path) DO UPDATE SET
        content = EXCLUDED.content,
        content_bytes = NULL,
        content_oid = NULL,
        storage_kind = 'text',
        byte_size = OCTET_LENGTH(EXCLUDED.content),
        content_sha256 = NULL,
        yjs_state = EXCLUDED.yjs_state,
        is_folder = FALSE,
        is_yjs = TRUE,
        deleted = FALSE,
        revision = EXCLUDED.revision,
        updated_at = NOW();
    `;
  } else if (mutation.operation === "Delete") {
    if (mutation.isFolder) {
      const rows = await tx<{ contentOid: number | null }[]>`
        SELECT content_oid AS "contentOid"
        FROM files
        WHERE path = ${mutation.path}
           OR path LIKE ${folderDescendantLike(mutation.path)} ESCAPE '\\'
        FOR UPDATE;
      `;
      for (const row of rows) {
        await unlinkLargeObject(row.contentOid, tx);
      }
      await tx`
        UPDATE files
        SET deleted = TRUE,
            content = NULL,
            content_bytes = NULL,
            content_oid = NULL,
            content_sha256 = NULL,
            revision = ${revision},
            updated_at = NOW()
        WHERE path = ${mutation.path}
           OR path LIKE ${folderDescendantLike(mutation.path)} ESCAPE '\\';
      `;
    } else {
      const rows = await tx<{ contentOid: number | null }[]>`
        SELECT content_oid AS "contentOid"
        FROM files
        WHERE path = ${mutation.path}
        FOR UPDATE;
      `;
      await unlinkLargeObject(rows[0]?.contentOid, tx);
      await tx`
        INSERT INTO files (path, content, yjs_state, is_folder, is_yjs, deleted, revision, updated_at)
        VALUES (${mutation.path}, NULL, NULL, FALSE, FALSE, TRUE, ${revision}, NOW())
        ON CONFLICT (path) DO UPDATE SET
          content = NULL,
          content_bytes = NULL,
          content_oid = NULL,
          content_sha256 = NULL,
          deleted = TRUE,
          revision = EXCLUDED.revision,
          updated_at = NOW();
      `;
    }
  } else if (mutation.operation === "Rename") {
    if (!mutation.toPath) {
      throw new Error(`Rename for ${mutation.path} is missing destination`);
    }
    if (mutation.isFolder) {
      // Use PG length(), not JS .length: SUBSTRING counts Unicode characters, not UTF-16 code units.
      await tx`
        UPDATE files
        SET path = CASE
              WHEN path = ${mutation.path} THEN ${mutation.toPath}
              ELSE ${mutation.toPath} || SUBSTRING(path FROM length(${mutation.path}) + 1)
            END,
            revision = ${revision},
            updated_at = NOW()
        WHERE path = ${mutation.path}
           OR path LIKE ${folderDescendantLike(mutation.path)} ESCAPE '\\';
      `;
    } else {
      await tx`
        UPDATE files
        SET path = ${mutation.toPath},
            revision = ${revision},
            updated_at = NOW()
        WHERE path = ${mutation.path};
      `;
    }
  }

  return revision;
}

export type BlobMetadata = {
  path: string;
  contentOid: number | null;
  byteSize: number | null;
  contentSha256: string | null;
  revision: string;
};

type BlobMetadataRow = Omit<BlobMetadata, "byteSize"> & {
  byteSize: string | null;
};

function rowToBlobMetadata(row: BlobMetadataRow): BlobMetadata {
  return {
    ...row,
    byteSize: row.byteSize ? Number.parseInt(row.byteSize, 10) : null,
  };
}

export async function putBlobFile(
  path: string,
  data: Uint8Array | ReadableStream<Uint8Array>,
  contentSha256: string | null,
): Promise<BlobMetadata> {
  if (isPluginInternalPath(path)) {
    throw new Error(`Refusing to sync plugin-internal path: ${path}`);
  }
  if (!shouldSyncPath(path)) {
    throw new Error(`Refusing to sync ignored path: ${path}`);
  }
  return sql.begin(async tx => {
    const existing = await tx<{ contentOid: number | null }[]>`
      SELECT content_oid AS "contentOid"
      FROM files
      WHERE path = ${path}
      FOR UPDATE;
    `;
    await unlinkLargeObject(existing[0]?.contentOid, tx);
    const written = await createLargeObject(data, tx);
    const revision = await getServerRevision();
    const rows = await tx<BlobMetadataRow[]>`
      INSERT INTO files (
        path,
        content,
        content_bytes,
        content_oid,
        storage_kind,
        byte_size,
        content_sha256,
        yjs_state,
        is_folder,
        is_yjs,
        deleted,
        revision,
        updated_at
      )
      VALUES (${path}, NULL, NULL, ${written.oid}, 'lo', ${written.byteSize}, ${contentSha256}, NULL, FALSE, FALSE, FALSE, ${revision}, NOW())
      ON CONFLICT (path) DO UPDATE SET
        content = NULL,
        content_bytes = NULL,
        content_oid = EXCLUDED.content_oid,
        storage_kind = 'lo',
        byte_size = EXCLUDED.byte_size,
        content_sha256 = EXCLUDED.content_sha256,
        yjs_state = NULL,
        is_folder = FALSE,
        is_yjs = FALSE,
        deleted = FALSE,
        updated_at = NOW()
      RETURNING path, content_oid AS "contentOid", byte_size::TEXT AS "byteSize", content_sha256 AS "contentSha256", revision::TEXT AS revision;
    `;
    log.debug("blob metadata stored", {
      path,
      byteSize: written.byteSize,
      contentSha256,
      revision: rows[0]?.revision,
    });
    return rowToBlobMetadata(rows[0]!);
  });
}

export function streamBlobFile(metadata: BlobMetadata): ReadableStream<Uint8Array> {
  const oid = metadata.contentOid;
  if (!oid) {
    throw new Error("Blob metadata is missing content OID");
  }
  const total = metadata.byteSize ?? 0;
  const chunkSize = 1024 * 1024;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= total) {
        controller.close();
        return;
      }
      const length = Math.min(chunkSize, total - offset);
      const chunk = await readLargeObjectRange(oid, offset, length);
      offset += chunk.byteLength;
      if (chunk.byteLength === 0) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

export async function getBlobMetadata(path: string): Promise<BlobMetadata | null> {
  const rows = await sql<BlobMetadataRow[]>`
    SELECT path, content_oid AS "contentOid", byte_size::TEXT AS "byteSize", content_sha256 AS "contentSha256", revision::TEXT AS revision
    FROM files
    WHERE path = ${path}
      AND deleted = FALSE
      AND storage_kind = 'lo';
  `;
  return rows[0] ? rowToBlobMetadata(rows[0]) : null;
}

export async function readBlobFile(path: string): Promise<{ bytes: Uint8Array; metadata: BlobMetadata } | null> {
  const metadata = await getBlobMetadata(path);
  if (!metadata?.contentOid) {
    return null;
  }
  return {
    metadata,
    bytes: await readLargeObject(metadata.contentOid),
  };
}

export async function acceptMutations(clientId: string, mutations: SyncMutation[]): Promise<string> {
  if (mutations.length === 0) {
    log.debug("empty mutation batch accepted", { clientId });
    return getServerRevision();
  }

  log.info("accepting mutation batch", {
    clientId,
    mutations: mutations.length,
    operations: summarizeMutations(mutations),
  });
  const revision = await sql.begin(async tx => {
    let latest = "0";
    for (const mutation of mutations) {
      latest = await applyMutation(tx, clientId, mutation);
    }
    await tx`
      UPDATE clients
      SET last_seen_at = NOW(),
          last_acked_revision = GREATEST(last_acked_revision, ${latest}::BIGINT)
      WHERE client_id = ${clientId};
    `;
    return latest;
  });

  if (mutations.some(mutation => mutation.operation === "YjsUpdate")) {
    scheduleYjsCompaction();
  }
  log.info("mutation batch accepted", { clientId, revision });
  return revision;
}

async function flushFileBeforeCompaction(
  tx: typeof sql,
  path: string,
  maxRevision: string,
): Promise<void> {
  const fileRows = await tx<{ yjsState: Uint8Array | null }[]>`
    SELECT yjs_state AS "yjsState"
    FROM files
    WHERE path = ${path}
    FOR UPDATE;
  `;

  const eventRows = await tx<{ payload: Uint8Array }[]>`
    SELECT payload
    FROM sync_events
    WHERE path = ${path}
      AND operation = 'YjsUpdate'
      AND revision <= ${maxRevision}::BIGINT
      AND compacted = FALSE
    ORDER BY revision ASC;
  `;

  if (eventRows.length === 0) {
    return;
  }

  const merged = replayYjsPayloads(
    fileRows[0]?.yjsState ?? null,
    eventRows.map(row => row.payload),
  );

  await tx`
    UPDATE files
    SET content = ${merged.content},
        yjs_state = ${merged.state},
        is_yjs = TRUE,
        deleted = FALSE,
        updated_at = NOW()
    WHERE path = ${path};
  `;
}

export async function compactYjsEvents(): Promise<void> {
  const candidates = await sql<CompactionCandidate[]>`
    SELECT
      path,
      COUNT(*)::TEXT AS updates,
      COALESCE(SUM(OCTET_LENGTH(payload)), 0)::TEXT AS bytes,
      MAX(revision)::TEXT AS "maxRevision"
    FROM sync_events
    WHERE operation = 'YjsUpdate'
      AND compacted = FALSE
    GROUP BY path
    HAVING COUNT(*) >= ${compactionConfig.count}
        OR COALESCE(SUM(OCTET_LENGTH(payload)), 0) >= ${compactionConfig.bytes};
  `;

  for (const candidate of candidates) {
    log.info("compacting Yjs events", {
      path: candidate.path,
      updates: candidate.updates,
      bytes: candidate.bytes,
      maxRevision: candidate.maxRevision,
    });
    await sql.begin(async tx => {
      await flushFileBeforeCompaction(tx, candidate.path, candidate.maxRevision);
      await tx`
        UPDATE sync_events
        SET compacted = TRUE
        WHERE path = ${candidate.path}
          AND operation = 'YjsUpdate'
          AND revision <= ${candidate.maxRevision};
      `;
      await tx`
        DELETE FROM sync_events
        WHERE path = ${candidate.path}
          AND operation = 'YjsUpdate'
          AND compacted = TRUE
          AND revision <= ${candidate.maxRevision};
      `;
      await tx`
        UPDATE server_meta
        SET compacted_revision = GREATEST(compacted_revision, ${candidate.maxRevision}::BIGINT)
        WHERE id = 1;
      `;
    });
  }
}

export async function compactMaterializedSyncEvents(): Promise<string> {
  return sql.begin(async tx => {
    const rows = await tx<RevisionRow[]>`
      SELECT COALESCE(MAX(revision), 0)::TEXT AS revision
      FROM sync_events;
    `;
    const revision = latestRevisionFromRows(rows);
    if (revision === "0") {
      return await getCompactedRevision();
    }

    await tx`
      UPDATE server_meta
      SET compacted_revision = GREATEST(compacted_revision, ${revision}::BIGINT)
      WHERE id = 1;
    `;
    await tx`DELETE FROM sync_events WHERE revision <= ${revision}::BIGINT;`;
    return revision;
  });
}

export async function handlePull(packet: Extract<wsPacket, { type: opType.PullSince }>): Promise<wsPacket> {
  const hasState = await serverHasAnyState();
  if (!hasState) {
    log.info("pull requires initial upload", { revision: packet.revision });
    return {
      type: opType.InitRequired,
      serverRevision: "0",
      requestId: packet.requestId,
    };
  }

  const compactedRevision = await getCompactedRevision();
  if (BigInt(packet.revision) < BigInt(compactedRevision) || packet.revision === "0") {
    const snapshot = await snapshotPacket();
    log.info("pull returning snapshot reset", {
      requestedRevision: packet.revision,
      compactedRevision,
      targetRevision: snapshot.targetRevision,
      files: snapshot.files.length,
    });
    return { ...snapshot, requestId: packet.requestId };
  }

  const batch = await changeBatchPacket(packet.revision);
  log.info("pull returning change batch", {
    requestedRevision: packet.revision,
    serverRevision: batch.serverRevision,
    changes: batch.changes.length,
  });
  return { ...batch, requestId: packet.requestId };
}

export async function handleDocSync(paths: DocSyncPath[]): Promise<Extract<wsPacket, { type: opType.DocSyncAck }>> {
  const results: Extract<wsPacket, { type: opType.DocSyncAck }>["paths"] = [];

  for (const entry of paths) {
    const rows = await sql<{ yjsState: Uint8Array | null }[]>`
      SELECT yjs_state AS "yjsState"
      FROM files
      WHERE path = ${entry.path}
        AND deleted = FALSE
        AND is_yjs = TRUE;
    `;
    const serverDoc = new Y.Doc();
    if (rows[0]?.yjsState) {
      Y.applyUpdateV2(serverDoc, rows[0].yjsState);
    }
    const data = Y.encodeStateAsUpdateV2(serverDoc, entry.stateVector);
    const serverStateVector = Y.encodeStateVector(serverDoc);
    const yjsState = Y.encodeStateAsUpdateV2(serverDoc);
    serverDoc.destroy();
    results.push({ path: entry.path, data, stateVector: serverStateVector, yjsState });
    log.debug("DocSync path resolved", {
      path: entry.path,
      responseBytes: data.byteLength,
      serverStateVectorBytes: serverStateVector.byteLength,
      serverStateBytes: yjsState.byteLength,
    });
  }

  return { type: opType.DocSyncAck, paths: results };
}
