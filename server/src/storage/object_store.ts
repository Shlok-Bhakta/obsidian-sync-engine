import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sql } from "bun";
import type { Hono } from "hono";
import { sha256Schema } from "obsidian-sync-protocol";
import { getAuthenticatedClient, requireBearer } from "../auth/auth";

export const DEFAULT_OBJECT_STORE_DIR = join(import.meta.dir, "../../object-data");
export const DEFAULT_MAX_OBJECT_BYTES = Number(process.env.MAX_OBJECT_BYTES ?? 100 * 1024 * 1024);

export class ObjectStore {
  constructor(
    readonly rootDirectory = DEFAULT_OBJECT_STORE_DIR,
    readonly maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES,
    private readonly registerObject: (hash: string, size: number, state: "staged" | "referenced") => Promise<void> = registerObjectInDatabase,
  ) {}

  pathForHash(hash: string): string {
    return join(this.rootDirectory, "objects", hash.slice(0, 2), hash);
  }

  async has(hash: string): Promise<boolean> {
    if (!sha256Schema.safeParse(hash).success) return false;
    return Bun.file(this.pathForHash(hash)).exists();
  }

  async read(hash: string): Promise<Uint8Array> {
    sha256Schema.parse(hash);
    const bytes = new Uint8Array(await Bun.file(this.pathForHash(hash)).arrayBuffer());
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== hash) throw new Error("stored object failed hash verification");
    return bytes;
  }

  async putBytes(bytes: Uint8Array, referenceState: "staged" | "referenced" = "staged"): Promise<string> {
    if (bytes.byteLength > this.maxObjectBytes) throw new Error("object exceeds configured size limit");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const destination = this.pathForHash(hash);
    await mkdir(dirname(destination), { recursive: true });
    if (!(await Bun.file(destination).exists())) {
      const temp = `${destination}.tmp-${randomUUID()}`;
      await Bun.write(temp, bytes);
      try { await rename(temp, destination); } catch (error) {
        await rm(temp, { force: true });
        if (!(await Bun.file(destination).exists())) throw error;
      }
    }
    await this.register(hash, bytes.byteLength, referenceState);
    return hash;
  }

  async putRequest(hash: string, request: Request): Promise<{ hash: string; byteSize: number; existed: boolean }> {
    sha256Schema.parse(hash);
    const declaredSizeValue = request.headers.get("Content-Length");
    const declaredSize = declaredSizeValue === null ? null : Number(declaredSizeValue);
    if (declaredSize !== null && (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > this.maxObjectBytes)) {
      throw new ObjectStoreError("SIZE_LIMIT", "The declared object size is invalid or too large", 413);
    }
    const destination = this.pathForHash(hash);
    await mkdir(dirname(destination), { recursive: true });
    const existed = await Bun.file(destination).exists();

    const temp = `${destination}.tmp-${randomUUID()}`;
    const handle = await open(temp, "wx", 0o600);
    const digest = createHash("sha256");
    let byteSize = 0;
    let writeFailure: unknown;
    try {
      const reader = request.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        byteSize += value.byteLength;
        if (byteSize > this.maxObjectBytes) throw new ObjectStoreError("SIZE_LIMIT", "Object exceeds configured size limit", 413);
        digest.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const { bytesWritten } = await handle.write(value, offset, value.byteLength - offset);
          if (bytesWritten === 0) throw new Error("object temporary file write made no progress");
          offset += bytesWritten;
        }
      }
      await handle.sync();
    } catch (error) {
      writeFailure = error;
    } finally {
      await handle.close();
    }
    if (writeFailure) {
      await rm(temp, { force: true });
      throw writeFailure;
    }
    if (declaredSize !== null && byteSize !== declaredSize) {
      await rm(temp, { force: true });
      throw new ObjectStoreError("SIZE_MISMATCH", "The received size does not match Content-Length", 400);
    }
    if (digest.digest("hex") !== hash) {
      await rm(temp, { force: true });
      throw new ObjectStoreError("HASH_MISMATCH", "The received object does not match its declared hash", 400);
    }
    if (existed) {
      const existing = await stat(destination);
      await rm(temp, { force: true });
      if (existing.size !== byteSize) throw new ObjectStoreError("SIZE_MISMATCH", "The existing object has an inconsistent size", 500);
    } else {
      try { await rename(temp, destination); } catch (error) {
        await rm(temp, { force: true });
        if (!(await Bun.file(destination).exists())) throw error;
      }
    }
    await this.register(hash, byteSize, "staged");
    return { hash, byteSize, existed };
  }

  async markReferenced(hash: string): Promise<void> {
    await sql`UPDATE objects SET reference_state = 'referenced', referenced_at = COALESCE(referenced_at, NOW()) WHERE sha256 = ${hash}`;
  }

  async collectGarbage(graceHours = 168): Promise<number> {
    const rows = await sql<{ sha256: string }[]>`
      DELETE FROM objects
      WHERE reference_state = 'staged' AND created_at < NOW() - (${graceHours}::text || ' hours')::interval
        AND NOT EXISTS (SELECT 1 FROM files WHERE object_hash = objects.sha256 OR yjs_state_hash = objects.sha256)
        AND NOT EXISTS (SELECT 1 FROM sync_events WHERE object_hash = objects.sha256)
      RETURNING sha256
    `;
    await Promise.all(rows.map((row) => rm(this.pathForHash(row.sha256), { force: true })));
    return rows.length;
  }

  private async register(hash: string, size: number, state: "staged" | "referenced"): Promise<void> {
    await this.registerObject(hash, size, state);
  }
}

