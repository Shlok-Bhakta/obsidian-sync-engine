import { Hono } from "hono";
import { join } from "node:path";

export const DEFAULT_OBJECT_STORE_DIR = join(import.meta.dir, "../../object-data");

export type ObjectStoreUploadContent = Bun.BlobOrStringOrBuffer;

export type ObjectStoreUploadResult = {
    id: string;
    path: string;
    bytesWritten: number;
    alreadyExisted: boolean;
};

// Simple content-addressed object store for blob uploads.
export class ObjectStore {
    constructor(private readonly rootDirectory = DEFAULT_OBJECT_STORE_DIR) {}

    async upload(content: ObjectStoreUploadContent): Promise<ObjectStoreUploadResult> {
        const id = hashContent(content);
        const path = this.pathForId(id);
        const existingFile = Bun.file(path);
        const alreadyExisted = await existingFile.exists();

        if (alreadyExisted) {
            return {
                id,
                path,
                bytesWritten: 0,
                alreadyExisted: true,
            };
        }

        const bytesWritten = await Bun.write(path, content, { createPath: true });

        return {
            id,
            path,
            bytesWritten,
            alreadyExisted: false,
        };
    }

    pathForId(id: string): string {
        return join(this.rootDirectory, id.slice(0, 2), id);
    }
}

export const objectStore = new ObjectStore();

function hashContent(content: ObjectStoreUploadContent): string {
    return new Bun.CryptoHasher("sha3-512").update(content).digest("hex");
}

export function registerObjectStoreRoutes(app: Hono, store = objectStore) {
    app.post('/files', async (c) => {
        const body = c.req.raw.body;
        if (!body) {
            return c.json({ error: "Request body is required" }, 400);
        }

        const result = await store.upload(await c.req.arrayBuffer());
        return c.json(result, result.alreadyExisted ? 200 : 201);
    });
}
