# Bugrun Report

Date: 2026-05-23

Scope note: this file is both a mitigation report and an implementation playbook. If the source tree does not contain one of the fixes listed below, treat the relevant playbook section as the exact handoff for re-implementing it. Do not assume the prose alone means the code is already present.

## Bugs And Target Fixes

1. Restarted/stale clients can now recover from later peer Yjs edits.
   - Bug: `ChangeBatch` packets only carried incremental Yjs payloads. If a client had advanced `lastPulledRevision` but had stale/missing local Yjs state, applying a later peer update could produce no visible text and still advance the revision.
   - Fix: server change batches now include the materialized `files.yjs_state` for `YjsUpdate` rows. The plugin already prefers full `yjsState` when present, so stale restarted clients can recover.
   - Coverage: `Yjs change batches include full state so a stale restarted client can recover`.

2. Local snapshot/bootstrap no longer pairs fresh markdown content with stale Yjs state.
   - Bug: initial snapshots and bootstrap snapshots reused any persisted `.state` file, then wrote the current content hash even if the state represented old content.
   - Fix: `SyncClient`, `BootstrapUploader`, and open-document creation now compare stored content hashes with current markdown content and regenerate Yjs state on mismatch.
   - Coverage: `regenerates stale markdown Yjs state before snapshotting local content`, `opens markdown docs from editor content when cached Yjs state is stale`.

3. Closed-file markdown modify events now upload.
   - Bug: markdown `modify` events outside the CodeMirror editor path only refreshed local Yjs state. They did not enqueue an outbox mutation, so external/plugin edits to closed notes could remain local.
   - Fix: closed markdown modifies now refresh state and enqueue a `YjsUpdate` outbox row, while remote applies and open editor docs are still ignored to avoid loops.
   - Coverage: `queues closed markdown modify events as Yjs uploads`.

4. Remote delete/rename now works for adapter-only paths.
   - Bug: `VaultMutator.deletePath` and `renamePath` only acted on Obsidian-loaded `TFile`/`TFolder` objects. Adapter-only files, including config files and unloaded notes, could be left behind.
   - Fix: `VaultMutator` now falls back to adapter `stat/list/remove/rmdir/rename`, and also handles parent file collisions before creating folders.
   - Coverage: adapter-only delete, adapter-only rename, and parent-file-collision tests in `VaultMutator.test.ts`.

5. Snapshot reset cleanup now sees adapter paths.
   - Bug: snapshot reset deletion enumerated only `app.vault.getFiles()`, missing unloaded/adapter-only files absent from the server snapshot.
   - Fix: snapshot cleanup now reuses the full snapshot path walker and deletes through `VaultMutator`.
   - Coverage: `snapshot reset deletes adapter-only files that are absent from the server snapshot`.

6. Bootstrap manifest cache is treated as plugin-local state.
   - Bug: `.obsidian/plugins/obsidian-sync-engine/bootstrap/active.jsonl` could be synced if left behind after a failed bootstrap.
   - Fix: path policy now excludes the plugin `bootstrap` directory.
   - Coverage: `pathPolicy.test.ts` checks bootstrap cache exclusion.

7. Server TypeScript check now passes for bootstrap hashing.
   - Bug: `crypto.subtle.digest` rejected `Uint8Array<ArrayBufferLike>` under `tsc`.
   - Fix: copy bytes into a concrete `ArrayBuffer` before hashing.

8. Regular large blob upload must be transactionally staged.
   - Bug: `/v1/blobs/:path` wrote directly into `files` before the metadata mutation was accepted. A crash between blob upload and outbox mutation could leave an orphan or prematurely visible large-object row.
   - Fix target: regular blob uploads should write to `blob_uploads` with an upload id, and `UpsertFile` large-object mutations should consume that staged upload inside the same transaction that writes `sync_events`.
   - Required coverage: large-object mutation rollback when staged content is missing, HTTP staged upload finalization, overwrite/unlink coverage, and WebSocket rejection for missing staged blobs.

9. Startup markdown scans must upload files changed while the app was closed.
   - Bug: `VaultYjsIndexer` refreshed stale local Yjs state during startup scans but did not enqueue an upload, so offline edits made while Obsidian was closed could remain local.
   - Fix target: existing markdown state hash mismatches should call back into the plugin, which enqueues a `YjsUpdate` after startup sync begins indexing.
   - Required coverage: `VaultYjsIndexer` reports startup hash mismatches and `SyncEngine` queues startup markdown changes.