async function registerObjectInDatabase(hash: string, size: number, state: "staged" | "referenced"): Promise<void> {
  await sql`
    INSERT INTO objects(sha256, byte_size, reference_state, referenced_at)
    VALUES (${hash}, ${size}, ${state}, ${state === "referenced" ? new Date() : null})
    ON CONFLICT (sha256) DO UPDATE SET
      byte_size = EXCLUDED.byte_size,
      reference_state = CASE WHEN objects.reference_state = 'referenced' THEN 'referenced' ELSE EXCLUDED.reference_state END,
      referenced_at = COALESCE(objects.referenced_at, EXCLUDED.referenced_at)
  `;
}

export class ObjectStoreError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

export const objectStore = new ObjectStore(process.env.OBJECT_STORE_DIR ?? DEFAULT_OBJECT_STORE_DIR);

export function registerObjectStoreRoutes(app: Hono, store = objectStore): void {
  app.put("/v1/objects/:sha256", requireBearer, async (c) => {
    getAuthenticatedClient(c);
    try {
      const result = await store.putRequest(c.req.param("sha256") ?? "", c.req.raw);
      return c.json(result, result.existed ? 200 : 201);
    } catch (error) {
      if (error instanceof ObjectStoreError) return c.json({ code: error.code, message: error.message }, error.status as 400);
      if (!sha256Schema.safeParse(c.req.param("sha256")).success) return c.json({ code: "INVALID_HASH", message: "Invalid SHA-256 path" }, 400);
      throw error;
    }
  });

  app.on("HEAD", "/v1/objects/:sha256", requireBearer, async (c) => {
    const hash = c.req.param("sha256") ?? "";
    if (!sha256Schema.safeParse(hash).success || !(await store.has(hash))) return c.body(null, 404);
    const info = await stat(store.pathForHash(hash));
    return c.body(null, 200, { "Content-Length": String(info.size), ETag: `"${hash}"` });
  });

  app.get("/v1/objects/:sha256", requireBearer, async (c) => {
    const hash = c.req.param("sha256") ?? "";
    if (!sha256Schema.safeParse(hash).success || !(await store.has(hash))) return c.json({ code: "OBJECT_NOT_FOUND", message: "Object not found" }, 404);
    const info = await stat(store.pathForHash(hash));
    return new Response(Bun.file(store.pathForHash(hash)), {
      headers: { "Content-Type": "application/octet-stream", "Content-Length": String(info.size), ETag: `"${hash}"`, "Cache-Control": "private, immutable" },
    });
  });
}
