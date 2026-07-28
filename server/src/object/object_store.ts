import { Context, Hono } from "hono";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { $, sql } from "bun";
import { createClient, getClientIdFromAuthorization } from "../auth/auth";
import { assertBootstrapAuthorized } from "../auth/bootstrapToken";
import { canonicalizePath, InvalidPathError } from "./paths";

export { InvalidPathError };

export const DEFAULT_OBJECT_STORE_DIR = resolve(
    import.meta.dir,
    "../../",
    process.env.OBJECT_STORE_DIR ?? "object-data",
);

/**
 * Advisory-lock key shared by every upload/delete. Holding it from the
 * moment we ask Postgres for the next revision until the transaction
 * commits (or rolls back) guarantees commit order matches revision order:
 * a transaction cannot observe/assign a revision while another
 * revision-assigning transaction is still in flight, so a lower revision
 * can never commit after a client has already observed a higher one.
 */
const REVISION_LOCK_KEY = "obsidian-sync-revision";

export type ObjectStoreUploadContent = {
    path: string;
    content: Bun.BlobOrStringOrBuffer;
    id: string;
};

export type ObjectStoreUploadResult = {
    path: string;
    bytesWritten: number;
    revision: number;
};

export type ObjectStoreOutboxItem = {
    path: string;
    lastUpdatedRevision: number;
    isDeleted: boolean;
};

type FileContentRow = { last_updated_revision: number };

/** Normalizes any upload body shape into a Buffer suitable for a BYTEA column. */
async function toBuffer(content: Bun.BlobOrStringOrBuffer): Promise<Buffer> {
    if (typeof content === "string") {
        return Buffer.from(content, "utf-8");
    }
    if (content instanceof Blob) {
        return Buffer.from(await content.arrayBuffer());
    }
    if (ArrayBuffer.isView(content)) {
        return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    }
    return Buffer.from(content);
}

