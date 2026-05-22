# Obsidian Sync Engine Performance Revamp

## Goal

Make the plugin feel smooth on constrained mobile WebKit while keeping:

- Google Docs style Markdown sync.
- Offline edits with lossless reconnect.
- Server-heavy compute wherever possible.
- No accidental data loss.
- Blob and large-file support for non-Markdown files.

This is not a security audit. It is an architecture and performance audit based on a static pass through the repo plus targeted local tests.

## Current System In One Page

The system is already shaped around a reasonable reliability model:

- The plugin writes local changes into a durable outbox under `.obsidian/plugins/<id>/outbox`.
- Markdown files use Yjs. Binary/non-Markdown files use whole-file upserts, with files larger than `64 KiB` uploaded through HTTP blob endpoints.
- The server keeps a materialized `files` table plus an append-only `sync_events` table.
- Clients pull by global revision and receive either `ChangeBatch` or `SnapshotReset`.
- Bootstrap can create/upload/download full-vault snapshots.

The performance problem is that the client does too much work on the hot path:

- It serializes and writes full Yjs state on each local edit.
- It often rebuilds Markdown Yjs state from full file content on vault modify events.
- It converts binary updates into base64 JSON strings for the outbox and wire protocol.
- It performs full-vault/config-dir scans in startup/bootstrap paths.
- It asks the server for DocSync state before each upload segment, then does more full-Yjs-state work locally.

On desktop this can look acceptable. On mobile, these costs hit the UI process, filesystem adapter, GC, and WebSocket parser all at once.

## Measurements

Commands run:

- `npm test` in `plugin`: 72 tests passed.
- `bun test src/yjs src/sqlUtils` in `server`: 9 tests passed.
- `npx vitest run protocol.test.ts pathPolicy.test.ts` in `shared`: 23 tests passed.

Targeted synthetic measurements on desktop Bun show why this design will hurt mobile:

- Encoding/decoding a `ChangeBatch` with `1000 x 4 KiB` binary updates via the current base64 JSON protocol took about `86 ms` to encode and allocated about `35 MB` RSS.
- Encoding the same shape as JSONL took about `101 ms` and allocated about `30 MB` RSS.
- A 10 KiB Markdown document after 10,000 random Yjs edits grew to about `70 KiB` of Yjs state. The edit/update encode loop took about `1.4 s` total on desktop Bun, before Obsidian adapter writes are included.
- Base64 encoding full states is not free: a 1 MiB Yjs state became a 1.33 MiB string and took about `17 ms` just to convert on desktop.

Treat those numbers as lower bounds. Mobile WebKit will usually be worse, especially when the same turn also touches Obsidian's vault adapter.

## Highest Impact Problems

### 1. Per-edit full Yjs state persistence

Hot path:

- `plugin/src/main.ts:233` handles every CodeMirror document change.
- `plugin/src/yjs/DocSync.ts:87` encodes a state vector.
- `plugin/src/yjs/DocSync.ts:135` encodes the local Yjs update.
- `plugin/src/yjs/DocSync.ts:136` writes both the outbox row and `persistState()`.
- `plugin/src/yjs/DocSync.ts:50` writes `Y.encodeStateAsUpdateV2(this.ydoc)` to disk.
- `plugin/src/yjs/YjsStateStore.ts:35` writes a full `.state` file through the vault adapter.

This means ordinary typing can repeatedly:

- Run Yjs encode work.
- Base64 encode the update for JSONL.
- Append to a vault file.
- Encode the entire document state.
- Rewrite the entire document state file.

That is the main mobile killer. The durable thing needed per edit is the local operation/update, not the full Yjs checkpoint.

Recommended change:

- Keep the open document Y.Doc in memory.
- Append only the raw local update to a small durable WAL.
- Debounce full state checkpointing to idle/close/ack, or every `N` updates / `M` seconds.
- On crash recovery, load last checkpoint and replay WAL updates.
- Do not write `.state` on every keystroke.

### 2. Markdown files are reindexed from full content on vault modify events

Hot path:

- `plugin/src/main.ts:170` runs on every vault modify event.
- `plugin/src/main.ts:172` calls `this.yjsIndexer.ensureFile(file)`.
- `plugin/src/yjs/VaultYjsIndexer.ts:54` reads the entire Markdown file.
- `plugin/src/yjs/VaultYjsIndexer.ts:55` hashes the entire content.
- `plugin/src/yjs/VaultYjsIndexer.ts:60` rebuilds a Yjs state from full content when the hash differs.

