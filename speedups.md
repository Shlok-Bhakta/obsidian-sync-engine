# Sync Latency Speedups

Current gut-feel latency is about 290-400 ms from typing on one client to visible text on another. The code path supports that estimate: a keystroke currently goes through durable local outbox IO, a fixed upload delay, a pre-upload DocSync round trip, a database commit, a database-derived push, JSON/base64 encoding, and then remote editor/file/state writes.

The target should be two separate guarantees:

- **Live visibility:** open markdown edits should render on another online, subscribed client in roughly one network one-way plus local apply time. Same-region target: p50 under 60 ms, p95 under 120 ms.
- **Durability:** the existing revision/outbox system should keep doing offline replay, snapshots, conflict recovery, and bootstrap. Durable ack can be slower than live visibility.

The high-level architectural move is to split the typing path into a **live ephemeral lane** and a **durable persistence lane**. The live lane should never wait for disk, DocSync, Postgres materialization, compaction, or revision persistence.

## Current Hot Path

For a markdown edit in an open editor:

1. CodeMirror change enters `queueEditorChange`, which serializes per path and awaits `handleEditorChange` before the next edit for that path proceeds (`plugin/src/main.ts:220`).
2. `handleEditorChange` calls `DocSync.applyChanges`, waits for the outbox write, then calls `syncClient.wakeSoon()` (`plugin/src/main.ts:237`).
3. `DocSync.applyChanges` applies the CodeMirror changes into Yjs, computes the update, and awaits `db.putInOutbox(row)` (`plugin/src/yjs/DocSync.ts:143`, `plugin/src/yjs/DocSync.ts:169`).
4. `JsonlOutboxStore.putInOutbox` base64-encodes the update and appends JSONL to the vault adapter (`plugin/src/db/db.ts:97`).
5. `wakeSoon()` waits `FLUSH_DELAY_MS = 150` before draining (`plugin/src/sync/SyncClient.ts:20`, `plugin/src/sync/SyncClient.ts:301`).
6. Draining seals the active JSONL segment by renaming `active.jsonl`, writing a new one, and writing metadata (`plugin/src/db/db.ts:332`).
7. `prepareSegmentJsonl` does a DocSync request before upload for any Yjs path (`plugin/src/sync/SyncClient.ts:876`, `plugin/src/sync/SyncClient.ts:911`).
8. Only after DocSync returns does the client send `UpdateBatch` and wait for `BatchAck` (`plugin/src/sync/SyncClient.ts:520`).
9. The server decodes JSONL, commits mutations, materializes Yjs state/content, then runs compaction after every accepted batch (`server/src/index.ts:703`, `server/src/sync/engine.ts:769`, `server/src/sync/engine.ts:783`).
10. The server pushes to peers by querying `changeBatchPacket(fromRevision)` for each target, not by forwarding the just-accepted mutation (`server/src/index.ts:497`, `server/src/index.ts:506`).
11. `changeBatchPacket` joins `sync_events` to `files` and includes full `files.yjs_state` for every YjsUpdate (`server/src/sync/engine.ts:260`, `server/src/sync/engine.ts:275`).
12. The receiver prefers `applyState` over `applyUpdate` when `yjsState` exists (`plugin/src/sync/SyncClient.ts:824`). That means normal live pushes usually apply a full document state, not the tiny update.

## P0: Add A Live Yjs Relay Lane

This is the main architectural speedup. Send each local Yjs update over the already-authenticated WebSocket immediately, before the durable outbox path finishes.

Proposed packet shape:

```ts
type LiveYjsUpdate = {
  type: "LiveYjsUpdate";
  path: string;
  mutationId: string;
  data: Uint8Array;
  created: number;
  senderSeq: number;
};
```

Server behavior:

- Validate auth and path policy.
- Relay the update directly to other online clients subscribed to that path.
- Do not allocate a revision and do not query Postgres for the live relay.
- Optionally enqueue a server-side best-effort metric event, but never block relay on metrics.
- Keep the existing `UpdateBatch` durable path as the source of truth.

Client sender behavior:

- In `DocSync.applyChanges`, after `row.data` is created, hand it to `SyncClient.sendLiveYjsUpdate(row)` immediately.
- Still append to outbox for durability. The durable append can happen in parallel or immediately after the live send.
- Keep a small bounded in-flight map by `(path, mutationId)` so durable ack can clear live bookkeeping.

Client receiver behavior:

- Apply `LiveYjsUpdate` to an open `DocSync` immediately.
- Dispatch the visible editor update before writing state snapshots or content hashes.
- Track a small LRU of recently applied live `(clientId, mutationId)` values. When the durable `ChangeBatch` arrives later, skip the duplicate CPU path. Yjs update idempotence helps, but explicit duplicate skipping avoids unnecessary full apply/diff work.

Correctness constraints:

- Live updates must not advance `lastPulledRevision`.
- If a client is not startup-synced or not subscribed to the path, skip live relay and let durable catch-up handle it.
- If a live update references missing Yjs structs, Yjs can hold pending structs, but the client should trigger durable catch-up if the update does not render quickly.
- Server fanout should be bounded by subscriptions, not all authenticated sockets.

Expected impact: removes local durable IO, the 150 ms flush delay, DocSync RTT, DB commit, DB readback, and compaction from the visible typing path.

## P0: Stop Sending Full Yjs State For Normal Change Batches

`changeBatchPacket` currently attaches `files.yjs_state` to every YjsUpdate (`server/src/sync/engine.ts:275`). The receiver then chooses `applyState` over `applyUpdate` (`plugin/src/sync/SyncClient.ts:824`). For a one-character edit, this can turn a tiny Yjs update into a full-document transfer and full-state apply.

Change this behavior:

- For uncompacted `YjsUpdate` rows, send only `payload` as `data`.
- Reserve `yjsState` for snapshots, initial upload metadata, DocSync responses, and any future explicit materialized-state packet.
- Update tests that currently assert a Yjs state inside normal `ChangeBatch` events.
- Keep `SnapshotReset` unchanged because it is intentionally materialized.

Expected impact: much smaller WebSocket frames, less JSON/base64 work, less remote Yjs CPU, and less main-thread editor diffing. This is likely the fastest low-risk server/client change before the full live lane exists.

## P0: Remove The Steady-State DocSync RTT

`prepareSegmentJsonl` requests DocSync before every segment containing Yjs changes (`plugin/src/sync/SyncClient.ts:911`). That adds a full round trip before the actual upload.

DocSync is useful when the local Yjs state may have been seeded from plain text or is stale. It should not be on the steady-state typing path after a document is known to be caught up.

Proposed state model:

- Track per-path `serverStateVectorKnown` or `baseRevision` in `DocSync`/`YjsStateStore`.
- Run DocSync on first open, after reconnect, after snapshot reset, or when the server rejects an update as stale/oversized.
- For normal edits after startup catch-up, upload the incremental `row.data` already produced by `DocSync.applyChanges`.
- If a direct upload produces a semantic mismatch, fall back to the current `buildUploadFromSyncedDoc` path once, refresh the local state vector, then return to fast mode.

Expected impact: removes one full network RTT and several Y.Doc encode/decode operations from each durable upload.

## P0: Split Typing Flush From File Flush

The global `FLUSH_DELAY_MS = 150` is a direct floor on durable typing latency (`plugin/src/sync/SyncClient.ts:20`). It probably helps file coalescing, but it is too expensive for keystrokes.

Use separate policies:

- Markdown/Yjs live lane: send immediately, coalescing at most one animation frame.
- Markdown/Yjs durable lane: drain after 0-16 ms if the socket is idle, then let outbox segment coalescing happen by rows/bytes rather than a fixed timer.
- Non-markdown file upserts: keep the current 500 ms debounce (`plugin/src/main.ts:519`) because those are disk/file-write events, not interactive typing.
- Large blobs: keep the existing blob upload path outside the live lane.

If the live lane is implemented first, durable flush can remain somewhat relaxed because remote visibility no longer depends on it.

## P0: Move Compaction Off The Ack Path

`acceptMutations` runs `compactYjsEvents()` after every accepted batch and before returning the revision (`server/src/sync/engine.ts:783`). `compactYjsEvents` scans un-compacted Yjs events grouped by path (`server/src/sync/engine.ts:830`). This should not sit on the upload ack path, and it definitely should not sit near the live visibility path.

Recommended changes:

- Return the batch revision immediately after the transaction.
- Schedule compaction on a background timer, queue, or low-priority task.
- Add a partial index for the compaction scan:

```sql
CREATE INDEX IF NOT EXISTS sync_events_yjs_uncompacted_path_revision_idx
  ON sync_events(path, revision)
  WHERE operation = 'YjsUpdate' AND compacted = FALSE;
```

