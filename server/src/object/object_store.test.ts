import { sql } from "bun";
import { createClientFixture, FileRow } from "../test/fixtures";
import { ObjectStore, ObjectStoreUploadContent } from "./object_store";
import { describe, it, expect } from "bun:test";

describe("object store", () => {
    it("can upload a file", async () => {
		const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        const content: ObjectStoreUploadContent = {
            path: "test.txt",
            content: "Hello, world!",
            id: client.id,
        };
        const file = await objectStore.upload(content);
        expect(file.path).toBe("test.txt");
        // verify the file landed
        const data: ArrayBuffer = await objectStore.download(file.path);
        const text = new TextDecoder().decode(data);
        expect(text).toBe("Hello, world!");
        // expect revision to be incremented
        const fileRows = await sql<FileRow[]>`
            SELECT * FROM files WHERE file_path = ${file.path}
        `;
        expect(Number(fileRows[0].last_updated_revision)).toBeGreaterThan(0);
    });
});