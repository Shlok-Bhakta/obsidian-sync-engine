import { sql } from "bun";
import { isPluginInternalPath, shouldSyncPath } from "../../../shared/pathPolicy";
import { createLargeObject, unlinkLargeObject } from "../db/largeObject";

export type StagedBlobUpload = {
  uploadId: string;
  clientId: string;
  path: string;
  contentOid: number;
  byteSize: number;
  contentSha256: string | null;
};

type StagedBlobUploadRow = Omit<StagedBlobUpload, "byteSize"> & {
  byteSize: string;
};

function rowToStagedBlob(row: StagedBlobUploadRow): StagedBlobUpload {
  return {
    ...row,
    byteSize: Number.parseInt(row.byteSize, 10),
  };
}

export async function stageBlobFile(
  clientId: string,
  path: string,
  data: Uint8Array | ReadableStream<Uint8Array>,
  contentSha256: string | null,
): Promise<StagedBlobUpload> {
  if (isPluginInternalPath(path)) {
    throw new Error(`Refusing to sync plugin-internal path: ${path}`);
  }
  if (!shouldSyncPath(path)) {
    throw new Error(`Refusing to sync ignored path: ${path}`);
  }
  return sql.begin(async tx => {
    const uploadId = `blob_${crypto.randomUUID()}`;
    const written = await createLargeObject(data, tx);
    const rows = await tx<StagedBlobUploadRow[]>`
      INSERT INTO blob_uploads (upload_id, client_id, path, content_oid, byte_size, content_sha256)
      VALUES (${uploadId}, ${clientId}, ${path}, ${written.oid}, ${written.byteSize}, ${contentSha256})
      RETURNING
        upload_id AS "uploadId",
        client_id AS "clientId",
        path,
        content_oid AS "contentOid",
        byte_size::TEXT AS "byteSize",
        content_sha256 AS "contentSha256";
    `;
    return rowToStagedBlob(rows[0]);
  });
}

export async function consumeStagedBlob(
  tx: typeof sql,
  clientId: string,
  uploadId: string,
  path: string,
): Promise<StagedBlobUpload | null> {
  const rows = await tx<StagedBlobUploadRow[]>`
    DELETE FROM blob_uploads
    WHERE upload_id = ${uploadId}
      AND client_id = ${clientId}
      AND path = ${path}
    RETURNING
      upload_id AS "uploadId",
      client_id AS "clientId",
      path,
      content_oid AS "contentOid",
      byte_size::TEXT AS "byteSize",
      content_sha256 AS "contentSha256";
  `;
  return rows[0] ? rowToStagedBlob(rows[0]) : null;
}

export async function deleteStagedBlob(uploadId: string): Promise<void> {
  await sql.begin(async tx => {
    const rows = await tx<{ contentOid: number }[]>`
      DELETE FROM blob_uploads
      WHERE upload_id = ${uploadId}
      RETURNING content_oid AS "contentOid";
    `;
    for (const row of rows) {
      await unlinkLargeObject(row.contentOid, tx);
    }
  });
}