## Target Verification

- `cd plugin && npm test -- --run`: all plugin/shared Vitest files pass.
- `cd plugin && npm run build`: passes.
- `cd server && bun test`: all Bun unit/integration tests pass.
- `cd server && bunx tsc -p tsconfig.json --noEmit`: passes.

## Remaining risks

1. Full Yjs state on every Yjs change batch increases packet size for large notes.
   - This is the safer production behavior for correctness. If payload size becomes an issue, optimize later with a protocol flag or server-side fallback that sends full state only when a client reports missing dependencies.

## Implementation Playbook

### 1. Restart/Stale Client Recovery

Bug to prevent:
- Client A has `lastPulledRevision = 10` but stale local Yjs state for `notes/a.md`.
- Client B edits the note and server creates revision 11.
- Client A pulls revision 11 and receives only an incremental update that depends on missing structs.
- Yjs may accept the update without changing visible text. If the client then advances `lastPulledRevision`, it will never ask for the missing state again.

Required server change:

```ts
// server/src/sync/engine.ts
export async function changeBatchPacket(fromRevision: string): Promise<Extract<wsPacket, { type: opType.ChangeBatch }>> {
  const rows = await sql<EventRow[]>`
    SELECT
      e.revision::TEXT AS revision,
      e.client_id AS "clientId",
      e.mutation_id AS "mutationId",
      e.operation,
      e.path,
      e.to_path AS "toPath",
      e.content,
      e.content_bytes AS "contentBytes",
      e.storage_kind AS "storageKind",
      e.byte_size::TEXT AS "byteSize",
      e.content_sha256 AS "contentSha256",
      e.payload,
      CASE
        WHEN e.operation = 'YjsUpdate' THEN f.yjs_state
        ELSE NULL::BYTEA
      END AS "yjsState",
      e.compacted,
      e.is_folder AS "isFolder",
      e.is_yjs AS "isYjs",
      EXTRACT(EPOCH FROM e.created_at) * 1000 AS "createdAt"
    FROM sync_events e
    LEFT JOIN files f
      ON f.path = e.path
    WHERE e.revision > ${fromRevision}
    ORDER BY e.revision ASC
    LIMIT ${CHANGE_BATCH_ROW_LIMIT};
  `;
  // existing return body
}
```

Why this is safe:
- The plugin already checks `change.yjsState` before `change.data` in `SyncClient.applyServerChanges`.
- Full state is idempotent in Yjs and recovers clients missing prior structs.

Required test:

```ts
// server/src/sync/engine.integration.test.ts
it("Yjs change batches include full state so a stale restarted client can recover", async () => {
  await seedMarkdownFile(CLIENT_A, NOTE_PATH, "base");
  const seeded = await getFile(NOTE_PATH);
  expect(seeded?.yjsState).toBeInstanceOf(Uint8Array);

  const clientADoc = docFromState(seeded!.yjsState!);
  appendToDoc(clientADoc, " from A");
  const revisionAfterA = await uploadYjsEdit(CLIENT_A, NOTE_PATH, clientADoc);
  clientADoc.destroy();

  const clientBDoc = await currentServerDoc(NOTE_PATH);
  appendToDoc(clientBDoc, " from B");
  await uploadYjsEdit(CLIENT_B, NOTE_PATH, clientBDoc);
  clientBDoc.destroy();

  const pull = await handlePull({ type: opType.PullSince, revision: revisionAfterA });
  expect(pull.type).toBe(opType.ChangeBatch);
  if (pull.type !== opType.ChangeBatch) return;

  const yjsChange = pull.changes.find(change => change.operation === "YjsUpdate");
  expect(yjsChange?.data).toBeInstanceOf(Uint8Array);
  expect(yjsChange?.yjsState).toBeInstanceOf(Uint8Array);

  const staleRestartedDoc = docFromState(seeded!.yjsState!);
  Y.applyUpdateV2(staleRestartedDoc, yjsChange!.yjsState!);
  const recovered = readDoc(staleRestartedDoc);
  expect(recovered).toContain("base");
  expect(recovered).toContain("from A");
  expect(recovered).toContain("from B");
  staleRestartedDoc.destroy();
});
```

