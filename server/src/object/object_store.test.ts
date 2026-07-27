import { $, sql } from "bun";
import { testClient } from "hono/testing";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createClientFixture, createTestApp, FileRow } from "../test/fixtures";
import { ObjectStore, ObjectStoreUploadContent } from "./object_store";
import { describe, it, expect } from "bun:test";

function decode(data: ArrayBuffer | null): string {
    if (!data) {
        throw new Error("expected file data, got null");
    }
    return new TextDecoder().decode(data);
}

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
        const text = decode(await objectStore.download(file.path));
        expect(text).toBe("Hello, world!");
        // expect revision to be incremented
        const fileRows = await sql<FileRow[]>`
            SELECT * FROM files WHERE file_path = ${file.path}
        `;
        expect(Number(fileRows[0].last_updated_revision)).toBeGreaterThan(0);
        expect(file.revision).toBe(Number(fileRows[0].last_updated_revision));
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
        const text = decode(await objectStore.download(file.path));
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
    it("can give the correct inbox via API as ascending NDJSON", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const app = createTestApp();
        const api = testClient(app);
        const uploads = [
            { path: "test.txt", content: "Hello, world!" },
            { path: "test2.txt", content: "Hello, world 2!" },
            { path: "test3.txt", content: "Hello, world 3!" },
        ];
        // Sequential so revisions are deterministic (1, 2, 3).
        for (const { path, content } of uploads) {
            await app.request("/files", {
                method: "POST",
                headers: {
                    Authorization: client.client_secret,
                    "X-Obsidian-Path": path,
                },
                body: content,
            });
        }
        const res = await api.inbox.$get(
            { query: { rev: "1" } },
            { headers: { Authorization: client.client_secret } },
        );
        expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
        const text = await res.text();
        const lines = text.trim().split("\n").map((line) => JSON.parse(line) as { rev: number; op: string; path: string });
        expect(lines.length).toBe(2);
        expect(lines.map((l) => l.path)).not.toContain("test.txt");
        expect(lines.map((l) => l.path)).toEqual(["test2.txt", "test3.txt"]);
        expect(lines.every((l) => l.op === "put")).toBe(true);
        // strictly ascending by rev
        expect(lines[0].rev).toBeLessThan(lines[1].rev);

        const res2 = await api.inbox.$get(
            { query: { rev: "4" } },
            { headers: { Authorization: client.client_secret } },
        );
        const text2 = await res2.text();
        expect(text2).toBe("");
    });
    it("can delete a file", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        const content: ObjectStoreUploadContent = {
            path: "test.txt",
            content: "Hello, world!",
            id: client.id,
        };
        await objectStore.upload(content);
        await objectStore.delete("test.txt");
        const outbox = await objectStore.inbox(1);
        console.log("outbox", outbox);
        expect(outbox.map(o => o.path)).toContain("test.txt");
        expect(outbox.map(o => o.isDeleted)).toContain(true);
    });
    it("delete returns the new revision and shows up as a delete op in the inbox", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const app = createTestApp();
        const api = testClient(app);
        await app.request("/files", {
            method: "POST",
            headers: { Authorization: client.client_secret, "X-Obsidian-Path": "test.txt" },
            body: "Hello, world!",
        });
        const deleteRes = await api.files.$delete(
            { query: { path: "test.txt" } },
            { headers: { Authorization: client.client_secret } },
        );
        const deleteBody = await deleteRes.json() as { path: string; revision: number };
        expect(deleteBody.path).toBe("test.txt");
        expect(deleteBody.revision).toBe(2);

        const res = await api.inbox.$get(
            { query: { rev: "0" } },
            { headers: { Authorization: client.client_secret } },
        );
        const lines = (await res.text()).trim().split("\n").map((line) => JSON.parse(line) as { rev: number; op: string; path: string });
        const deleteLine = lines.find((l) => l.path === "test.txt");
        expect(deleteLine?.op).toBe("delete");
        expect(deleteLine?.rev).toBe(2);
    });
    it("can download a file via the API", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const app = createTestApp();
        const api = testClient(app);
        await app.request("/files", {
            method: "POST",
            headers: { Authorization: client.client_secret, "X-Obsidian-Path": "test.txt" },
            body: "Hello, world!",
        });
        const res = await api.files.$get(
            { query: { path: "test.txt" } },
            { headers: { Authorization: client.client_secret } },
        );
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toBe("Hello, world!");
    });
    it("upload response includes the assigned revision", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const app = createTestApp();
        const res = await app.request("/files", {
            method: "POST",
            headers: { Authorization: client.client_secret, "X-Obsidian-Path": "test.txt" },
            body: "Hello, world!",
        });
        const body = await res.json() as { path: string; bytesWritten: number; revision: number };
        expect(body.path).toBe("test.txt");
        expect(body.revision).toBe(1);
    });
    it("computes the current tip revision for bootstrap stamping", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        expect(await objectStore.getTipRevision()).toBe(0);
        await objectStore.upload({ path: "test.txt", content: "Hello, world!", id: client.id });
        await objectStore.upload({ path: "test2.txt", content: "Hello, world 2!", id: client.id });
        expect(await objectStore.getTipRevision()).toBe(2);
    });
    it("stamps the current tip revision (not 0) into the bootstrap zip's data.json", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        const pluginDataPath = ".obsidian/plugins/obsidian-sync-engine/data.json";
        await objectStore.upload({ path: pluginDataPath, content: "{}", id: client.id });
        await objectStore.upload({ path: "note.md", content: "hello", id: client.id });
        expect(await objectStore.getTipRevision()).toBe(2);

        const tmp = await mkdtemp(join(tmpdir(), "obsidian-bootstrap-test-"));
        const zipPath = join(tmp, "vault.zip");
        try {
            await objectStore.bootstrap_zip_create(zipPath);
            const extractDir = join(tmp, "extracted");
            await $`unzip -qq ${zipPath} -d ${extractDir}`;
            const settings = await Bun.file(join(extractDir, pluginDataPath)).json() as Record<string, unknown>;
            expect(settings.revision).toBe(2);
            expect(settings.lastPulledRev).toBeUndefined();
            expect(typeof settings.clientName).toBe("string");
            expect(typeof settings.clientSecret).toBe("string");
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
    });
    it("rejects a path traversal attempt on upload with 400", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const app = createTestApp();
        const res = await app.request("/files", {
            method: "POST",
            headers: { Authorization: client.client_secret, "X-Obsidian-Path": "../../etc/passwd" },
            body: "pwned",
        });
        expect(res.status).toBe(400);

        const fileRows = await sql<FileRow[]>`SELECT * FROM files`;
        expect(fileRows.length).toBe(0);
    });
    it("rejects a path traversal attempt on download and delete with 400", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const app = createTestApp();
        const traversal = encodeURIComponent("../../etc/passwd");

        const getRes = await app.request(`/files?path=${traversal}`, {
            headers: { Authorization: client.client_secret },
        });
        expect(getRes.status).toBe(400);

        const deleteRes = await app.request(`/files?path=${traversal}`, {
            method: "DELETE",
            headers: { Authorization: client.client_secret },
        });
        expect(deleteRes.status).toBe(400);
    });
    it("deletes a file whose path was sent encodeURIComponent-encoded, matching the plugin", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const app = createTestApp();
        const rawPath = "folder/na me.txt";
        const encodedPath = encodeURIComponent(rawPath);

        await app.request("/files", {
            method: "POST",
            headers: { Authorization: client.client_secret, "X-Obsidian-Path": encodedPath },
            body: "Hello, world!",
        });

        const deleteRes = await app.request(`/files?path=${encodedPath}`, {
            method: "DELETE",
            headers: { Authorization: client.client_secret },
        });
        expect(deleteRes.status).toBe(200);
        const body = await deleteRes.json() as { path: string; revision: number };
        expect(body.path).toBe(rawPath);

        const fileRows = await sql<FileRow[]>`SELECT * FROM files WHERE file_path = ${rawPath}`;
        expect(fileRows.length).toBe(1);
        expect(fileRows[0].file_is_deleted).toBe(true);
    });
    it("returns 404 when deleting a file that doesn't exist", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const app = createTestApp();
        const res = await app.request(`/files?path=${encodeURIComponent("does-not-exist.txt")}`, {
            method: "DELETE",
            headers: { Authorization: client.client_secret },
        });
        expect(res.status).toBe(404);
    });
    it("re-uploading a soft-deleted file clears the tombstone and appears as a put in the inbox", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        await objectStore.upload({ path: "test.txt", content: "v1", id: client.id });
        await objectStore.delete("test.txt");
        await objectStore.upload({ path: "test.txt", content: "v2", id: client.id });

        const fileRows = await sql<FileRow[]>`SELECT * FROM files WHERE file_path = ${"test.txt"}`;
        expect(fileRows[0].file_is_deleted).toBe(false);

        const inbox = await objectStore.inbox(0);
        const entry = inbox.find((i) => i.path === "test.txt");
        expect(entry?.isDeleted).toBe(false);

        const text = decode(await objectStore.download("test.txt"));
        expect(text).toBe("v2");
    });
    it("returns 404 when downloading a soft-deleted file", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const app = createTestApp();
        await app.request("/files", {
            method: "POST",
            headers: { Authorization: client.client_secret, "X-Obsidian-Path": "test.txt" },
            body: "Hello, world!",
        });
        await app.request("/files?path=test.txt", {
            method: "DELETE",
            headers: { Authorization: client.client_secret },
        });

        const res = await app.request("/files?path=test.txt", {
            headers: { Authorization: client.client_secret },
        });
        expect(res.status).toBe(404);
    });
    it("returns 401 for GET/DELETE /files with an invalid client secret", async () => {
        const app = createTestApp();
        const getRes = await app.request("/files?path=test.txt", {
            headers: { Authorization: "bogus-secret" },
        });
        expect(getRes.status).toBe(401);

        const deleteRes = await app.request("/files?path=test.txt", {
            method: "DELETE",
            headers: { Authorization: "bogus-secret" },
        });
        expect(deleteRes.status).toBe(401);
    });
    it("round-trips a path containing a literal % through query-string download and delete without double-decoding", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const app = createTestApp();
        // Literal '%' followed by valid hex digits: if the query value were
        // decodeURIComponent'd twice, "%41" would silently become "A" instead
        // of staying literal, corrupting the path without throwing.
        const rawPath = "50%41.txt";
        const encodedPath = encodeURIComponent(rawPath);

        await app.request("/files", {
            method: "POST",
            headers: { Authorization: client.client_secret, "X-Obsidian-Path": encodedPath },
            body: "Hello, world!",
        });
        const fileRows = await sql<FileRow[]>`SELECT * FROM files WHERE file_path = ${rawPath}`;
        expect(fileRows.length).toBe(1);

        const downloadRes = await app.request(`/files?path=${encodedPath}`, {
            headers: { Authorization: client.client_secret },
        });
        expect(downloadRes.status).toBe(200);
        expect(await downloadRes.text()).toBe("Hello, world!");

        const deleteRes = await app.request(`/files?path=${encodedPath}`, {
            method: "DELETE",
            headers: { Authorization: client.client_secret },
        });
        expect(deleteRes.status).toBe(200);
        const body = await deleteRes.json() as { path: string; revision: number };
        expect(body.path).toBe(rawPath);
    });
    it("excludes soft-deleted files from the bootstrap zip", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        const pluginDataPath = ".obsidian/plugins/obsidian-sync-engine/data.json";
        await objectStore.upload({ path: pluginDataPath, content: "{}", id: client.id });
        await objectStore.upload({ path: "keep.md", content: "keep me", id: client.id });
        await objectStore.upload({ path: "gone.md", content: "delete me", id: client.id });
        await objectStore.delete("gone.md");

        const tmp = await mkdtemp(join(tmpdir(), "obsidian-bootstrap-test-"));
        const zipPath = join(tmp, "vault.zip");
        try {
            await objectStore.bootstrap_zip_create(zipPath);
            const extractDir = join(tmp, "extracted");
            await $`unzip -qq ${zipPath} -d ${extractDir}`;

            expect(await Bun.file(join(extractDir, "keep.md")).exists()).toBe(true);
            expect(await Bun.file(join(extractDir, "gone.md")).exists()).toBe(false);
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
    });
    it("stamps a tip revision that includes soft-delete revisions", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        const pluginDataPath = ".obsidian/plugins/obsidian-sync-engine/data.json";
        await objectStore.upload({ path: pluginDataPath, content: "{}", id: client.id });
        await objectStore.upload({ path: "keep.md", content: "keep me", id: client.id });
        await objectStore.upload({ path: "gone.md", content: "delete me", id: client.id });
        const { revision: deleteRevision } = (await objectStore.delete("gone.md"))!;

        const tmp = await mkdtemp(join(tmpdir(), "obsidian-bootstrap-test-"));
        const zipPath = join(tmp, "vault.zip");
        try {
            await objectStore.bootstrap_zip_create(zipPath);
            const extractDir = join(tmp, "extracted");
            await $`unzip -qq ${zipPath} -d ${extractDir}`;
            const settings = await Bun.file(
                join(extractDir, ".obsidian/plugins/obsidian-sync-engine/data.json"),
            ).json() as Record<string, unknown>;
            // The tip must be >= the delete's revision so a fresh client never
            // re-fetches a tombstone it already excludes from the bootstrap.
            expect(settings.revision).toBe(deleteRevision);
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
    });
});