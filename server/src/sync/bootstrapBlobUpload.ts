import { sql } from "bun";
import { createLargeObject, unlinkLargeObject } from "../db/largeObject";
import { log } from "../logger";

export async function putBootstrapBlob(
  bootstrapId: string,
  path: string,
  data: Uint8Array | ReadableStream<Uint8Array>,
  contentSha256: string | null,
): Promise<{ byteSize: number; contentSha256: string | null }> {
  return sql.begin(async tx => {
    const existing = await tx<{ contentOid: number }[]>`
      SELECT content_oid AS "contentOid"
      FROM bootstrap_blobs
      WHERE bootstrap_id = ${bootstrapId}
        AND path = ${path}
      FOR UPDATE;
    `;
    const created = await createLargeObject(data, tx);
    await tx`
      INSERT INTO bootstrap_blobs (bootstrap_id, path, content_oid, byte_size, content_sha256)
      VALUES (${bootstrapId}, ${path}, ${created.oid}, ${created.byteSize}, ${contentSha256})
      ON CONFLICT (bootstrap_id, path) DO UPDATE SET
        content_oid = EXCLUDED.content_oid,
        byte_size = EXCLUDED.byte_size,
        content_sha256 = EXCLUDED.content_sha256,
        created_at = NOW();
    `;
    await unlinkLargeObject(existing[0]?.contentOid, tx);
    log.info("bootstrap blob staged", {
      bootstrapId,
      path,
      byteSize: created.byteSize,
      contentSha256,
    });
    return { byteSize: created.byteSize, contentSha256 };
  });
}