This overlaps with the editor hot path. Worse, local DocSync edits persist state but do not update the content hash, so a later vault modify can conclude the cached hash is stale and rebuild the state from raw Markdown content.

Recommended change:

- Remove `VaultYjsIndexer.ensureFile()` from ordinary Markdown modify events.
- If the file is open and has a `DocSync`, the open Y.Doc is authoritative locally.
- Update content hash when DocSync checkpoints state.
- Keep a slow, explicit repair scanner only for startup recovery or external-file edits, and run it under an idle budget.
- On mobile and desktop alike, never rebuild Yjs state from full Markdown content while the user is typing.

### 3. Uploading Yjs changes does too much local reconciliation

Hot path:

- `plugin/src/sync/SyncClient.ts:852` reads a claimed outbox segment.
- `plugin/src/sync/SyncClient.ts:873` extracts Yjs paths.
- `plugin/src/sync/SyncClient.ts:894` repeatedly filters rows per path.
- `plugin/src/sync/SyncClient.ts:896` resolves or loads Y.Doc state.
- `plugin/src/sync/SyncClient.ts:908` sends `DocSync`.
- `plugin/src/sync/SyncClient.ts:925` through `935` applies catch-up and builds a new upload by creating/checking Yjs docs.
- `shared/yjsUpload.ts:32` through `65` can create multiple full Yjs document states.

The client is doing a mini sync protocol before uploading every segment. That is work the server should own.

Recommended change:

- The client should send local Yjs updates with `(path, docGeneration, baseStateVector or baseRevision, update)`.
- The server should apply them to the canonical Yjs state and materialized text in one transaction.
- Only use DocSync/rebase when the client is missing a known server base or crosses a squashed generation.
- For normal typing, upload should be append-only and one-way: local WAL update -> server apply -> ack revision.

### 4. JSON/base64 protocol is too expensive

Hot paths:

- `shared/protocol.ts:38` converts `Uint8Array` to a binary string and then `btoa`.
- `shared/protocol.ts:48` decodes base64 through `atob` plus a char loop.
- `shared/protocol.ts:152` uses JSON for every WebSocket packet.
- `shared/protocol.ts:256` encodes update batches as JSONL.
- `plugin/src/db/db.ts:101` stores outbox binary fields as base64 strings.

Base64 inflates payloads by about 33%, creates large temporary strings, and increases GC pressure. It is especially bad for `SnapshotReset`, `ChangeBatch`, bootstrap manifests, and batches containing many small updates.

Recommended change:

- Replace WebSocket JSON packets with binary frames.
- Use a simple frame format:
  - magic/version byte
  - message type
  - varint revision/field lengths
  - UTF-8 path strings
  - raw binary payload slices
- Keep JSON only for tiny control messages if desired.
- Replace JSONL outbox rows with a binary WAL format. If you want readable debugging, add a separate debug dumper instead of making the storage format expensive.

### 5. Startup and bootstrap scan too much

Hot paths:

- `plugin/src/sync/SyncClient.ts:563` reads full vault snapshots.
- `plugin/src/sync/SyncClient.ts:665` lists all loaded files, then recursively lists adapter root and config dir.
- `plugin/src/sync/BootstrapUploader.ts:86` does the same for authoritative bootstrap.
- `plugin/src/main.ts:117` starts boot config hashing.
- `plugin/src/main.ts:515` recursively reads and hashes config files.
- `plugin/src/main.ts:318` starts recurring config-dir polling.

A mobile client should not need to scan the whole vault during normal startup. It should load a small local manifest and ask the server for changes since the last revision.

Recommended change:

- Maintain a local inventory: path, kind, size, mtime, content hash if known, server revision, local dirty flag.
- Startup should read only:
  - plugin settings
  - inventory
  - unsent WAL segments
  - open files as Obsidian opens them
- Full scans should be explicit repair operations or throttled idle audits, not startup behavior.
- Do not sync the whole `.obsidian` directory by default. It is not part of the minimum feature set and is a large source of mobile churn. If config sync stays, make it an allowlist of a few small files.

### 6. Server pull/push batches are unbounded

Hot paths:

- `server/src/sync/engine.ts:259` returns all events after a revision.
- `server/src/sync/engine.ts:232` returns a full snapshot in one packet.
- `server/src/index.ts:496` pushes `handlePull()` output to every connected client.

