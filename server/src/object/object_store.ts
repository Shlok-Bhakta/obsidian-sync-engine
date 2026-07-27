import { Hono } from "hono";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { $, sql } from "bun";
import { createClient, getClientIdFromAuthorization } from "../auth/auth";

/** Thrown when a client-supplied path would resolve outside the object store root. */
export class PathTraversalError extends Error {
    constructor(path: string) {
        super(`Path escapes object store root: ${path}`);
        this.name = "PathTraversalError";
    }
}

export const DEFAULT_OBJECT_STORE_DIR = join(import.meta.dir, "../../" + process.env.OBJECT_STORE_DIR || "object-data");

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

// Simple content-addressed object store for blob uploads.
export class ObjectStore {
    constructor(private readonly rootDirectory = DEFAULT_OBJECT_STORE_DIR) {}

    async upload(content: ObjectStoreUploadContent): Promise<ObjectStoreUploadResult> {
        const decodedPath = decodeURIComponent(content.path);
        const filePath = this.pathForFile(decodedPath);

        const bytesWritten = await Bun.write(filePath, content.content, { createPath: true });
        const [row] = await sql<{ last_updated_revision: number }[]>`
            INSERT INTO files (file_path, author_id) VALUES (${decodedPath}, ${content.id})
            ON CONFLICT (file_path) DO UPDATE SET author_id = ${content.id}, 
            file_is_deleted = FALSE,
            last_updated_revision = EXCLUDED.last_updated_revision, updated_at = NOW() RETURNING last_updated_revision
        `;
        return {
            path: decodedPath,
            bytesWritten,
            revision: Number(row.last_updated_revision),
        };
    }

    /** Soft-deletes a file. Returns null if no file exists at that path. */
    async delete(path: string): Promise<{ revision: number } | null> {
        const decodedPath = decodeURIComponent(path);
        this.pathForFile(decodedPath); // validate path stays within the store root

        const [row] = await sql<{ last_updated_revision: number }[]>`
            UPDATE files SET file_is_deleted = TRUE, updated_at = NOW(), last_updated_revision = NEXTVAL('global_revision')
            WHERE file_path = ${decodedPath} RETURNING last_updated_revision
        `;
        return row ? { revision: Number(row.last_updated_revision) } : null;
    }

    /** Current global tip revision: highest revision stamped on any file, or 0 if none exist. */
    async getTipRevision(): Promise<number> {
        const [row] = await sql<{ tip: string | null }[]>`
            SELECT MAX(last_updated_revision) AS tip FROM files
        `;
        return row?.tip ? Number(row.tip) : 0;
    }

    /** Downloads a file's bytes. Returns null if the file doesn't exist or is soft-deleted. */
    async download(path: string): Promise<ArrayBuffer | null> {
        const decodedPath = decodeURIComponent(path);
        const filePath = this.pathForFile(decodedPath);

        const [row] = await sql<{ file_is_deleted: boolean }[]>`
            SELECT file_is_deleted FROM files WHERE file_path = ${decodedPath}
        `;
        if (!row || row.file_is_deleted) {
            return null;
        }
        return Bun.file(filePath).arrayBuffer();
    }

    async bootstrap_zip_create(path: string): Promise<void> {
        const tmp = await mkdtemp(join(tmpdir(), "obsidian-bootstrap-copy-"));
        const vaultDir = join(tmp, "vault");
        try {
            await mkdir(this.rootDirectory, { recursive: true });
            await cp(this.rootDirectory, vaultDir, { recursive: true });

            const name_choices = [
                "acrobat", "banana", "camera", "diamond", "elephant",
                "forest", "galaxy", "horizon", "indigo", "jungle",
                "koala", "lantern", "mystery", "network", "ocean",
                "pyramid", "quantum", "shadow", "tornado", "volcano",
            ];
            const pick = () => name_choices[Math.floor(Math.random() * name_choices.length)];
            const clientName = `${pick()}-${pick()}`;
            const clientSecret = await createClient(clientName);
            // Read the tip after the copy so the zip's contents never lag behind the
            // stamped revision (worst case for a concurrent single-writer PoC: a client
            // re-fetches a rev it already has, not that it misses one).
            const revision = await this.getTipRevision();

            const pluginDir = join(vaultDir, ".obsidian/plugins/obsidian-sync-engine");
            await mkdir(pluginDir, { recursive: true });
            const dataPath = join(pluginDir, "data.json");
            const settings = await Bun.file(dataPath).json() as Record<string, unknown>;
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

    /** Resolves `file` against the store root, throwing PathTraversalError if it would escape. */
    pathForFile(file: string): string {
        const resolvedRoot = resolve(this.rootDirectory);
        const candidate = resolve(resolvedRoot, file);
        if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + sep)) {
            throw new PathTraversalError(file);
        }
        return candidate;
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

export function registerObjectStoreRoutes(app: Hono, store = objectStore) {
    // Chain so Hono accumulates route types (needed by testClient inference).
    return app
        .post('/files', async (c) => {
            const path = c.req.header("X-Obsidian-Path");
            const authorization = c.req.header("Authorization");
            if (!authorization) {
                return c.json({ error: "Authorization is required" }, 400);
            }
            if (!path) {
                return c.json({ error: "Request body is required" }, 400);
            }

            const clientId = await getClientIdFromAuthorization(authorization);
            console.log("clientId", clientId);
            try {
                const result = await store.upload({
                    path: path,
                    content: await c.req.arrayBuffer(),
                    id: clientId
                });
                return c.json(result, 200);
            } catch (error) {
                if (error instanceof PathTraversalError) {
                    return c.json({ error: "Invalid path" }, 400);
                }
                throw error;
            }
        })
        .get('/bootstrap.zip', async (c) => {
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
            const path = c.req.query("path") ?? c.req.header("X-Obsidian-Path");
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
                if (error instanceof PathTraversalError) {
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
            const path = c.req.query("path") ?? c.req.header("X-Obsidian-Path");
            if (!path) {
                return c.json({ error: "path is required" }, 400);
            }
            try {
                await getClientIdFromAuthorization(authorization);
            } catch {
                return c.json({ error: "Unauthorized" }, 401);
            }

            try {
                const result = await store.delete(path);
                if (!result) {
                    return c.json({ error: "Not found" }, 404);
                }
                return c.json({ path: decodeURIComponent(path), revision: result.revision }, 200);
            } catch (error) {
                if (error instanceof PathTraversalError) {
                    return c.json({ error: "Invalid path" }, 400);
                }
                throw error;
            }
        });
}
