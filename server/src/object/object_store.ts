import { Hono } from "hono";
import { join } from "node:path";

export const DEFAULT_OBJECT_STORE_DIR = join(import.meta.dir, "../../object-data");

export type ObjectStoreUploadContent = {
    path: string;
    content: Bun.BlobOrStringOrBuffer;
};

export type ObjectStoreUploadResult = {
    path: string;
    bytesWritten: number;
};

// Simple content-addressed object store for blob uploads.
export class ObjectStore {
    constructor(private readonly rootDirectory = DEFAULT_OBJECT_STORE_DIR) {}

    async upload(content: ObjectStoreUploadContent): Promise<ObjectStoreUploadResult> {
        const path = this.pathForFile(decodeURIComponent(content.path));
        
        const bytesWritten = await Bun.write(path, content.content, { createPath: true });

        return {
            path,
            bytesWritten,
        };
    }

    pathForFile(file: string): string {
        return join(this.rootDirectory, file);
    }
}

export const objectStore = new ObjectStore();

export function registerObjectStoreRoutes(app: Hono, store = objectStore) {
    app.post('/files', async (c) => {
        const path = c.req.header("X-Obsidian-Path");
        if (!path) {
            return c.json({ error: "Request body is required" }, 400);
        }

        const result = await store.upload({
            path: path,
            content: await c.req.arrayBuffer(),
        });
        return c.json(result, 200);
    });
}