/** Copies a Buffer/Uint8Array read back from Postgres into a right-sized ArrayBuffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// Object store backed entirely by Postgres: file bytes live in the `files.content`
// BYTEA column alongside their metadata, written in the same transaction so there is
// no window where metadata and bytes can disagree (no dual-write race with disk).
export class ObjectStore {
    constructor(private readonly rootDirectory = DEFAULT_OBJECT_STORE_DIR) {}

    /**
     * All store methods take already-decoded paths. Callers (routes) are responsible for
     * decoding: query params are decoded once by the URL parser already, headers are not.
     */
    async upload(content: ObjectStoreUploadContent): Promise<ObjectStoreUploadResult> {
        const path = canonicalizePath(content.path);
        const buffer = await toBuffer(content.content);

        const [row] = (await sql.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${REVISION_LOCK_KEY}))`;
            return tx<FileContentRow[]>`
                INSERT INTO files (file_path, author_id, content, file_is_deleted)
                VALUES (${path}, ${content.id}, ${buffer}, FALSE)
                ON CONFLICT (file_path) DO UPDATE SET
                    author_id = EXCLUDED.author_id,
                    content = EXCLUDED.content,
                    file_is_deleted = FALSE,
                    last_updated_revision = EXCLUDED.last_updated_revision,
                    updated_at = NOW()
                RETURNING last_updated_revision
            `;
        })) as FileContentRow[];

        return {
            path,
            bytesWritten: buffer.byteLength,
            revision: Number(row.last_updated_revision),
        };
    }

    /** Soft-deletes a file. Idempotent: unknown paths get a tombstone revision. */
    async delete(path: string, authorId: string): Promise<{ revision: number }> {
        const canonicalPath = canonicalizePath(path);

        const [row] = (await sql.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${REVISION_LOCK_KEY}))`;
            return tx<FileContentRow[]>`
                INSERT INTO files (file_path, author_id, file_is_deleted, content)
                VALUES (${canonicalPath}, ${authorId}, TRUE, NULL)
                ON CONFLICT (file_path) DO UPDATE SET
                    author_id = EXCLUDED.author_id,
                    file_is_deleted = TRUE,
                    content = NULL,
                    updated_at = NOW(),
                    last_updated_revision = NEXTVAL('global_revision')
                RETURNING last_updated_revision
            `;
        })) as FileContentRow[];
        return { revision: Number(row.last_updated_revision) };
    }

    /** Current global tip revision: highest revision stamped on any file (including deletes), or 0 if none exist. */
    async getTipRevision(): Promise<number> {
        const [row] = await sql<{ tip: string | null }[]>`
            SELECT MAX(last_updated_revision) AS tip FROM files
        `;
        return row?.tip ? Number(row.tip) : 0;
    }

    /** Downloads a file's bytes. Returns null if the file doesn't exist, is soft-deleted, or has no content. */
    async download(path: string): Promise<ArrayBuffer | null> {
        const canonicalPath = canonicalizePath(path);

        const [row] = await sql<{ file_is_deleted: boolean; content: Buffer | null }[]>`
            SELECT file_is_deleted, content FROM files WHERE file_path = ${canonicalPath}
        `;
        if (!row || row.file_is_deleted || row.content === null) {
            return null;
        }
        return toArrayBuffer(row.content);
    }

    /**
     * One-shot upgrade helper: for rows with NULL content, copy bytes from the
     * legacy filesystem object store (OBJECT_STORE_DIR) if present. Safe to call
     * repeatedly — only fills missing BYTEA values and never bumps revisions.
     */
    async backfillContentFromLegacyDisk(): Promise<number> {
        const missing = await sql<{ file_path: string }[]>`
            SELECT file_path FROM files
            WHERE file_is_deleted = FALSE AND content IS NULL
        `;
        let filled = 0;
        for (const { file_path } of missing) {
            let diskPath: string;
            try {
                diskPath = resolve(this.rootDirectory, file_path);
                if (
                    diskPath !== resolve(this.rootDirectory) &&
                    !diskPath.startsWith(resolve(this.rootDirectory) + "/")
                ) {
                    continue;
                }
            } catch {
                continue;
            }
            const file = Bun.file(diskPath);
            if (!(await file.exists())) {
                continue;
            }
            const bytes = Buffer.from(await file.arrayBuffer());
            const result = await sql`
                UPDATE files
                SET content = ${bytes}, updated_at = NOW()
                WHERE file_path = ${file_path}
                  AND file_is_deleted = FALSE
                  AND content IS NULL
            `;
            if (Number(result.count ?? 0) > 0) {
                filled++;
            }
        }
        return filled;
    }

    async bootstrap_zip_create(path: string): Promise<void> {
        const tmp = await mkdtemp(join(tmpdir(), "obsidian-bootstrap-copy-"));
        const vaultDir = join(tmp, "vault");
        try {
            await mkdir(vaultDir, { recursive: true });

            // Snapshot the tip BEFORE reading file rows: if we read it after, a file
            // landing between the read and the tip snapshot could be reflected in the
            // tip without its bytes making it into the zip, so the client would never
            // fetch it (it thinks it's already past that revision). Reading before
            // means the worst case is an extra file the client already has bytes for
            // (harmless) rather than a missing one (unrecoverable without a re-bootstrap).
            const revision = await this.getTipRevision();

            // Bootstrap should not ship tombstoned files; the client learns about
            // deletes via the inbox once it starts polling from `revision`.
            const files = await sql<{ file_path: string; content: Buffer | null }[]>`
                SELECT file_path, content FROM files
                WHERE file_is_deleted = FALSE AND content IS NOT NULL
            `;
            for (const file of files) {
                const dest = join(vaultDir, file.file_path);
                await mkdir(dirname(dest), { recursive: true });
                await Bun.write(dest, file.content as Buffer);
            }

            const name_choices = [
                "acrobat", "banana", "camera", "diamond", "elephant",
                "forest", "galaxy", "horizon", "indigo", "jungle",
                "koala", "lantern", "mystery", "network", "ocean",
                "pyramid", "quantum", "shadow", "tornado", "volcano",
            ];
            const pick = () => name_choices[Math.floor(Math.random() * name_choices.length)];
            const clientName = `${pick()}-${pick()}`;
            const clientSecret = await createClient(clientName);

            const pluginDir = join(vaultDir, ".obsidian/plugins/obsidian-sync-engine");
            await mkdir(pluginDir, { recursive: true });
            const dataPath = join(pluginDir, "data.json");
            // B1 seed intentionally does not upload the plugin's data.json, so a
            // freshly seeded object store often has no settings file yet. Default
            // to an empty object rather than failing bootstrap.
            let settings: Record<string, unknown> = {};
            const dataFile = Bun.file(dataPath);
            if (await dataFile.exists()) {
                try {
                    settings = await dataFile.json() as Record<string, unknown>;
                } catch {
                    settings = {};
                }
            }
            await Bun.write(dataPath, JSON.stringify({
                ...settings,
                clientName,
                clientSecret,
                revision,
            }, null, 2));

            await $`zip -qr ${path} .`.cwd(vaultDir);
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
    }

    // to create the client inbox
    async inbox(rev: number): Promise<ObjectStoreOutboxItem[]> {
        const result = await sql<{ file_path: string; last_updated_revision: string; file_is_deleted: boolean }[]>`
            SELECT file_path, last_updated_revision, file_is_deleted FROM files
            WHERE last_updated_revision > ${rev}
            ORDER BY last_updated_revision ASC
        `;
        // console.log("result", result);
        return result.map((r: { file_path: string; last_updated_revision: string; file_is_deleted: boolean }) => ({
            path: r.file_path,
            lastUpdatedRevision: Number(r.last_updated_revision),
            isDeleted: r.file_is_deleted,
        }));
    }
}

