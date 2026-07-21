import { expect, test } from "bun:test";
import { sql } from "bun";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Y from "yjs";
import { strFromU8, unzipSync } from "fflate";
import { Hono } from "hono";
import { authenticateClient, createClient, hashSecret } from "../auth/auth";
import { bootstrapDB } from "../db/MigrationRunner";
import { ObjectStore } from "../storage/object_store";
import { SyncEngine } from "./engine";
import { commitInitialBootstrap, createDownloadBootstrap, expireBootstrapLinks, registerBootstrapRoutes } from "./bootstrap";

const postgresTest = process.env.RUN_POSTGRES_TESTS === "1" ? test : test.skip;

postgresTest("PostgreSQL engine deduplicates retries, enforces blob CAS, and converges Yjs updates", async () => {
  await bootstrapDB();
  await sql`TRUNCATE bootstrap_links, bootstrap_commits, sync_events, files, objects, clients RESTART IDENTITY CASCADE`;
  await sql`ALTER SEQUENCE global_revision RESTART WITH 1`;
  await sql`UPDATE server_meta SET bootstrap_state = 'committed', current_snapshot_revision = 0 WHERE singleton = TRUE`;
  const root = await mkdtemp(join(tmpdir(), "sync-engine-integration-"));
  try {
    const store = new ObjectStore(root);
    const engine = new SyncEngine(store);
    const alpha = await createClient("integration-alpha");
    const beta = await createClient("integration-beta");

    const initialDoc = new Y.Doc();
    initialDoc.getText("content").insert(0, "seed");
    const initialHash = await store.putBytes(Y.encodeStateAsUpdate(initialDoc));
    const markdownId = crypto.randomUUID();
    const created = await engine.applyMutations(alpha.id, [{
      mutationId: "markdown-create", operation: "create", fileId: markdownId, path: "note.md", baseRevision: "0", objectHash: initialHash,
    }]);
    expect(created.accepted).toHaveLength(1);

    const left = new Y.Doc();
    const right = new Y.Doc();
    const initial = Y.encodeStateAsUpdate(initialDoc);
    Y.applyUpdate(left, initial);
    Y.applyUpdate(right, initial);
    let leftUpdate: Uint8Array<ArrayBufferLike> = new Uint8Array();
    let rightUpdate: Uint8Array<ArrayBufferLike> = new Uint8Array();
    left.on("update", (update: Uint8Array) => { leftUpdate = update; });
    right.on("update", (update: Uint8Array) => { rightUpdate = update; });
    left.getText("content").insert(4, "-left");
    right.getText("content").insert(0, "right-");
    const leftHash = await store.putBytes(leftUpdate);
    const rightHash = await store.putBytes(rightUpdate);
    const leftResult = await engine.applyMutations(alpha.id, [{
      mutationId: "left-update", operation: "yjs_update", fileId: markdownId, path: "note.md", baseRevision: "0", objectHash: leftHash,
    }]);
    await engine.applyMutations(beta.id, [{
      mutationId: "right-update", operation: "yjs_update", fileId: markdownId, path: "note.md", baseRevision: "0", objectHash: rightHash,
    }]);
    const duplicate = await engine.applyMutations(alpha.id, [{
      mutationId: "left-update", operation: "yjs_update", fileId: markdownId, path: "note.md", baseRevision: "0", objectHash: leftHash,
    }]);
    expect(duplicate.accepted[0]?.revision).toBe(leftResult.accepted[0]?.revision);
    const [markdown] = await sql<{ yjs_state_hash: string }[]>`SELECT yjs_state_hash FROM files WHERE id = ${markdownId}`;
    const finalDoc = new Y.Doc();
    Y.applyUpdate(finalDoc, await store.read(markdown!.yjs_state_hash));
    expect(finalDoc.getText("content").toJSON()).toContain("left");
    expect(finalDoc.getText("content").toJSON()).toContain("right");

    const blobId = crypto.randomUUID();
    const firstHash = await store.putBytes(new TextEncoder().encode("first"));
    const blobCreate = await engine.applyMutations(alpha.id, [{
      mutationId: "blob-create", operation: "create", fileId: blobId, path: "image.bin", baseRevision: "0", objectHash: firstHash,
    }]);
    const baseRevision = blobCreate.accepted[0]!.revision;
    const alphaHash = await store.putBytes(new TextEncoder().encode("alpha"));
    const betaHash = await store.putBytes(new TextEncoder().encode("beta"));
    await engine.applyMutations(alpha.id, [{
      mutationId: "blob-alpha", operation: "update", fileId: blobId, path: "image.bin", baseRevision, objectHash: alphaHash,
    }]);
    const stale = await engine.applyMutations(beta.id, [{
      mutationId: "blob-beta", operation: "update", fileId: blobId, path: "image.bin", baseRevision, objectHash: betaHash,
    }]);
    expect(stale.conflicts[0]?.code).toBe("STALE_REVISION");

    const revisions = await sql<{ revision: string }[]>`SELECT revision::text FROM sync_events ORDER BY revision`;
    expect(revisions.map((row) => BigInt(row.revision))).toEqual([...revisions].map((row) => BigInt(row.revision)).sort((a, b) => a < b ? -1 : 1));

    await sql`TRUNCATE bootstrap_links, bootstrap_commits, sync_events, files, objects, clients RESTART IDENTITY CASCADE`;
    await sql`ALTER SEQUENCE global_revision RESTART WITH 1`;
    await sql`UPDATE server_meta SET bootstrap_state = 'empty', current_snapshot_revision = 0 WHERE singleton = TRUE`;
    const bootstrapClient = await createClient("bootstrap-client");
    const bootstrapDoc = new Y.Doc();
    bootstrapDoc.getText("content").insert(0, "bootstrap text");
    const bootstrapHash = await store.putBytes(Y.encodeStateAsUpdate(bootstrapDoc));
    const bootstrapId = crypto.randomUUID();
    const manifest = { bootstrapId, entries: [{ fileId: crypto.randomUUID(), path: "bootstrap.md", kind: "markdown" as const, objectHash: bootstrapHash }] };
    const committed = await commitInitialBootstrap(bootstrapClient.id, manifest, store);
    const resumed = await commitInitialBootstrap(bootstrapClient.id, manifest, store);
    expect(resumed).toEqual(committed);
    const losing = await commitInitialBootstrap(bootstrapClient.id, { ...manifest, bootstrapId: crypto.randomUUID() }, store);
    expect(losing.accepted).toBe(false);
    const [{ count }] = await sql<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM sync_events`;
    expect(count).toBe("1");

    const bundle = join(root, "plugin-bundle");
    await mkdir(bundle);
    await Bun.write(join(bundle, "main.js"), "module.exports = {};");
    await Bun.write(join(bundle, "manifest.json"), JSON.stringify({ id: "obsidian-sync-engine", version: "1.0.0" }));
    const previousBundle = process.env.PLUGIN_BUNDLE_DIR;
    process.env.PLUGIN_BUNDLE_DIR = bundle;
    const download = await createDownloadBootstrap({
      vaultId: "integration-vault", configDir: ".obsidian", pluginId: "obsidian-sync-engine", serverUrl: "http://sync.test",
    }, store);
    if (previousBundle === undefined) delete process.env.PLUGIN_BUNDLE_DIR;
    else process.env.PLUGIN_BUNDLE_DIR = previousBundle;
    const app = new Hono();
    registerBootstrapRoutes(app, engine);
    expect((await app.request(download.url, { method: "HEAD" })).status).toBe(200);
    expect((await app.request(download.url, { method: "HEAD" })).status).toBe(200);
    const zipResponse = await app.request(download.url);
    expect(zipResponse.status).toBe(200);
    const archive = unzipSync(new Uint8Array(await zipResponse.arrayBuffer()));
    expect(strFromU8(archive["bootstrap.md"]!)).toBe("bootstrap text");
    expect(JSON.parse(strFromU8(archive[".obsidian/plugins/obsidian-sync-engine/data.json"]!)).snapshotRevision).toBe("1");
    expect((await app.request(download.url)).status).toBe(404);

    const expiring = await createClient("expiring-bootstrap-client");
    const expiredCapability = "expired-capability";
    await sql`
      INSERT INTO bootstrap_links(capability_hash, generated_client_id, snapshot_revision, zip_path, expires_at)
      VALUES (${hashSecret(expiredCapability)}, ${expiring.id}, 1, '/tmp/expired.zip', NOW() - INTERVAL '1 minute')
    `;
    expect(await expireBootstrapLinks()).toBe(1);
    expect(await authenticateClient(expiring.id, expiring.secret)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