- Keep the compaction threshold, but add a per-path cooldown so a hot document does not repeatedly scan during typing bursts.

Expected impact: reduces upload ack tail latency and prevents hot typing from paying maintenance work.

## P1: Push Accepted Mutations Directly

After commit, the server currently calls `changeBatchPacket(fromRevision)` per target client (`server/src/index.ts:497`). That re-reads from Postgres and serializes a full durable batch even when the server just accepted the mutation.

For online peers that are current enough:

- Build a `ChangeBatch` or live packet from the accepted mutation(s) in memory.
- Reuse the same encoded frame for all subscribers at the same revision.
- Only fall back to `changeBatchPacket` when a target is behind, missed updates, or needs historical catch-up.

This is less important once the live lane exists, but it still improves durable push latency and server load.

## P1: Use Path Subscriptions

The server currently iterates all authenticated clients for pushes (`server/src/index.ts:497`). For live typing, the fanout set should be clients that have the path open, or at least clients that opted into live updates for that path.

Add packets:

```ts
type SubscribePaths = { type: "SubscribePaths"; paths: string[] };
type UnsubscribePaths = { type: "UnsubscribePaths"; paths: string[] };
```

Client:

- Subscribe when a markdown view opens or becomes active.
- Unsubscribe when the last view for a path closes.
- Keep durable catch-up global, since file changes still need to sync eventually.

Server:

- Maintain `Map<path, Set<Client>>`.
- Relay live updates only to the subscribed set.
- On disconnect, remove all subscriptions for that client.

Memory guard: path subscription sets are tiny compared to document states and should be cleaned on close/disconnect.

## P1: Switch Hot Packets Away From JSON/Base64

`encodePacket` JSON-stringifies every packet and base64-encodes binary data (`shared/protocol.ts:38`, `shared/protocol.ts:152`). `decodePacket` parses JSON, decodes base64, and validates (`shared/protocol.ts:195`). This is tolerable for cold paths, but it is unnecessary work for keystroke updates.

Use a binary WebSocket frame for hot Yjs packets:

- Keep JSON packets for auth, bootstrap, settings, snapshots, and compatibility.
- Add binary framing for `LiveYjsUpdate` and optionally durable `UpdateBatch`.
- A minimal frame can be: version byte, packet kind byte, varint path length, UTF-8 path, 16-byte mutation/sequence id or varint string, then raw Yjs update bytes.
- Avoid base64 expansion and intermediate binary strings.

Expected impact: lower main-thread encode/decode CPU and smaller network payloads. This matters more after full `yjsState` stops being sent.

## P1: Apply Remote Updates As Deltas In Open Editors

Open-editor remote apply currently converts the editor doc to a full string, computes a custom changed range against full remote content, then dispatches that range (`plugin/src/main.ts:468`). For large notes, this is main-thread work on every remote update.

Better open-doc path:

- Apply the Yjs update to the open `Y.Doc`.
- Observe the Y.Text transaction delta and convert that delta directly into a CodeMirror transaction.
- Avoid `editorView.state.doc.toString()` and full-document `changedRange` for normal remote Yjs updates.
- Keep the full-string repair path for mismatch recovery only.

Also reduce sender-side full-string checks:

- `DocSync.applyChanges` currently receives `update.startState.doc.toString()` and `update.state.doc.toString()` on every edit (`plugin/src/main.ts:249`) and compares them with `this.ytext.toJSON()` (`plugin/src/yjs/DocSync.ts:130`, `plugin/src/yjs/DocSync.ts:152`).
- Make these checks debug-only, periodic, or mismatch-triggered. The hot path already has the CodeMirror `ChangeSet`, which should be the source of truth for the edit.

Expected impact: lower main-thread time on both sender and receiver, especially on long markdown files.

## P1: Keep Server-Side Hot Docs For Active Paths

The server materializes each Yjs update by creating a new `Y.Doc`, applying the current persisted state, applying the payload, extracting markdown, and encoding the full state (`server/src/yjs/apply.ts:10`). That is correct but expensive for hot documents.

Server compute is allowed, so spend it in a bounded hot cache:

- Keep an in-memory `Y.Doc` only for active subscribed paths.
- TTL idle docs quickly, for example 30-120 seconds.
- Bound by total estimated update/state bytes and evict LRU.
- Use the hot doc for live fanout and for faster durable materialization.
- Persist durable state through the existing `files` table path.

