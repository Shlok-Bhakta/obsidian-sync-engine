import { Hono } from "hono";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { $, sql } from "bun";
import { createClient, getClientIdFromAuthorization } from "../auth/auth";

export const DEFAULT_OBJECT_STORE_DIR = join(import.meta.dir, "../../" + process.env.OBJECT_STORE_DIR || "object-data");

export type ObjectStoreUploadContent = {
    path: string;
    content: Bun.BlobOrStringOrBuffer;
    id: string;
};

export type ObjectStoreUploadResult = {
    path: string;
    bytesWritten: number;
};

export type ObjectStoreOutboxItem = {
    path: string;
    lastUpdatedRevision: number;
};

// Simple content-addressed object store for blob uploads.
export class ObjectStore {
    constructor(private readonly rootDirectory = DEFAULT_OBJECT_STORE_DIR) {}

    async upload(content: ObjectStoreUploadContent): Promise<ObjectStoreUploadResult> {
        const path = this.pathForFile(decodeURIComponent(content.path));
        
        const bytesWritten = await Bun.write(path, content.content, { createPath: true });
        const [lastUpdatedRevision] = await sql<{ last_updated_revision: number }[]>`
            INSERT INTO files (file_path, author_id) VALUES (${decodeURIComponent(content.path)}, ${content.id})
            ON CONFLICT (file_path) DO UPDATE SET author_id = ${content.id}, 
            last_updated_revision = EXCLUDED.last_updated_revision, updated_at = NOW() RETURNING last_updated_revision
        `;
        return {
            path: decodeURIComponent(content.path),
            bytesWritten,
       
        };
    }

    async download(path: string): Promise<ArrayBuffer> {
        return Bun.file(this.pathForFile(decodeURIComponent(path))).arrayBuffer();
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

            const pluginDir = join(vaultDir, ".obsidian/plugins/obsidian-sync-engine");
            await mkdir(pluginDir, { recursive: true });
            const dataPath = join(pluginDir, "data.json");
            const settings = await Bun.file(dataPath).json() as Record<string, unknown>;
            await Bun.write(dataPath, JSON.stringify({
                ...settings,
                clientName,
                clientSecret,
                lastPulledRev: 0,
            }, null, 2));

            await $`zip -qr ${path} .`.cwd(vaultDir);
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
    }

    pathForFile(file: string): string {
        return join(this.rootDirectory, file);
    }
    // to create the client inbox
    async inbox(rev: number): Promise<ObjectStoreOutboxItem[]> {
        const result = await sql<{ file_path: string; last_updated_revision: string }[]>`
            SELECT file_path, last_updated_revision FROM files
            WHERE last_updated_revision > ${rev}
            ORDER BY last_updated_revision DESC
        `;
        return result.map((r: { file_path: string; last_updated_revision: string }) => ({
            path: r.file_path,
            lastUpdatedRevision: Number(r.last_updated_revision),
        }));
    }
}

export const objectStore = new ObjectStore();

export function registerObjectStoreRoutes(app: Hono, store = objectStore) {
    app.post('/files', async (c) => {
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
        const result = await store.upload({
            path: path,
            content: await c.req.arrayBuffer(),
            id: clientId
        });
        return c.json(result, 200);
    });

    app.get('/bootstrap.zip', async (c) => {
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
    });

    app.get('/inbox', async (c) => {
        const authorization = c.req.header("Authorization");
        if (!authorization) {
            return c.json({ error: "Authorization is required" }, 400);
        }
        const clientId = await getClientIdFromAuthorization(authorization);
        
        const rev = Number(c.req.query("rev"));
        const inbox = await store.inbox(rev);
        return c.json(inbox, 200);
    });

}