Do not advance `lastPulledRevision` for Yjs rows that were not actually applied or recovered through full state.

### 2. Stale Local Yjs State In Snapshot/Bootstrap/Open-Doc Paths

Bug to prevent:
- Local markdown file content is `current`.
- Stored `.sync-engine-state/...state` still materializes to `old`.
- Snapshot/bootstrap sends `content: "current"` with `yjsState: old-state`.
- Server stores inconsistent markdown/Yjs state. Later merges can reintroduce old content.

Required rule:
- Before trusting stored Yjs state, compare `YjsStateStore.getContentHash(path)` with SHA-256 of current file content.
- If missing or different, regenerate state with `docStateFromContent(content, Y)` and write via `putWithContentHash`.

Patch shape:

```ts
// plugin/src/sync/SyncClient.ts inside readVaultSnapshot markdown branch
const contentHash = await sha256Hex(new TextEncoder().encode(content));
let yjsState = await this.stateStore.get(entry.path);
const storedContentHash = await this.stateStore.getContentHash(entry.path);
if (!yjsState || storedContentHash !== contentHash) {
  yjsState = docStateFromContent(content, Y);
  await this.stateStore.putWithContentHash(entry.path, yjsState, contentHash);
}
```

Apply the same pattern in:
- `plugin/src/sync/BootstrapUploader.ts::readVaultSnapshot`.
- `plugin/src/main.ts::newDoc`, using `initialContent`.

Required tests:
- `SyncClient.test.ts`: stale state in `MemoryYjsStateStore`, current file content differs, `readVaultSnapshot()` emits Yjs state that materializes to current content.
- `main.test.ts`: `newDoc(path, "current")` ignores stale stored state and opens a doc containing current text.

### 3. Closed Markdown Modify Events Must Upload

Bug to prevent:
- A plugin, external editor, file watcher, or Obsidian background operation modifies a closed `.md` file.
- `vault.on("modify")` fires.
- Current code only refreshes local Yjs cache or does nothing, so other clients never receive the edit.

Required `main.ts` event flow:

```ts
this.registerEvent(this.app.vault.on("modify", file => {
  log.debug("vault modify event", { path: file.path, type: file instanceof TFolder ? "folder" : "file" });
  void this.queueExternalMarkdownChange(file).catch(error => {
    log.error("failed to enqueue external markdown change", { path: file.path, ...errorContext(error) });
    new Notice(`Sync outbox write failed: ${errorMessage(error)}`);
  });
  void this.queueNonMarkdownUpsert(file);
}));
```

Required helper:

```ts
private async queueExternalMarkdownChange(file: TAbstractFile): Promise<void> {
  if (!(file instanceof TFile) || file.extension !== "md") return;
  if (this.syncClient?.isApplyingRemoteChanges(file.path) || !this.shouldSyncLocalPath(file.path)) return;
  if (this.docs.has(file.path) || this.pendingDocs.has(file.path)) return;

  const content = await this.app.vault.read(file);
  const contentHash = await sha256Hex(new TextEncoder().encode(content));
  if (await this.yjsStateStore.getContentHash(file.path) === contentHash && await this.yjsStateStore.has(file.path)) {
    return;
  }

  const yjsState = docStateFromContent(content, Y);
  await this.yjsStateStore.putWithContentHash(file.path, yjsState, contentHash);
  await this.db.putInOutbox({
    mutationId: crypto.randomUUID(),
    operation: "YjsUpdate",
    path: file.path,
    data: new Uint8Array(),
    created: Date.now(),
  });
  log.info("queued external markdown change", { path: file.path, chars: content.length });
  this.syncClient.wakeSoon();
}
```

Why `data: new Uint8Array()` is acceptable:
- `SyncClient.prepareSegmentJsonl` resolves/coalesces Yjs paths from the current state store/open doc before upload.
- The empty row is a wake-up marker, not the final payload sent to the server.

Required test:
- `main.test.ts`: closed markdown modify with stale hash enqueues exactly one `YjsUpdate`, updates state hash, and calls `wakeSoon`.

### 4. Startup Scan For Files Edited While Obsidian Was Closed