export const objectStore = new ObjectStore();

/**
 * Resolves the file path for a request, decoding exactly once regardless of source:
 * query params are already percent-decoded by the URL parser, headers are not.
 */
function resolvePathFromRequest(c: Context): string | undefined {
    const queryPath = c.req.query("path");
    if (queryPath !== undefined) {
        return queryPath;
    }
    const headerPath = c.req.header("X-Obsidian-Path");
    if (headerPath === undefined) {
        return undefined;
    }
    return decodeURIComponent(headerPath);
}

export function registerObjectStoreRoutes(app: Hono, store = objectStore) {
    // Chain so Hono accumulates route types (needed by testClient inference).
    return app
        .post('/files', async (c) => {
            const path = resolvePathFromRequest(c);
            const authorization = c.req.header("Authorization");
            if (!authorization) {
                return c.json({ error: "Authorization is required" }, 400);
            }
            if (!path) {
                return c.json({ error: "Request body is required" }, 400);
            }

            const clientId = await getClientIdFromAuthorization(authorization);
            try {
                const result = await store.upload({
                    path: path,
                    content: await c.req.arrayBuffer(),
                    id: clientId
                });
                return c.json(result, 200);
            } catch (error) {
                if (error instanceof InvalidPathError) {
                    return c.json({ error: "Invalid path" }, 400);
                }
                throw error;
            }
        })
        .get('/bootstrap.zip', async (c) => {
            const authz = assertBootstrapAuthorized({
                authorizationHeader: c.req.header("Authorization"),
                queryToken: c.req.query("token"),
            });
            if (!authz.ok) {
                return c.json({ error: authz.error }, authz.status);
            }

            const tmp = await mkdtemp(join(tmpdir(), "obsidian-bootstrap-"));
            const zipPath = join(tmp, "vault.zip");

            try {
                await store.bootstrap_zip_create(zipPath);

                setTimeout(() => void rm(tmp, { recursive: true, force: true }), 10 * 60 * 1000);
                return new Response(Bun.file(zipPath), {
                    headers: {
                        "Content-Type": "application/zip",
                        "Content-Disposition": `attachment; filename="obsidian-bootstrap-${Date.now()}.zip"`,
                        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
                        "Pragma": "no-cache",
                        "Expires": "0",
                    },
                });
            } catch (error) {
                await rm(tmp, { recursive: true, force: true });
                throw error;
            }
        })
        .get('/inbox', async (c) => {
            const authorization = c.req.header("Authorization");
            if (!authorization) {
                return c.json({ error: "Authorization is required" }, 400);
            }
            await getClientIdFromAuthorization(authorization);

            const rev = Number(c.req.query("rev"));
            const inbox = await store.inbox(rev);
            const lines = inbox.map((item) => JSON.stringify({
                rev: item.lastUpdatedRevision,
                op: item.isDeleted ? "delete" : "put",
                path: item.path,
            }));
            const body = lines.length > 0 ? lines.join("\n") + "\n" : "";
            return new Response(body, {
                status: 200,
                headers: { "Content-Type": "application/x-ndjson" },
            });
        })
        .get('/files', async (c) => {
            const authorization = c.req.header("Authorization");
            if (!authorization) {
                return c.json({ error: "Authorization is required" }, 400);
            }
            const path = resolvePathFromRequest(c);
            if (!path) {
                return c.json({ error: "path is required" }, 400);
            }
            try {
                await getClientIdFromAuthorization(authorization);
            } catch {
                return c.json({ error: "Unauthorized" }, 401);
            }

            try {
                const data = await store.download(path);
                if (!data) {
                    return c.json({ error: "Not found" }, 404);
                }
                return new Response(data, {
                    status: 200,
                    headers: { "Content-Type": "application/octet-stream" },
                });
            } catch (error) {
                if (error instanceof InvalidPathError) {
                    return c.json({ error: "Invalid path" }, 400);
                }
                return c.json({ error: "Not found" }, 404);
            }
        })
        .delete('/files', async (c) => {
            const authorization = c.req.header("Authorization");
            if (!authorization) {
                return c.json({ error: "Authorization is required" }, 400);
            }
            const path = resolvePathFromRequest(c);
            if (!path) {
                return c.json({ error: "path is required" }, 400);
            }
            try {
                const clientId = await getClientIdFromAuthorization(authorization);
                const result = await store.delete(path, clientId);
                return c.json({ path, revision: result.revision }, 200);
            } catch (error) {
                if (error instanceof InvalidPathError) {
                    return c.json({ error: "Invalid path" }, 400);
                }
                if (error instanceof Error && error.message === "Invalid authorization") {
                    return c.json({ error: "Unauthorized" }, 401);
                }
                throw error;
            }
        });
}