One stale client can receive a giant JSON/base64 packet. A live push can become a full snapshot. That is bad for mobile parsing and bad for server latency.

Recommended change:

- Add byte and row limits to `changeBatchPacket`.
- Return `hasMore` / `nextCursor` so clients page.
- Never send a full snapshot as an unsolicited live push. Send a small `ServerAdvanced` notification and let the client pull in bounded pages.
- Make snapshot reset a paginated manifest plus lazy content fetches.

### 7. Yjs event compaction does not bound Yjs document growth

Current server compaction:

- `server/src/sync/engine.ts:797` selects paths with many Yjs events.
- `server/src/sync/engine.ts:819` flushes materialized file state.
- `server/src/sync/engine.ts:821` through `834` marks/deletes Yjs events.

This bounds `sync_events`, but it does not necessarily bound `files.yjs_state`. Yjs state can grow with edit history and deletes. Long-lived notes can become expensive even if event rows are compacted.

Recommended change:

- Track `yjs_state` byte size per file.
- Add a server-side squash when state exceeds a threshold, for example `max(256 KiB, 4x current text bytes)`.
- Squash means: materialize current text, create a fresh Yjs doc from that text, increment `doc_generation`, and emit a `DocSquash` revision.
- Clients with no local edits replace state immediately.
- Clients with local edits rebase their current text over the new generation using a text merge path.

This requires a generation-aware protocol, but it is the clean way to keep old notes fast forever.

### 8. Blob upload commits data before the metadata mutation

Hot paths:

- `plugin/src/sync/SyncClient.ts:247` uploads blob bytes before the outbox mutation is accepted.
- `server/src/sync/engine.ts:615` writes blob bytes directly into `files`.
- `server/src/sync/engine.ts:635` uses the current server revision instead of creating a new event.
- Later, `applyMutation()` for `storageKind = 'lo'` relies on the already-written `content_oid`.

That is not just a reliability smell; it also makes the server state harder to reason about and can create extra snapshot work.

Recommended change:

- Upload blobs into a staging/content-addressed object table keyed by SHA-256.
- Do not modify `files` during preupload.
- The outbox mutation commits metadata and links the staged object in the same transaction that creates the sync revision.
- Garbage collect unreferenced staged blobs.
- Use chunked/resumable uploads for large files.

### 9. Bootstrap zip generation is memory-heavy

Hot paths:

- `server/src/bootstrap.ts:137` lists all zip entries.
- `server/src/bootstrap.ts:149` reads each file into memory.
- `server/src/bootstrap.ts:140` and `141` accumulate all local and central parts.
- `server/src/bootstrap.ts:184` through `197` concatenates the whole zip before writing.

This is server-side, so it is less urgent for mobile typing, but it will hurt large vault bootstrap.

Recommended change:

- Stream zip creation to disk.
- Avoid holding all file bytes and zip records in arrays.
- Prefer a proven streaming zip library or a small streaming writer.

### 10. Reconnect resets too much state

Hot path:

- `plugin/src/sync/SyncClient.ts:1358` sets `startupSynced = false` on socket close.

After transient network failure, the client falls back into startup sync behavior. It should reconnect, authenticate, and pull from the last known revision without reopening the entire startup state machine.

Recommended change:

- Split `hasCompletedInitialSync` from `socketConnected`.
- Socket close should mark transport disconnected, not invalidate initial sync.
- Reconnect should run bounded catch-up from `lastPulledRevision`.

## Recommended Target Architecture

### Core Principle

The mobile client should be an append-only local editor plus a small cache. The server should be the canonical sync engine.

The client should never need to scan the vault, rebuild all Markdown CRDTs, or reconcile full document state during ordinary typing.

### Client Storage

Replace scattered per-file state files and JSONL segments with:

- `client.meta`: client id, key, last applied server revision, protocol version.
- `inventory`: path -> kind, local hash, server revision, dirty flag, blob metadata, doc generation.
- `wal`: append-only binary local operations.
- `checkpoints`: optional per-doc Yjs state checkpoints, written only on idle/close/ack.

Rules:

- Every user edit is durable when its WAL record is appended.
- Network ack advances an ack pointer; only then can WAL records be truncated.
- Full state checkpoints are performance caches, not the source of truth.
- If a checkpoint is missing/corrupt, replay WAL or fetch from server.

### Markdown Sync

