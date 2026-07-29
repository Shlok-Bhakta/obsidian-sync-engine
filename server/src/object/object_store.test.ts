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
        // Sequential so revisions are deterministic (1, 2, 3).
        for (const c of content) {
            await objectStore.upload(c);
        }
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
        for (const c of content) {
            await objectStore.upload(c);
        }
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
        await objectStore.delete("test.txt", client.id);
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
        expect(deleteBody.revision).toBeGreaterThan(0);

        const res = await api.inbox.$get(
            { query: { rev: "0" } },
            { headers: { Authorization: client.client_secret } },
        );
        const lines = (await res.text()).trim().split("\n").map((line) => JSON.parse(line) as { rev: number; op: string; path: string });
        const deleteLine = lines.find((l) => l.path === "test.txt");
        expect(deleteLine?.op).toBe("delete");
        expect(deleteLine?.rev).toBe(deleteBody.revision);
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
        await objectStore.upload({ path: "note.md", content: "hello", id: client.id });
        expect(await objectStore.getTipRevision()).toBe(1);

        const tmp = await mkdtemp(join(tmpdir(), "obsidian-bootstrap-test-"));
        const zipPath = join(tmp, "vault.zip");
        try {
            await objectStore.bootstrap_zip_create(zipPath);
            const extractDir = join(tmp, "extracted");
            await $`unzip -qq ${zipPath} -d ${extractDir}`;
            const settings = await Bun.file(join(extractDir, pluginDataPath)).json() as Record<string, unknown>;
            expect(settings.revision).toBe(1);
            expect(settings.serverUrl).toBe("http://localhost:3000");
            expect(settings.lastPulledRev).toBeUndefined();
            expect(typeof settings.clientName).toBe("string");
            expect(typeof settings.clientSecret).toBe("string");
            expect(await Bun.file(join(
                extractDir,
                ".obsidian/plugins/obsidian-sync-engine/main.js",
            )).exists()).toBe(true);
            expect(await Bun.file(join(
                extractDir,
                ".obsidian/plugins/obsidian-sync-engine/manifest.json",
            )).exists()).toBe(true);
            expect(await Bun.file(
                join(extractDir, ".obsidian/community-plugins.json"),
            ).json()).toContain("obsidian-sync-engine");
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
    });
    it("bootstraps successfully when plugin data.json was never seeded", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        await objectStore.upload({ path: "note.md", content: "hello", id: client.id });

        const tmp = await mkdtemp(join(tmpdir(), "obsidian-bootstrap-test-"));
        const zipPath = join(tmp, "vault.zip");
        try {
            await objectStore.bootstrap_zip_create(zipPath);
            const extractDir = join(tmp, "extracted");
            await $`unzip -qq ${zipPath} -d ${extractDir}`;
            const settings = await Bun.file(
                join(extractDir, ".obsidian/plugins/obsidian-sync-engine/data.json"),
            ).json() as Record<string, unknown>;
            expect(settings.revision).toBe(1);
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
    it("deleting a never-uploaded path returns 200 with a revision (idempotent tombstone)", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const app = createTestApp();
        const res = await app.request(`/files?path=${encodeURIComponent("never-seen.txt")}`, {
            method: "DELETE",
            headers: { Authorization: client.client_secret },
        });
        expect(res.status).toBe(200);
        const body = await res.json() as { path: string; revision: number };
        expect(body.path).toBe("never-seen.txt");
        expect(body.revision).toBeGreaterThan(0);

        const fileRows = await sql<FileRow[]>`SELECT * FROM files WHERE file_path = ${"never-seen.txt"}`;
        expect(fileRows.length).toBe(1);
        expect(fileRows[0].file_is_deleted).toBe(true);
    });
    it("re-uploading a soft-deleted file clears the tombstone and appears as a put in the inbox", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        await objectStore.upload({ path: "test.txt", content: "v1", id: client.id });
        await objectStore.delete("test.txt", client.id);
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
    it("deleting a parent path tombstones every active descendant", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        const child = await objectStore.upload({
            path: "dir/child.md",
            content: "child",
            id: client.id,
        });

        const result = await objectStore.delete("dir", client.id);
        expect(result.revision).toBeGreaterThan(child.revision);
        expect(await objectStore.download("dir/child.md")).toBeNull();

        const inbox = await objectStore.inbox(child.revision);
        expect(inbox.map(({ path, isDeleted }) => ({ path, isDeleted }))).toEqual([
            { path: "dir/child.md", isDeleted: true },
            { path: "dir", isDeleted: true },
        ]);
    });
    it("excludes soft-deleted files from the bootstrap zip", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        await objectStore.upload({ path: "keep.md", content: "keep me", id: client.id });
        await objectStore.upload({ path: "gone.md", content: "delete me", id: client.id });
        await objectStore.delete("gone.md", client.id);

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
    it("bootstrap zip contains bytes uploaded via the HTTP API (BYTEA-only storage)", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const app = createTestApp();
        await app.request("/files", {
            method: "POST",
            headers: { Authorization: client.client_secret, "X-Obsidian-Path": "note.md" },
            body: "hello from api",
        });

        // Confirm bytes live only in Postgres, never touched the filesystem object store dir.
        const fileRows = await sql<FileRow[]>`SELECT * FROM files WHERE file_path = ${"note.md"}`;
        expect(fileRows.length).toBe(1);
        expect(fileRows[0].content).not.toBeNull();
        expect(fileRows[0].content?.toString()).toBe("hello from api");

        const objectStore = new ObjectStore();
        const tmp = await mkdtemp(join(tmpdir(), "obsidian-bootstrap-test-"));
        const zipPath = join(tmp, "vault.zip");
        try {
            await objectStore.bootstrap_zip_create(zipPath);
            const extractDir = join(tmp, "extracted");
            await $`unzip -qq ${zipPath} -d ${extractDir}`;
            const content = await Bun.file(join(extractDir, "note.md")).text();
            expect(content).toBe("hello from api");
        } finally {
            await rm(tmp, { recursive: true, force: true });
        }
    });

    describe("path validation", () => {
        it.each([
            ["parent-directory traversal", "../x"],
            ["absolute unix path", "/etc/passwd"],
            ["backslash", "a\\b"],
            ["current-directory segment", "a/./b"],
        ])("rejects %s (%p) on upload with 400", async (_label, rawPath) => {
            const client = await createClientFixture({ client_name: "alice" });
            const app = createTestApp();
            const res = await app.request("/files", {
                method: "POST",
                headers: {
                    Authorization: client.client_secret,
                    "X-Obsidian-Path": encodeURIComponent(rawPath),
                },
                body: "pwned",
            });
            expect(res.status).toBe(400);

            const fileRows = await sql<FileRow[]>`SELECT * FROM files`;
            expect(fileRows.length).toBe(0);
        });

        it("rejects an empty path on upload with 400", async () => {
            const client = await createClientFixture({ client_name: "alice" });
            const app = createTestApp();
            const res = await app.request("/files", {
                method: "POST",
                headers: {
                    Authorization: client.client_secret,
                    "X-Obsidian-Path": encodeURIComponent(""),
                },
                body: "pwned",
            });
            expect(res.status).toBe(400);
        });
    });

    describe("revision serialization under concurrency", () => {
        it("advisory lock forces commit order to match revision order even when the earlier writer is slower", async () => {
            const client = await createClientFixture({ client_name: "alice" });
            const objectStore = new ObjectStore();
            const commitOrder: string[] = [];

            const slow = sql.begin(async (tx) => {
                await tx`SELECT pg_advisory_xact_lock(hashtext('obsidian-sync-revision'))`;
                await tx`SELECT pg_sleep(0.05)`;
                const [row] = await tx<{ last_updated_revision: number }[]>`
                    INSERT INTO files (file_path, author_id, content, file_is_deleted)
                    VALUES ('slow.txt', ${client.id}, ${Buffer.from("slow")}, FALSE)
                    RETURNING last_updated_revision
                `;
                commitOrder.push("slow");
                return Number(row.last_updated_revision);
            });

            // Give "slow" a head start so it acquires the advisory lock first.
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 15));

            const fast = sql.begin(async (tx) => {
                // Blocks here until "slow" commits and releases the advisory lock,
                // even though this transaction itself does no work before that.
                await tx`SELECT pg_advisory_xact_lock(hashtext('obsidian-sync-revision'))`;
                const [row] = await tx<{ last_updated_revision: number }[]>`
                    INSERT INTO files (file_path, author_id, content, file_is_deleted)
                    VALUES ('fast.txt', ${client.id}, ${Buffer.from("fast")}, FALSE)
                    RETURNING last_updated_revision
                `;
                commitOrder.push("fast");
                return Number(row.last_updated_revision);
            });

            const [slowRevision, fastRevision] = await Promise.all([slow, fast]);

            // "fast" cannot commit before "slow" releases the lock, so it can never
            // be observed by a client (via inbox) ahead of "slow".
            expect(commitOrder).toEqual(["slow", "fast"]);
            expect(slowRevision).toBeLessThan(fastRevision);

            const inbox = await objectStore.inbox(0);
            expect(inbox.map((i) => i.path)).toEqual(["slow.txt", "fast.txt"]);
            expect(inbox.map((i) => i.lastUpdatedRevision)).toEqual([slowRevision, fastRevision]);
        });

        it("many parallel uploads produce strictly increasing revisions with no gaps, matching inbox order", async () => {
            const client = await createClientFixture({ client_name: "alice" });
            const objectStore = new ObjectStore();
            const fileCount = 20;

            const uploads = await Promise.all(
                Array.from({ length: fileCount }, (_, i) =>
                    objectStore.upload({
                        path: `parallel-${i}.txt`,
                        content: `content-${i}`,
                        id: client.id,
                    }),
                ),
            );

            const revisions = uploads.map((u) => u.revision).sort((a, b) => a - b);
            expect(revisions).toEqual(Array.from({ length: fileCount }, (_, i) => i + 1));

            const inbox = await objectStore.inbox(0);
            expect(inbox.length).toBe(fileCount);
            const inboxRevisions = inbox.map((i) => i.lastUpdatedRevision);
            expect(inboxRevisions).toEqual([...inboxRevisions].sort((a, b) => a - b));
            expect(new Set(inboxRevisions).size).toBe(fileCount);

            // Every committed revision's path downloads the bytes that were
            // actually uploaded for it (metadata and bytes describe one version).
            for (const upload of uploads) {
                const text = decode(await objectStore.download(upload.path));
                const expectedIndex = upload.path.replace("parallel-", "").replace(".txt", "");
                expect(text).toBe(`content-${expectedIndex}`);
            }
        });

        it("concurrent uploads to the same path serialize atomically: revision and bytes describe one committed version", async () => {
            const client = await createClientFixture({ client_name: "alice" });
            const objectStore = new ObjectStore();
            const variants = ["v-A", "v-B", "v-C"];

            const uploads = await Promise.all(
                variants.map((content) =>
                    objectStore.upload({ path: "same-path.txt", content, id: client.id }),
                ),
            );

            const revisions = uploads.map((u) => u.revision).sort((a, b) => a - b);
            expect(revisions).toEqual([1, 2, 3]);

            const winningRevision = Math.max(...uploads.map((u) => u.revision));
            const winnerIndex = uploads.findIndex((u) => u.revision === winningRevision);
            const expectedWinningContent = variants[winnerIndex];

            const fileRows = await sql<FileRow[]>`SELECT * FROM files WHERE file_path = ${"same-path.txt"}`;
            expect(fileRows.length).toBe(1);
            expect(Number(fileRows[0].last_updated_revision)).toBe(winningRevision);
            expect(fileRows[0].content?.toString()).toBe(expectedWinningContent);

            const downloaded = decode(await objectStore.download("same-path.txt"));
            expect(downloaded).toBe(expectedWinningContent);
        });
    });

    it("stamps a tip revision that includes soft-delete revisions", async () => {
        const client = await createClientFixture({ client_name: "alice" });
        const objectStore = new ObjectStore();
        const pluginDataPath = ".obsidian/plugins/obsidian-sync-engine/data.json";
        await objectStore.upload({ path: "keep.md", content: "keep me", id: client.id });
        await objectStore.upload({ path: "gone.md", content: "delete me", id: client.id });
        const { revision: deleteRevision } = await objectStore.delete("gone.md", client.id);

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

	it("rejects Obsidian configuration uploads at the server boundary", async () => {
		const client = await createClientFixture({ client_name: "alice" });
		const app = createTestApp();
		const response = await app.request("/files", {
			method: "POST",
			headers: {
				Authorization: client.client_secret,
				"X-Obsidian-Path": ".obsidian/workspace.json",
			},
			body: "private",
		});
		expect(response.status).toBe(400);
	});

	it("rejects invalid inbox cursors", async () => {
		const client = await createClientFixture({ client_name: "alice" });
		const app = createTestApp();
		for (const rev of ["", "-1", "1.5", "NaN", "Infinity"]) {
			const response = await app.request(`/inbox?rev=${encodeURIComponent(rev)}`, {
				headers: { Authorization: client.client_secret },
			});
			expect(response.status).toBe(400);
		}
	});

	it("resolves file/directory prefix conflicts with the newest upload", async () => {
		const client = await createClientFixture({ client_name: "alice" });
		const store = new ObjectStore();
		await store.upload({ path: "a", content: "file", id: client.id });
		await store.upload({ path: "a/b.md", content: "nested", id: client.id });
		expect(await store.download("a")).toBeNull();
		expect(decode(await store.download("a/b.md"))).toBe("nested");
		const rows = await store.inbox(0);
		expect(rows.find(({ path }) => path === "a")?.isDeleted).toBe(true);
	});
});