Bug to prevent:
- User edits `notes/a.md` while Obsidian is closed.
- On next startup there is no `modify` event for that historical change.
- `VaultYjsIndexer` detects the hash mismatch but only rewrites local state, never queues upload.

Required `VaultYjsIndexer` extension:

```ts
// plugin/src/yjs/VaultYjsIndexer.ts
export type IndexedMarkdownChange = {
  path: string;
  content: string;
  state: Uint8Array;
  contentHash: string;
};

constructor(
  private readonly app: App,
  private readonly store: YjsStateStore,
  private readonly shouldIgnorePath: (path: string) => boolean,
  private readonly onChangedFile: (change: IndexedMarkdownChange) => Promise<void> = async () => {},
) {}
```

Required `ensureFile` behavior:

```ts
async ensureFile(file: TAbstractFile): Promise<void> {
  if (!(file instanceof TFile) || file.extension !== "md" || this.shouldIgnorePath(file.path)) return;

  const content = await this.app.vault.read(file);
  const contentHash = await sha256Hex(new TextEncoder().encode(content));
  const cachedHash = await this.store.getContentHash(file.path);
  if (cachedHash === contentHash && await this.store.has(file.path)) return;

  const state = docStateFromContent(content, Y);
  await this.store.putWithContentHash(file.path, state, contentHash);
  await this.onChangedFile({ path: file.path, content, state, contentHash });
  log.debug("indexed Yjs state", { path: file.path, chars: content.length });
}
```

Plugin callback:

```ts
this.yjsIndexer = new VaultYjsIndexer(
  this.app,
  this.yjsStateStore,
  path => !shouldUseYjs(path, this.app.vault.configDir) || this.isPluginInternalPath(path),
  async change => {
    if (this.syncClient?.isApplyingRemoteChanges(change.path)) return;
    if (this.docs.has(change.path) || this.pendingDocs.has(change.path)) return;
    await this.db.putInOutbox({
      mutationId: crypto.randomUUID(),
      operation: "YjsUpdate",
      path: change.path,
      data: new Uint8Array(),
      created: Date.now(),
    });
    log.info("queued startup markdown change", { path: change.path, chars: change.content.length });
    this.syncClient.wakeSoon();
  },
);
```

Ordering requirement:
- Keep `startYjsIndexer()` in the `onStartupSynced` callback.
- Do not enqueue startup local scan changes before startup pull finishes, or local stale content can race with remote snapshot application.

Tests:
- Add `plugin/src/yjs/VaultYjsIndexer.test.ts`.
- Test mismatch calls `onChangedFile`.
- Test matching hash does not call it.
- Add `main.test.ts` coverage for the callback enqueueing a `YjsUpdate`.

### 5. Remote Delete/Rename For Adapter-Only Paths

Bug to prevent:
- Remote snapshot/delete/rename targets a file that Obsidian has not loaded as a `TFile`.
- `getAbstractFileByPath` returns null.
- Old mutator returns without changing disk.

Required `VaultMutator` behavior:

```ts
private async adapterPathKind(path: string): Promise<"file" | "folder" | null> {
  const adapter = this.app.vault.adapter as App["vault"]["adapter"] & {
    stat?: (path: string) => Promise<{ type?: string } | null>;
  };

  let stat: { type?: string } | null | undefined;
  try {
    stat = await adapter.stat?.(path);
  } catch {
    stat = null;
  }
  if (stat?.type === "folder" || stat?.type === "file") return stat.type;
  if (!(await adapter.exists(path))) return null;

  try {
    await adapter.list(path);
    return "folder";
  } catch {
    return "file";
  }
}
```

Delete fallback:

```ts
async deletePath(path: string): Promise<void> {
  const normalized = normalizePath(path);
  const existing = this.app.vault.getAbstractFileByPath(normalized);
  if (existing) {
    await this.app.fileManager.trashFile(existing);
    await this.stateStore.delete(normalized, existing instanceof TFolder);
    return;
  }

  const adapterKind = await this.adapterPathKind(normalized);
  if (adapterKind === "folder") {
    await this.app.vault.adapter.rmdir(normalized, true);
    await this.stateStore.delete(normalized, true);
    return;
  }
  if (adapterKind === "file") {
    await this.app.vault.adapter.remove(normalized);
    await this.stateStore.delete(normalized, false);
    return;
  }
  await this.stateStore.delete(normalized, false);
}
```