Normal synced case:

1. Opening a Markdown file loads the cached Yjs checkpoint for that file.
2. If missing, request current doc state from the server.
3. Local edits update the open Y.Doc and append raw Yjs update records to WAL.
4. Upload sends raw update records in bounded batches.
5. Server applies updates to canonical Yjs state and materialized Markdown text.
6. Server acks a global revision.
7. Client checkpoints state later, outside the typing hot path.

Stale/offline edge case:

1. WAL records include `docGeneration` and `baseContentHash`.
2. If server generation still matches, apply Yjs update normally.
3. If server has squashed or the client edited from raw text without a known Yjs base, client sends `RebaseText(path, baseHash, localText, localOpsMetadata)`.
4. Server computes a text merge against current materialized content, creates the resulting Yjs update, commits it, and returns the new generation/state vector.

This keeps Google Docs style behavior for active docs while giving the system a safe fallback for old/offline clients.

### Non-Markdown Files And Blobs

Use whole-file semantics for non-Markdown:

- Small files: inline only up to a lower threshold, such as `8-16 KiB`.
- Larger files: content-addressed staged blobs.
- Very large files: chunked resumable upload with `(sha256, chunkIndex, totalChunks)`.
- Metadata commit is a normal sync mutation with path, hash, byte size, and blob id.

Conflict policy:

- Last committed revision wins for binary content.
- If a local binary edit conflicts with a remote binary edit while offline, preserve both by writing one side to a conflict copy rather than overwriting silently.

### Server Data Model

Keep Postgres for metadata and revisions, but make the revision log bounded and explicit:

- `files(path primary key, kind, deleted, revision, content_text, yjs_state, doc_generation, content_hash, blob_id, byte_size)`
- `sync_events(revision, client_id, op_id, path, op_type, payload_ref, doc_generation, compacted)`
- `client_acks(client_id, last_applied_revision)`
- `objects(sha256 primary key, byte_size, storage_path or oid, ref_count, created_at)`
- `staged_objects(client_id, sha256, expires_at)`

Server responsibilities:

- Apply Yjs updates.
- Materialize Markdown text.
- Merge stale/offline text edits.
- Compact event logs after all active clients ack.
- Squash oversized Yjs states into new generations.
- Page all pulls by bytes and rows.

### Wire Protocol

Replace JSON/base64 with binary frames.

Minimum useful message types:

- `Auth`
- `Pull { sinceRevision, maxBytes, maxRows }`
- `PullPage { fromRevision, toRevision, hasMore, changes[] }`
- `PushOps { clientBatchId, ops[] }`
- `PushAck { clientBatchId, revision }`
- `ServerAdvanced { revision }`
- `DocStateRequest { path, knownGeneration }`
- `DocStateResponse { path, generation, stateVector, yjsState or text }`
- `BlobCommit`
- `BlobNeeded`

Keep every response bounded. The server should never send an unbounded snapshot over the live WebSocket.

## Implementation Plan

### Phase 0: Add Performance Observability

Add counters/timers before refactoring:

- Time spent in editor update handler.
- Bytes appended to outbox/WAL.
- Yjs update bytes and full-state checkpoint bytes.
- Count and duration of vault adapter reads/writes.
- Startup time split by settings, inventory, outbox recovery, server catch-up.
- Pull/push packet bytes before and after encoding.
- Number of files scanned and bytes hashed.

Add a mobile budget:

- Editor update handler: target under `2 ms`, hard max under `8 ms`.
- No full-vault scan during normal startup.
- No full Yjs checkpoint on every edit.
- No WebSocket message over `128 KiB` except explicit blob/bootstrap transfer.

### Phase 1: Quick Wins In Current Architecture

These should happen before the larger rewrite.

1. Stop reindexing Markdown on every modify event.
   - Change `plugin/src/main.ts:170` through `173`.
   - Only call `VaultYjsIndexer.ensureFile()` for external/unopened Markdown files.
   - Update content hash from DocSync checkpoints.

2. Debounce Yjs state persistence.
   - Change `plugin/src/yjs/DocSync.ts:136`.
   - Persist outbox immediately, but checkpoint full state on idle/close/ack.
   - Add crash recovery by replaying unacked local Yjs updates over the last checkpoint.

