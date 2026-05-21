import { sql } from "bun";
import { SyncMutation } from "../../../shared/types";
import { applyMutation } from "./engine";
import { unlinkLargeObject } from "../db/largeObject";
import { log } from "../logger";

function summarizeMutations(mutations: SyncMutation[]): Record<string, number> {
  return mutations.reduce<Record<string, number>>((summary, mutation) => {
    summary[mutation.operation] = (summary[mutation.operation] ?? 0) + 1;
    return summary;
  }, {});
}

export async function acceptBootstrapSnapshot(
  clientId: string,
  bootstrapId: string,
  mutations: SyncMutation[],
): Promise<{ revision: string; files: number }> {
  if (mutations.length === 0) {
    throw new Error("Bootstrap snapshot is empty");
  }

  const manifestPaths = new Set(mutations.map(mutation => mutation.path));
  log.info("accepting bootstrap snapshot", {
    clientId,
    bootstrapId,
    mutations: mutations.length,
    files: manifestPaths.size,
    operations: summarizeMutations(mutations),
  });

  const revision = await sql.begin(async tx => {
    await tx`
      CREATE TEMP TABLE bootstrap_manifest_paths (
        path TEXT PRIMARY KEY
      ) ON COMMIT DROP;
    `;
    for (const path of manifestPaths) {
      await tx`
        INSERT INTO bootstrap_manifest_paths (path)
        VALUES (${path})
        ON CONFLICT (path) DO NOTHING;
      `;
    }

    await tx`DELETE FROM sync_events;`;

    let latest = "0";
    for (const mutation of mutations) {
      if (mutation.operation === "UpsertFile" && mutation.storageKind === "lo") {
        const staged = await tx<{
          contentOid: number;
          byteSize: string;
          contentSha256: string | null;
        }[]>`
          SELECT
            content_oid AS "contentOid",
            byte_size::TEXT AS "byteSize",
            content_sha256 AS "contentSha256"
          FROM bootstrap_blobs
          WHERE bootstrap_id = ${bootstrapId}
            AND path = ${mutation.path}
          FOR UPDATE;
        `;
        if (!staged[0]) {
          throw new Error(`Bootstrap blob is missing for ${mutation.path}`);
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
            NULL,
            NULL,
            ${staged[0].contentOid},
            'lo',
            ${staged[0].byteSize}::BIGINT,
            ${staged[0].contentSha256},
            NULL,
            FALSE,
            FALSE,
            FALSE,
            0,
            NOW()
          )
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
            updated_at = NOW();
        `;
      }
      latest = await applyMutation(tx, clientId, {
        ...mutation,
        mutationId: `bootstrap:${bootstrapId}:${mutation.mutationId}`,
      });
    }

    const staleRows = await tx<{ contentOid: number | null }[]>`
      SELECT content_oid AS "contentOid"
      FROM files
      WHERE NOT EXISTS (
        SELECT 1
        FROM bootstrap_manifest_paths
        WHERE bootstrap_manifest_paths.path = files.path
      );
    `;
    for (const row of staleRows) {
      await unlinkLargeObject(row.contentOid, tx);
    }
    await tx`
      DELETE FROM files
      WHERE NOT EXISTS (
        SELECT 1
        FROM bootstrap_manifest_paths
        WHERE bootstrap_manifest_paths.path = files.path
      );
    `;
    await tx`
      UPDATE clients
      SET last_seen_at = NOW(),
          last_acked_revision = GREATEST(last_acked_revision, ${latest}::BIGINT)
      WHERE client_id = ${clientId};
    `;
    await tx`
      DELETE FROM bootstrap_blobs
      WHERE bootstrap_id = ${bootstrapId};
    `;
    return latest;
  });

  log.info("bootstrap snapshot accepted", {
    clientId,
    bootstrapId,
    revision,
    files: manifestPaths.size,
  });
  return { revision, files: manifestPaths.size };
}