Rename fallback:

```ts
async renamePath(fromPath: string, toPath: string): Promise<void> {
  const normalizedFrom = normalizePath(fromPath);
  const normalizedTo = normalizePath(toPath);
  const existing = this.app.vault.getAbstractFileByPath(normalizedFrom);
  const parent = dirname(normalizedTo);
  if (parent) await this.ensureFolder(parent);

  if (existing) {
    await this.app.vault.rename(existing, normalizedTo);
    await this.stateStore.rename(normalizedFrom, normalizedTo, existing instanceof TFolder);
    return;
  }

  const adapterKind = await this.adapterPathKind(normalizedFrom);
  if (!adapterKind) return;
  if (await this.app.vault.adapter.exists(normalizedTo)) {
    await this.deletePath(normalizedTo);
  }
  await this.app.vault.adapter.rename(normalizedFrom, normalizedTo);
  await this.stateStore.rename(normalizedFrom, normalizedTo, adapterKind === "folder");
}
```

Tests:
- Adapter-only file delete removes bytes and deletes Yjs state.
- Adapter-only file rename moves bytes and renames Yjs state.
- Parent file collision is removed before creating nested folders.

### 6. Snapshot Reset Must Delete Adapter-Only Files

Bug to prevent:
- Snapshot reset from server excludes a local file.
- Local file is adapter-only and absent from `app.vault.getFiles()`.
- Reset applies server files but leaves stale local file on disk.

Required `SyncClient` change:

```ts
private async localPathsMissingFromSnapshot(paths: Set<string>): Promise<SnapshotPath[]> {
  return (await this.listSnapshotPaths())
    .filter(entry => this.shouldSyncLocalPath(entry.path) && !paths.has(normalizePath(entry.path)))
    .sort((a, b) => b.path.length - a.path.length);
}

private async deletePathsMissingFromSnapshot(paths: Set<string>): Promise<void> {
  const entries = await this.localPathsMissingFromSnapshot(paths);
  await this.vaultMutator.runRemoteMutation(entries.map(entry => entry.path), async () => {
    for (const entry of entries) {
      await this.vaultMutator.deletePath(entry.path);
    }
  });
}
```

Also update the `toDelete` count in `applySnapshotReset` to call `localPathsMissingFromSnapshot`.

Test:
- `SyncClient.test.ts`: adapter-only `notes/unloaded.md` is deleted when snapshot files is empty and last pulled revision is nonzero.

### 7. Plugin-Local Path Exclusions

Required path policy:

```ts
// shared/pathPolicy.ts
if (path === `${prefix}/bootstrap` || path.startsWith(`${prefix}/bootstrap/`)) {
  return true;
}
```

Already expected exclusions:
- `.obsidian/plugins/obsidian-sync-engine/data.json`
- `.obsidian/plugins/obsidian-sync-engine/outbox/**`
- `.obsidian/plugins/obsidian-sync-engine/yjs-state/**`
- `.sync-engine-state/**`
- `.trash/**`
- `.git/**`

Test:
- `shared/pathPolicy.test.ts` should assert bootstrap cache is not synced.

### 8. Transactional Large Blob Staging

This is the highest-risk non-Yjs storage bug. Implement it only with tests.

Schema:

```sql
-- server/src/db/migrations/0005_blob_upload_staging.sql
CREATE TABLE IF NOT EXISTS blob_uploads (
    upload_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_oid OID NOT NULL,
    byte_size BIGINT NOT NULL,
    content_sha256 TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS blob_uploads_client_path_sha_idx
    ON blob_uploads(client_id, path, content_sha256, created_at DESC);
```

Migration runner:
- Import the new SQL file in `server/src/db/MigrationRunner.ts`.
- Add it after `0004_yjs_compaction_index`.

Shared type:

```ts
// shared/types.ts
export type SyncMutation = {
  // existing fields...
  blobUploadId?: string;
};
```

Validation:

```ts
// shared/validate.ts mutation schema
blobUploadId: z.string().optional(),
```

Server staging helper:

```ts
// server/src/sync/blobUpload.ts
export async function stageBlobFile(clientId: string, path: string, data: Uint8Array | ReadableStream<Uint8Array>, sha: string | null) {
  return sql.begin(async tx => {
    const uploadId = crypto.randomUUID();
    const written = await createLargeObject(data, tx);
    await tx`
      INSERT INTO blob_uploads (upload_id, client_id, path, content_oid, byte_size, content_sha256)
      VALUES (${uploadId}, ${clientId}, ${path}, ${written.oid}, ${written.byteSize}, ${sha});
    `;
    return { uploadId, path, byteSize: written.byteSize, contentSha256: sha };
  });
}

export async function consumeStagedBlob(tx: typeof sql, clientId: string, uploadId: string, path: string) {
  const rows = await tx<{ contentOid: number; byteSize: string; contentSha256: string | null }[]>`
    DELETE FROM blob_uploads
    WHERE upload_id = ${uploadId}
      AND client_id = ${clientId}
      AND path = ${path}
    RETURNING content_oid AS "contentOid", byte_size::TEXT AS "byteSize", content_sha256 AS "contentSha256";
  `;
  return rows[0] ?? null;
}
```

Server route:

```ts
// server/src/index.ts
app.put("/v1/blobs/:path", async c => {
  const denied = await requireBlobAuth(c.req.raw);
  if (denied) return denied;
  const path = decodePathToken(c.req.param("path"));
  const clientId = c.req.header("X-Client-Id") ?? "";
  if (!clientId) return c.text("Client id is required", 400);
  const body = c.req.raw.body;
  if (!body) return c.text("Blob body is required", 400);
  return c.json(await stageBlobFile(clientId, path, body, c.req.header("X-Content-Sha256") ?? null));
});
```

Plugin upload response:

```ts
// plugin/src/sync/BlobClient.ts
type BlobUploadResponse = {
  uploadId: string;
  path: string;
  byteSize: number;
  contentSha256: string | null;
};
```

`SyncClient.uploadBlob` should return:

```ts
return {
  blobUploadId: response.uploadId,
  byteSize: response.byteSize,
  contentSha256: response.contentSha256 ?? contentSha256,
};
```

Every large-file `UpsertFile` outbox row must include:

```ts
storageKind: "lo",
blobUploadId: metadata.blobUploadId,
byteSize: metadata.byteSize,
contentSha256: metadata.contentSha256,
```

`applyMutation` transaction rules:
- Check duplicate `(client_id, mutation_id)` first. If duplicate, return existing revision before consuming staged blob.
- Validate path before consuming staged blob.
- Consume staged blob inside the same transaction that inserts `sync_events` and updates `files`.
- If staged blob is missing, reject or skip consistently. Prefer rejecting during tests, but if backward compatibility requires acking, do not insert `sync_events` and do not update `files`.
- Unlink the previous large object only after the new `files` row is safely set.

Tests:
- HTTP blob upload creates a `blob_uploads` row and no `files` row.
- Matching large `UpsertFile` consumes `blob_uploads`, creates `sync_events`, and updates `files`.
- Wrong client/path/upload id cannot consume staged blob.
- Duplicate mutation id does not double-consume.
- Missing staged blob does not create a visible file.

### 9. Future Optimization: Full Yjs State Size

Do not optimize this until all correctness tests pass.

Safe path:
- Add optional auth capability:

```ts
capabilities?: {
  yjsFullStateOnChange?: boolean;
};
```

- Keep explicit pull/startup responses full-state by default.
- Only consider omitting full state on live fan-out if client has a fallback.
- Client fallback: if a Yjs update without `yjsState` does not change materialized content, immediately request DocSync for that path before advancing `lastPulledRevision`.

Guard test:
- Keep or replace `Yjs change batches include full state so a stale restarted client can recover`.
- Never allow a client to advance revision past a Yjs change it cannot materialize.

## Core Invariants

- Do not advance `lastPulledRevision` unless local disk/Yjs state has reached that revision, or the row is a confirmed echo from the same `clientId`.
- Do not trust persisted Yjs state unless its content hash matches current file content.
- Open editor documents are owned by `DocSync`; closed markdown changes are owned by vault modify events and the startup indexer.
- Remote mutations must work for loaded Obsidian objects and adapter-only paths.
- Plugin-local state must never sync: `data.json`, `outbox`, `yjs-state`, `bootstrap`, and `.sync-engine-state`.
- Large blobs become authoritative only inside the mutation transaction.
