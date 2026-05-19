import { sql } from "bun";
import { DocSyncPath, opType, ServerChange, SyncMutation, wsPacket } from "../../../shared/types";
import { folderDescendantLike } from "../sqlUtils";
import * as Y from "yjs";
import {
  applyYjsPayload,
  docStateFromContent,
  encodeMissingUpdate,
  replayYjsPayloads,
} from "../yjs/apply";

export type CompactionConfig = {
  count: number;
  bytes: number;
};

export const defaultCompactionConfig: CompactionConfig = {
  count: 100,
  bytes: 1024 * 1024,
};

let compactionConfig: CompactionConfig = { ...defaultCompactionConfig };

export function setCompactionConfig(config: Partial<CompactionConfig>): void {
  compactionConfig = { ...compactionConfig, ...config };
}

export function resetCompactionConfig(): void {
  compactionConfig = { ...defaultCompactionConfig };
}

type RevisionRow = {
  revision: string;
};

export type ServerFileRow = {
  path: string;
  content: string | null;
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
  payload: Uint8Array | null;
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
      payload,
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
    yjsState: row.isYjs && !row.deleted && row.yjsState ? row.yjsState : undefined,
    isFolder: row.isFolder,
    isYjs: row.isYjs,
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
    data: row.payload ?? undefined,
    isFolder: row.isFolder ?? undefined,
    isYjs: row.isYjs ?? undefined,
    created: new Date(row.createdAt).getTime(),
  };
}

export async function snapshotPacket(): Promise<Extract<wsPacket, { type: opType.SnapshotReset }>> {
  const files = await sql<ServerFileRow[]>`
    SELECT
      path,
      content,
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
    files: files.map(rowToSnapshotChange),
  };
}

export async function changeBatchPacket(fromRevision: string): Promise<Extract<wsPacket, { type: opType.ChangeBatch }>> {
  const rows = await sql<EventRow[]>`
    SELECT
      revision::TEXT AS revision,
      client_id AS "clientId",
      mutation_id AS "mutationId",
      operation,
      path,
      to_path AS "toPath",
      content,
      payload,
      compacted,
      is_folder AS "isFolder",
      is_yjs AS "isYjs",
      EXTRACT(EPOCH FROM created_at) * 1000 AS "createdAt"
    FROM sync_events
    WHERE revision > ${fromRevision}
    ORDER BY revision ASC;
  `;
  return {
    type: opType.ChangeBatch,
    fromRevision,
    serverRevision: await getServerRevision(),
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

async function applyMutation(tx: typeof sql, clientId: string, mutation: SyncMutation): Promise<string> {
  const existing = await tx<RevisionRow[]>`
    SELECT revision::TEXT AS revision
    FROM sync_events
    WHERE client_id = ${clientId}
      AND mutation_id = ${mutation.mutationId};
  `;
  if (existing[0]) {
    return existing[0].revision;
  }

  const inserted = await tx<RevisionRow[]>`
    INSERT INTO sync_events (
      client_id,
      mutation_id,
      operation,
      path,
      to_path,
      content,
      payload,
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
      ${mutation.data ?? null},
      ${mutation.isFolder ?? null},
      ${mutation.isYjs ?? null}
    )
    RETURNING revision::TEXT AS revision;
  `;
  const revision = inserted[0].revision;

  if (mutation.operation === "CreateFolder") {
    await tx`
      INSERT INTO files (path, content, yjs_state, is_folder, is_yjs, deleted, revision, updated_at)
      VALUES (${mutation.path}, NULL, NULL, TRUE, FALSE, FALSE, ${revision}, NOW())
      ON CONFLICT (path) DO UPDATE SET
        content = NULL,
        yjs_state = NULL,
        is_folder = TRUE,
        is_yjs = FALSE,
        deleted = FALSE,
        revision = EXCLUDED.revision,
        updated_at = NOW();
    `;
  } else if (mutation.operation === "UpsertFile") {
    const isYjs = mutation.isYjs ?? mutation.path.endsWith(".md");
    const yjsState = isYjs ? docStateFromContent(mutation.content ?? "") : null;
    await tx`
      INSERT INTO files (path, content, yjs_state, is_folder, is_yjs, deleted, revision, updated_at)
      VALUES (${mutation.path}, ${mutation.content ?? ""}, ${yjsState}, FALSE, ${isYjs}, FALSE, ${revision}, NOW())
      ON CONFLICT (path) DO UPDATE SET
        content = EXCLUDED.content,
        yjs_state = EXCLUDED.yjs_state,
        is_folder = FALSE,
        is_yjs = EXCLUDED.is_yjs,
        deleted = FALSE,
        revision = EXCLUDED.revision,
        updated_at = NOW();
    `;
  } else if (mutation.operation === "YjsUpdate") {
    if (!mutation.data) {
      throw new Error(`Yjs update for ${mutation.path} is missing payload`);
    }
    const current = await tx<{ yjsState: Uint8Array | null }[]>`
      SELECT yjs_state AS "yjsState"
      FROM files
      WHERE path = ${mutation.path}
      FOR UPDATE;
    `;
    const next = applyYjsPayload(current[0]?.yjsState ?? null, mutation.data);
    await tx`
      INSERT INTO files (path, content, yjs_state, is_folder, is_yjs, deleted, revision, updated_at)
      VALUES (${mutation.path}, ${next.content}, ${next.state}, FALSE, TRUE, FALSE, ${revision}, NOW())
      ON CONFLICT (path) DO UPDATE SET
        content = EXCLUDED.content,
        yjs_state = EXCLUDED.yjs_state,
        is_folder = FALSE,
        is_yjs = TRUE,
        deleted = FALSE,
        revision = EXCLUDED.revision,
        updated_at = NOW();
    `;
  } else if (mutation.operation === "Delete") {
    if (mutation.isFolder) {
      await tx`
        UPDATE files
        SET deleted = TRUE,
            revision = ${revision},
            updated_at = NOW()
        WHERE path = ${mutation.path}
           OR path LIKE ${folderDescendantLike(mutation.path)} ESCAPE '\\';
      `;
    } else {
      await tx`
        INSERT INTO files (path, content, yjs_state, is_folder, is_yjs, deleted, revision, updated_at)
        VALUES (${mutation.path}, NULL, NULL, FALSE, FALSE, TRUE, ${revision}, NOW())
        ON CONFLICT (path) DO UPDATE SET
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

export async function acceptMutations(clientId: string, mutations: SyncMutation[]): Promise<string> {
  if (mutations.length === 0) {
    return getServerRevision();
  }

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

  await compactYjsEvents();
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

export async function handlePull(packet: Extract<wsPacket, { type: opType.PullSince }>): Promise<wsPacket> {
  const hasState = await serverHasAnyState();
  if (!hasState && packet.revision === "0") {
    return {
      type: opType.InitRequired,
      serverRevision: "0",
    };
  }

  const compactedRevision = await getCompactedRevision();
  if (BigInt(packet.revision) < BigInt(compactedRevision) || packet.revision === "0") {
    return snapshotPacket();
  }

  return changeBatchPacket(packet.revision);
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
  }

  return { type: opType.DocSyncAck, paths: results };
}
