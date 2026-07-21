import { sql } from "bun";
import { createHash, randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Zip, ZipDeflate } from "fflate";
import type { Hono } from "hono";
import * as Y from "yjs";
import {
  bootstrapManifestSchema,
  shouldSyncVaultPath,
  type BootstrapCommitResponse,
  type BootstrapManifest,
  type Revision,
} from "obsidian-sync-protocol";
import { createClient, getAuthenticatedClient, hashSecret, requireBearer } from "../auth/auth";
import { objectStore, type ObjectStore } from "../storage/object_store";
import { syncEngine, type SyncEngine } from "./engine";

const LINK_LIFETIME_MS = 5 * 60 * 1000;

type SnapshotFile = {
  id: string;
  current_path: string;
  kind: "markdown" | "blob";
  object_hash: string | null;
  yjs_state_hash: string | null;
  current_revision: string;
};

export async function commitInitialBootstrap(
  clientId: string,
  manifest: BootstrapManifest,
  store: ObjectStore = objectStore,
): Promise<BootstrapCommitResponse> {
  const fileIds = new Set<string>();
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    if (fileIds.has(entry.fileId) || paths.has(entry.path)) {
      throw new BootstrapError("DUPLICATE_ENTRY", "Bootstrap file IDs and paths must be unique", 400);
    }
    fileIds.add(entry.fileId);
    paths.add(entry.path);
    if ((entry.kind === "markdown") !== entry.path.toLowerCase().endsWith(".md")) {
      throw new BootstrapError("KIND_MISMATCH", "Bootstrap file kind does not match its path", 400);
    }
    if (!(await store.has(entry.objectHash))) throw new BootstrapError("OBJECT_MISSING", `Object ${entry.objectHash} has not been uploaded`, 409);
    if (entry.kind === "markdown") {
      try {
        const doc = new Y.Doc();
        Y.applyUpdate(doc, await store.read(entry.objectHash));
        doc.getText("content");
      } catch {
        throw new BootstrapError("INVALID_YJS_STATE", "A Markdown bootstrap object is not valid Yjs state", 400);
      }
    }
  }

  const result = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(73194522)`;
    const [existing] = await tx<{ snapshot_revision: string }[]>`
      SELECT snapshot_revision::text FROM bootstrap_commits WHERE bootstrap_id = ${manifest.bootstrapId}
    `;
    if (existing) {
      const current = await currentRevisionInTransaction(tx);
      const fileRevisions = [];
      for (const entry of manifest.entries) {
        const [file] = await tx<{ revision: Revision }[]>`
          SELECT current_revision::text AS revision FROM files WHERE id = ${entry.fileId}
        `;
        if (!file) throw new Error("committed bootstrap file is missing");
        fileRevisions.push({ fileId: entry.fileId, revision: file.revision });
      }
      return { accepted: true, snapshotRevision: existing.snapshot_revision, currentServerRevision: current, fileRevisions };
    }
    const [meta] = await tx<{ bootstrap_state: string }[]>`SELECT bootstrap_state FROM server_meta WHERE singleton = TRUE FOR UPDATE`;
    if (meta?.bootstrap_state !== "empty") {
      const current = await currentRevisionInTransaction(tx);
      return {
        accepted: false,
        snapshotRevision: current,
        currentServerRevision: current,
        fileRevisions: [] as Array<{ fileId: string; revision: Revision }>,
      };
    }

    let snapshotRevision: Revision = "0";
    const fileRevisions: Array<{ fileId: string; revision: Revision }> = [];
    for (const entry of manifest.entries) {
      const [allocated] = await tx<{ revision: Revision }[]>`SELECT nextval('global_revision')::text AS revision`;
      if (!allocated) throw new Error("failed to allocate bootstrap revision");
      snapshotRevision = allocated.revision;
      fileRevisions.push({ fileId: entry.fileId, revision: snapshotRevision });
      await tx`
        INSERT INTO files(id, current_path, kind, deleted, current_revision, object_hash, yjs_state_hash)
        VALUES (${entry.fileId}, ${entry.path}, ${entry.kind}, FALSE, ${snapshotRevision},
          ${entry.kind === "blob" ? entry.objectHash : null}, ${entry.kind === "markdown" ? entry.objectHash : null})
      `;
      const mutationId = `bootstrap:${manifest.bootstrapId}:${entry.fileId}`;
      const resultJson = { mutationId, status: "accepted", revision: snapshotRevision };
      await tx`
        INSERT INTO sync_events(revision, client_id, mutation_id, operation, file_id, path, object_hash, result_json)
        VALUES (${snapshotRevision}, ${clientId}, ${mutationId}, 'create', ${entry.fileId}, ${entry.path}, ${entry.objectHash}, ${JSON.stringify(resultJson)}::jsonb)
      `;
    }
    await tx`
      INSERT INTO bootstrap_commits(bootstrap_id, client_id, snapshot_revision)
      VALUES (${manifest.bootstrapId}, ${clientId}, ${snapshotRevision})
    `;
    await tx`
      UPDATE server_meta SET bootstrap_state = 'committed', current_snapshot_revision = ${snapshotRevision}, updated_at = NOW()
      WHERE singleton = TRUE
    `;
    return { accepted: true, snapshotRevision, currentServerRevision: snapshotRevision, fileRevisions };
  });
  if (result.accepted) await Promise.all(manifest.entries.map((entry) => store.markReferenced(entry.objectHash)));
  return result;
}

async function currentRevisionInTransaction(tx: any): Promise<Revision> {
  const rows = await tx`SELECT COALESCE(MAX(revision), 0)::text AS revision FROM sync_events`;
  return rows[0]?.revision ?? "0";
}

export type BootstrapZipRequest = { vaultId: string; configDir: string; pluginId: string; serverUrl: string };
export type BootstrapZipResult = { url: string; expiresAt: string; snapshotRevision: Revision; capabilityHash: string };

export async function createDownloadBootstrap(
  request: BootstrapZipRequest,
  store: ObjectStore = objectStore,
): Promise<BootstrapZipResult> {
  const snapshot = await sql.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
    const revision = await currentRevisionInTransaction(tx);
    const files = await tx<SnapshotFile[]>`
      SELECT id, current_path, kind, object_hash, yjs_state_hash, current_revision::text
      FROM files WHERE deleted = FALSE ORDER BY current_path
    `;
    return { revision, files };
  });

  const client = await createClient(randomReadableName());
  const capability = randomBytes(32).toString("base64url");
  const capabilityHash = hashSecret(capability);
  const expiresAt = new Date(Date.now() + LINK_LIFETIME_MS);
  const buildDir = await mkdtemp(join(tmpdir(), "obsidian-sync-bootstrap-"));
  const vaultDir = join(buildDir, "vault");
  const zipPath = join(buildDir, "vault.zip");
  await mkdir(vaultDir, { recursive: true });

  try {
    const pluginDir = join(vaultDir, request.configDir, "plugins", request.pluginId);
    const pluginBundleDir = process.env.PLUGIN_BUNDLE_DIR ?? join(import.meta.dir, "../../../plugin");
    await mkdir(pluginDir, { recursive: true });
    for (const asset of ["main.js", "manifest.json", "styles.css"]) {
      const source = join(pluginBundleDir, asset);
      if (asset === "main.js" && !(await Bun.file(source).exists())) {
        throw new Error("The plugin bundle is unavailable; set PLUGIN_BUNDLE_DIR to a built plugin release directory");
      }
      if (await Bun.file(source).exists()) await cp(source, join(pluginDir, asset), { force: true });
    }
    await mkdir(join(pluginDir, "yjs-state"), { recursive: true });
    const metadataFiles: Record<string, {
      fileId: string; path: string; kind: "markdown" | "blob"; revision: string; contentHash: string; deleted: false;
    }> = {};
    for (const file of snapshot.files) {
      if (!shouldSyncVaultPath(file.current_path, { configDir: request.configDir, pluginId: request.pluginId })) continue;
      const destination = join(vaultDir, ...file.current_path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      if (file.kind === "blob" && file.object_hash) {
        const bytes = await store.read(file.object_hash);
        await Bun.write(destination, bytes);
        metadataFiles[file.id] = {
          fileId: file.id, path: file.current_path, kind: "blob", revision: file.current_revision,
          contentHash: file.object_hash, deleted: false,
        };
      } else if (file.kind === "markdown" && file.yjs_state_hash) {
        const update = await store.read(file.yjs_state_hash);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, update);
        const text = doc.getText("content").toString();
        await Bun.write(destination, text);
        await Bun.write(join(pluginDir, "yjs-state", `${file.id}.bin`), update);
        await Bun.write(join(pluginDir, "yjs-state", `${file.id}.json`), JSON.stringify({
          stateVector: Buffer.from(Y.encodeStateVector(doc)).toString("base64"), updatedAt: new Date().toISOString(),
        }));
        metadataFiles[file.id] = {
          fileId: file.id, path: file.current_path, kind: "markdown", revision: file.current_revision,
          contentHash: createHash("sha256").update(text, "utf8").digest("hex"), deleted: false,
        };
      }
    }

    await mkdir(join(pluginDir, "sync-state"), { recursive: true });
    await Bun.write(join(pluginDir, "sync-state", "metadata.json"), JSON.stringify({
      version: 1, lastAppliedRevision: snapshot.revision, files: metadataFiles, conflicts: [],
    }));
    await Bun.write(join(pluginDir, "data.json"), JSON.stringify({
      serverUrl: request.serverUrl,
      clientName: client.displayName,
      clientId: client.id,
      clientSecret: client.secret,
      revision: snapshot.revision,
      snapshotRevision: snapshot.revision,
      vaultId: request.vaultId,
    }, null, 2));
    const enabledPluginsPath = join(vaultDir, request.configDir, "community-plugins.json");
    let enabledPlugins: string[] = [];
    if (await Bun.file(enabledPluginsPath).exists()) {
      try { enabledPlugins = await Bun.file(enabledPluginsPath).json() as string[]; } catch { enabledPlugins = []; }
    }
    if (!enabledPlugins.includes(request.pluginId)) enabledPlugins.push(request.pluginId);
    await mkdir(dirname(enabledPluginsPath), { recursive: true });
    await Bun.write(enabledPluginsPath, JSON.stringify(enabledPlugins));
    await writeZipDirectory(vaultDir, zipPath);
    await sql`
      INSERT INTO bootstrap_links(capability_hash, generated_client_id, snapshot_revision, zip_path, expires_at)
      VALUES (${capabilityHash}, ${client.id}, ${snapshot.revision}, ${zipPath}, ${expiresAt})
    `;
  } catch (error) {
    await sql`UPDATE clients SET status = 'revoked', updated_at = NOW() WHERE id = ${client.id}`;
    await rm(buildDir, { recursive: true, force: true });
    throw error;
  }
  return {
    url: `${request.serverUrl.replace(/\/$/, "")}/v1/bootstrap/${capability}`,
    expiresAt: expiresAt.toISOString(),
    snapshotRevision: snapshot.revision,
    capabilityHash,
  };
}

async function writeZipDirectory(root: string, destination: string): Promise<void> {
  const paths = await listRelativeFiles(root);
  const sink = Bun.file(destination).writer({ highWaterMark: 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      void Promise.resolve(sink.end(error instanceof Error ? error : new Error(String(error)))).finally(() => reject(error));
    };
    const archive = new Zip((error, chunk, final) => {
      if (error) { fail(error); return; }
      try { sink.write(chunk); }
      catch (writeError) { fail(writeError); return; }
      if (final && !settled) {
        settled = true;
        void Promise.resolve(sink.end()).then(() => resolve(), reject);
      }
    });
    void (async () => {
      try {
        for (const relativePath of paths) {
          const entry = new ZipDeflate(relativePath, { level: 6 });
          archive.add(entry);
          const reader = Bun.file(join(root, ...relativePath.split("/"))).stream().getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            entry.push(value);
          }
          entry.push(new Uint8Array(), true);
        }
        archive.end();
      } catch (error) {
        archive.terminate();
        fail(error);
      }
    })();
  });
}

async function listRelativeFiles(root: string, relative = ""): Promise<string[]> {
  const directory = relative ? join(root, ...relative.split("/")) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listRelativeFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function expireBootstrapLinks(): Promise<number> {
  const rows = await sql<{ capability_hash: string; generated_client_id: string; zip_path: string }[]>`
    DELETE FROM bootstrap_links
    WHERE consumed_at IS NULL AND expires_at <= NOW()
    RETURNING capability_hash, generated_client_id, zip_path
  `;
  await Promise.all(rows.map(async (row) => {
    await sql`UPDATE clients SET status = 'revoked', updated_at = NOW() WHERE id = ${row.generated_client_id}`;
    await cleanupBootstrapZip(row.zip_path);
  }));
  return rows.length;
}

function randomReadableName(): string {
  const words = ["amber", "cedar", "comet", "coral", "falcon", "fern", "harbor", "indigo", "lantern", "maple", "otter", "quartz", "river", "solar", "willow", "zephyr"];
  const pick = () => words[Math.floor(Math.random() * words.length)]!;
  return `${pick()}-${pick()}-${randomBytes(2).toString("hex")}`;
}

export class BootstrapError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

export function registerBootstrapRoutes(app: Hono, engine: SyncEngine = syncEngine): void {
  app.post("/v1/bootstrap/initial/:bootstrapId/manifest", requireBearer, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = bootstrapManifestSchema.safeParse({ ...(body as object ?? {}), bootstrapId: c.req.param("bootstrapId") });
    if (!parsed.success) return c.json({ code: "VALIDATION_FAILED", message: "Malformed bootstrap manifest" }, 400);
    try {
      const response = await commitInitialBootstrap(getAuthenticatedClient(c).id, parsed.data);
      if (response.accepted) engine.publishRevision(response.currentServerRevision);
      return c.json(response, response.accepted ? 200 : 409);
    } catch (error) {
      if (error instanceof BootstrapError) return c.json({ code: error.code, message: error.message }, error.status as 409);
      throw error;
    }
  });

  app.on("HEAD", "/v1/bootstrap/:capability", async (c) => {
    await expireBootstrapLinks();
    const hash = hashSecret(c.req.param("capability") ?? "");
    const [row] = await sql<{ zip_path: string; snapshot_revision: string }[]>`
      SELECT zip_path, snapshot_revision::text FROM bootstrap_links
      WHERE capability_hash = ${hash} AND consumed_at IS NULL AND expires_at > NOW()
    `;
    if (!row || !(await Bun.file(row.zip_path).exists())) return c.body(null, 404);
    return c.body(null, 200, { "Content-Type": "application/zip", "Cache-Control": "no-store" });
  });

  app.get("/v1/bootstrap/:capability", async (c) => {
    await expireBootstrapLinks();
    const hash = createHash("sha256").update(c.req.param("capability") ?? "", "utf8").digest("hex");
    if (c.req.method === "HEAD") {
      const [available] = await sql<{ zip_path: string }[]>`
        SELECT zip_path FROM bootstrap_links
        WHERE capability_hash = ${hash} AND consumed_at IS NULL AND expires_at > NOW()
      `;
      if (!available || !(await Bun.file(available.zip_path).exists())) return c.body(null, 404);
      return c.body(null, 200, { "Content-Type": "application/zip", "Cache-Control": "no-store" });
    }
    const row = await sql.begin(async (tx) => {
      const [claimed] = await tx<{ zip_path: string }[]>`
        UPDATE bootstrap_links SET consumed_at = NOW()
        WHERE capability_hash = ${hash} AND consumed_at IS NULL AND expires_at > NOW()
        RETURNING zip_path
      `;
      return claimed ?? null;
    });
    if (!row || !(await Bun.file(row.zip_path).exists())) return c.json({ code: "LINK_UNAVAILABLE", message: "This bootstrap link is expired or already used" }, 404);
    const zip = Bun.file(row.zip_path);
    setTimeout(() => void cleanupBootstrapZip(row.zip_path), 60_000);
    return new Response(zip, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=obsidian-sync-bootstrap.zip",
        "Cache-Control": "no-store",
      },
    });
  });
}

async function cleanupBootstrapZip(zipPath: string): Promise<void> {
  await rm(zipPath, { force: true });
  const parent = dirname(zipPath);
  if (basename(parent).startsWith("obsidian-sync-bootstrap-")) {
    await rm(parent, { recursive: true, force: true });
  }
}
