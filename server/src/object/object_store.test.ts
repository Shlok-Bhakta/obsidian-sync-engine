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
    it("can upload 2 files with the same path", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        const content: ObjectStoreUploadContent = {
            path: "test.txt",
            content: "Hello, world!",
            id: client.id,
        };
        const file = await objectStore.upload(content);
        expect(file.path).toBe("test.txt");

        const fileRowsFirst = await sql<FileRow[]>`
            SELECT * FROM files WHERE file_path = ${file.path}
        `;
        expect(Number(fileRowsFirst[0].last_updated_revision)).toEqual(1);
        const content2: ObjectStoreUploadContent = {
            path: "test.txt",
            content: "Hello, world 2!",
            id: client.id,
        };
        const file2 = await objectStore.upload(content2);
        expect(file2.path).toBe("test.txt");

        // verify the file landed
        const data: ArrayBuffer = await objectStore.download(file.path);
        const text = new TextDecoder().decode(data);
        expect(text).toBe("Hello, world 2!");
        // expect revision to be incremented
        const fileRowsSecond = await sql<FileRow[]>`
            SELECT * FROM files WHERE file_path = ${file.path}
        `;
        expect(Number(fileRowsSecond[0].last_updated_revision)).toEqual(2);
        expect(Number(fileRowsSecond[0].updated_at)).not.toEqual(fileRowsFirst[0].updated_at);
    });
    it("can give the correct outbox for a client", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        const content: ObjectStoreUploadContent[] = [{
            path: "test.txt",
            content: "Hello, world!",
            id: client.id,
        },
        {
            path: "test2.txt",
            content: "Hello, world 2!",
            id: client.id,
        },
        {
            path: "test3.txt",
            content: "Hello, world 3!",
            id: client.id,
        }];
        await Promise.all(content.map(c => objectStore.upload(c)));
        const outbox = await objectStore.inbox(1);
        expect(outbox.map(o => o.path)).not.toContain("test.txt");
        expect(outbox.map(o => o.path)).toContain("test2.txt");
        expect(outbox.map(o => o.path)).toContain("test3.txt");
    });
    it("can return empty when there is nothing new in the outbox", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        const content: ObjectStoreUploadContent[] = [{
            path: "test.txt",
            content: "Hello, world!",
            id: client.id,
        },
        {
            path: "test2.txt",
            content: "Hello, world 2!",
            id: client.id,
        },
        {
            path: "test3.txt",
            content: "Hello, world 3!",
            id: client.id,
        }];
        await Promise.all(content.map(c => objectStore.upload(c)));
        const outbox = await objectStore.inbox(4);
        expect(outbox.map(o => o.path)).not.toContain("test.txt");
        expect(outbox.map(o => o.path)).not.toContain("test2.txt");
        expect(outbox.map(o => o.path)).not.toContain("test3.txt");
        expect(outbox.length).toBe(0);
    });
});