3. Increase upload debounce and stop spin-draining.
   - `FLUSH_DELAY_MS = 25` in `plugin/src/sync/SyncClient.ts:20` is too aggressive.
   - Use `100-250 ms` batching for typing.
   - Remove the `IDLE_EMPTY_SEGMENTS` loop that sleeps `25 ms` forty times.

4. Do not seal a segment on every drain.
   - `claimNextSegment(true)` seals active rows immediately.
   - Seal by size, age, or explicit flush, so fast typing becomes one segment.

5. Disable broad config sync.
   - Remove boot hash scan unless config sync is explicitly enabled.
   - Replace recursive `.obsidian` polling with an allowlist.

6. Add server pull limits.
   - Limit `changeBatchPacket()` by row count and encoded byte estimate.
   - Return a cursor/hasMore.
   - Make live push send only `ServerAdvanced`.

7. Lower inline binary threshold.
   - `64 KiB` inline binary becomes expensive after base64.
   - Use blobs for anything over `8-16 KiB`.

8. Keep initial sync state across reconnect.
   - Split startup completion from socket state.
   - Do not set startup complete false just because a socket closed.

Expected result: much less typing jank without changing the whole product model.

### Phase 2: Replace JSONL/Base64 With Binary WAL And Binary WS

Build a new local storage module:

- Append-only binary WAL with fixed header and checksums.
- Segment index with acked/unacked offsets.
- Binary encoder/decoder shared by plugin and server.

Migration:

- On startup, read old JSONL outbox if present.
- Convert to WAL.
- Keep old reader for one release.

Server:

- Accept both protocol versions temporarily.
- Add bounded binary pull pages.

Expected result: large reduction in allocation, parsing time, and network payload size.

### Phase 3: Server-Authoritative Markdown Pipeline

Remove per-upload DocSync handshake from the normal path.

Client:

- Append raw Yjs updates to WAL.
- Upload updates with generation/base metadata.
- Checkpoint state after ack/idle.

Server:

- Apply Yjs update to canonical state.
- Store materialized Markdown text.
- Return ack revision.
- Emit bounded change pages to other clients.

Fallback:

- Add `RebaseText` for stale-generation or raw-text local edits.
- Preserve conflict copies if automatic merge is unsafe.

Expected result: typing and reconnect become cheap on the client. Server does the heavy reconciliation.

### Phase 4: Blob And Bootstrap Redesign

Blob pipeline:

- Preupload to staged content-addressed objects.
- Commit staged object in the sync mutation transaction.
- Add chunked resumable upload/download.
- Garbage collect unused staged objects.

Bootstrap:

- Generate zip streams instead of building whole zip in memory.
- Prefer bootstrap for new mobile devices so they do not perform authoritative full-vault upload.
- Include inventory, last revision, and Yjs checkpoints in bootstrap.

Expected result: large vaults stop causing memory spikes, and mobile onboarding becomes download/apply instead of scan/upload.

## Recommended End State

The best long-term design is not "current architecture with smaller constants." It is:

- Client as durable local WAL + small cache.
- Server as canonical materializer, merger, compactor, and blob coordinator.
- Bounded binary protocol.
- No broad `.obsidian` sync by default.
- Lazy document state loading.
- Full scans only as explicit repair/audit operations.
- Yjs generations to allow server-side state squashing forever.

This keeps one code path for desktop and mobile. Desktop simply benefits from the same lower work, lower allocation, and stronger recovery model.

## Concrete Work Items For An Implementation Agent

Start with these PR-sized tasks:

1. Add perf counters around editor updates, outbox writes, Yjs checkpoint writes, pull/push encode/decode, and config scans.
2. Change `DocSync.applyChanges()` so `db.putInOutbox(row)` remains immediate but full-state persistence is debounced.
3. Update DocSync checkpointing to write content hash alongside state.
4. Stop calling `VaultYjsIndexer.ensureFile()` from normal Markdown modify events when the file has an open DocSync.
5. Replace config-dir sync with an allowlist or disable it by default.
6. Change outbox draining to batch for `100-250 ms` and avoid sealing active rows on every drain.
7. Add server-side pull pagination and make live push a revision notification.
8. Add a staged blob table and stop `PUT /v1/blobs/:path` from mutating `files` directly.
9. Prototype binary protocol for `PushOps` and `PullPage`.
10. Add Yjs state size tracking and a `DocSquash` design doc before implementing squashing.

Do those in order. The first seven should materially improve mobile without requiring the full generation-aware rewrite. The later items are what make the system scale cleanly and stay fast after months of real use.