If server RAM needs to stay very low, use Yjs update APIs already available in the installed version (`mergeUpdatesV2`, `encodeStateVectorFromUpdateV2`, `diffUpdateV2`) to merge/diff binary updates without constructing a full `Y.Doc` for every operation.

Mobile impact: none if this cache only lives on the server.

## P1: Make Local Outbox Hot-Queue First, Disk Mirror Second

The current outbox is durable-first: each Yjs row is base64 JSONL appended to disk before sync wakes (`plugin/src/db/db.ts:97`). For live updates, use memory first and disk second:

- Add a small per-path hot queue of already-encoded Yjs updates.
- Live send reads from the hot queue immediately.
- Disk outbox append continues for crash/offline durability.
- Durable drain can claim from memory when possible and reconcile with JSONL segments.
- Bound memory by count and bytes, for example 256 updates or 512 KiB total per client, then force immediate disk-backed drain.

This keeps mobile RAM bounded and avoids storing full document snapshots.

## P2: Improve Non-Typing Sync Without Hurting Typing

Non-markdown file upserts are debounced for 500 ms and read the entire file before queueing (`plugin/src/main.ts:519`, `plugin/src/main.ts:584`). That is reasonable for files, but should not share typing policy.

Possible improvements:

- Keep file debounce separate from markdown.
- Hash/read binary files in idle chunks or a worker when available.
- For config sync, avoid repeated SHA reads when stat fingerprint has not changed.
- For large blobs, keep upload off the live lane and report progress separately.

## P2: Transport And Connection Details

WebSocket is fine for now because the app already keeps an authenticated socket open. Do not change transport before fixing architecture.

Consider later:

- Compression disabled for tiny live frames if it adds CPU or buffering.
- TCP_NODELAY if Bun/Hono exposes it for WebSockets.
- Regional server placement close to users.
- Sticky sessions if live relay remains in memory. If multiple server instances are needed, use Redis Pub/Sub, NATS, or another low-latency broker for the live lane.

## Instrumentation Needed Before And After

Add hop timestamps and durations so this stops being gut feel:

- `editorChangeAt`: when CodeMirror update is observed.
- `yjsEncodedAt`: after `row.data` exists.
- `liveSentAt`: before WebSocket send.
- `serverReceivedAt`: first line in server `onMessage`.
- `serverRelayedAt`: immediately before peer socket send.
- `peerReceivedAt`: first line in client socket message handler.
- `editorAppliedAt`: after CodeMirror dispatch returns.
- `durableAckAt`: when `BatchAck` arrives.

For clock-safe measurements:

- Use monotonic durations within each process for local spans.
- Include wall-clock timestamps only for approximate cross-machine views.
- Add a synthetic two-client benchmark that opens the same note, types N characters, and reports p50/p95/p99 visible latency.
- Extend `scripts/headless-perf.ts` for protocol encode/decode and Yjs apply payload sizes, but add an integration harness for real WebSocket hop timing.

## Suggested Rollout Order

1. **Measure:** add hop timing logs/metrics and a two-client benchmark.
2. **Quick payload win:** stop attaching `yjsState` to normal `ChangeBatch` YjsUpdate rows; update receiver/tests to exercise `applyUpdate`.
3. **Quick scheduling win:** split markdown flush from file flush; reduce durable markdown flush to 0-16 ms.
4. **Server ack win:** move compaction off the accept path and add the partial index.
5. **DocSync win:** skip steady-state DocSync when the local doc has a trusted server base.
6. **Live lane:** add `LiveYjsUpdate`, path subscriptions, duplicate suppression, and bounded in-flight memory.
7. **Main-thread win:** convert remote Yjs deltas directly into CodeMirror transactions.
8. **Protocol win:** binary hot packets for live updates.
9. **Server hot cache:** bounded active-path Y.Doc cache or binary update merge path.

## Expected End State

For online open markdown docs:

```text
sender CodeMirror change
  -> local Yjs update bytes
  -> immediate WebSocket live frame
  -> server auth/path check and direct relay
  -> peer applies Yjs update to open doc
  -> peer CodeMirror delta dispatch
```

Durability happens beside this:

```text
same Yjs update
  -> local outbox disk append
  -> coalesced durable UpdateBatch
  -> Postgres revision/materialized file state
  -> durable ChangeBatch/catch-up for offline or behind clients
```

That split is the core move. It spends server compute and a little bounded client compute to make user-visible typing independent from storage, compaction, history, and snapshot machinery.
