# FIXME: Sync Reliability Audit

This project has enough moving parts that small ordering bugs can look like random desync. The failures most likely to explain "revision jumped by hundreds after restart", duplicated note text, and clients reconnecting into stale state are below.

## P0: pending editor Yjs deltas can be ignored after restart

`plugin/src/sync/SyncClient.ts:903` prepares a pending outbox segment by resolving one Y.Doc per path from the open `DocSync` or from `.sync-engine-state`. In the DocSync path (`plugin/src/sync/SyncClient.ts:954` through `plugin/src/sync/SyncClient.ts:1028`), it never replays the `row.data` updates from the segment into the resolved Y.Doc before building the server upload.

That means this sequence can lose edits:

1. User types in an open markdown file.
2. `DocSync.applyChanges` writes a non-empty `YjsUpdate` row to the outbox (`plugin/src/yjs/DocSync.ts:199` and `plugin/src/yjs/DocSync.ts:251`).
3. The app restarts before the 2s Yjs checkpoint writes the new full state (`plugin/src/yjs/DocSync.ts:253` through `plugin/src/yjs/DocSync.ts:256`).
4. On restart, `prepareSegmentJsonl` sees the queued row but the open `DocSync` is gone. It loads stale state from disk and uploads that stale content.

Fix: when `prepareSegmentJsonl` sends a path through DocSync, apply every non-empty pending `row.data` for that path to the resolved Y.Doc before computing `stateVector`, `content`, and `target`. Yjs updates are idempotent, so this is safe if the checkpoint already contains them.

Required test: simulate a restart with a stale state-store checkpoint and a persisted non-empty Yjs outbox row. Assert that the prepared upload still contains the typed text.

## P0: remote writes to an already-open file can still echo as local edits

Remote editor dispatch suppression only covers `remoteEditorDispatches` (`plugin/src/main.ts:335` through `plugin/src/main.ts:354`). `YjsApplicator.upsertYjsTextFile` calls the open-editor callback only if `getDocSync(path)` exists (`plugin/src/sync/YjsApplicator.ts:114` through `plugin/src/sync/YjsApplicator.ts:119`).

An open markdown file does not get a `DocSync` until the user types (`plugin/src/main.ts:617` through `plugin/src/main.ts:670`). So if another client edits a file that is open locally but untouched locally, the remote apply can fall back to `vaultMutator.upsertTextFile`. If Obsidian/CodeMirror emits the editor update after the remote mutation guard has ended, the change can be queued as a new local edit and reflected back to peers.

Fix: route remote markdown content through the open-editor callback whenever an editor is open for the path, regardless of whether a `DocSync` exists. The remote editor dispatch guard should be the primary feedback-loop barrier.

Required test: open a markdown editor without creating `DocSync`, apply a remote Yjs state, simulate the CodeMirror update, and assert no outbox row is queued.

## P0: Pull responses and live pushes are indistinguishable

`pullSince` waits for the next `InitRequired`, `ChangeBatch`, or `SnapshotReset` packet (`plugin/src/sync/SyncClient.ts:1258` and `plugin/src/sync/SyncClient.ts:1425`). Live pushes use the same packet types and have no request id. The shared `waitForPacket` helper resolves on the first accepted packet (`plugin/src/sync/SocketRequest.ts:39` through `plugin/src/sync/SocketRequest.ts:63`).

During a pull, the global websocket listener drops `ChangeBatch`/`SnapshotReset` while `pendingPullResponses > 0` (`plugin/src/sync/SyncClient.ts:1297` through `plugin/src/sync/SyncClient.ts:1318`). If an unsolicited live push arrives before the actual pull response, the pull waiter can consume the live push as if it was the response. The real response can then be applied later as a live push, dropped, or reordered around uploads.

Fix: add request ids to `PullSince` and pull responses, or split live pushes into a distinct packet type that cannot satisfy `waitForPullResponse`.

Required test: start `pullSince`, deliver an unsolicited live `ChangeBatch` first, then deliver the actual pull response. Assert the pull resolves only with the correlated response and the live push is queued/applied separately.

## P1: open docs default to "not server-synced"

`DocSync` defaults `initialServerSyncedState` to false (`plugin/src/yjs/DocSync.ts:106` through `plugin/src/yjs/DocSync.ts:116`), and `SyncEngine.newDoc` never passes true even when the state came from a server snapshot or successful DocSync (`plugin/src/main.ts:657` through `plugin/src/main.ts:670`).

This pushes open docs down the slower, text-based rebase path instead of CRDT merge in `YjsApplicator.applyState` (`plugin/src/sync/YjsApplicator.ts:63` through `plugin/src/sync/YjsApplicator.ts:70`). That path is a heuristic and is exactly where duplicated prefixes/suffixes are likely to appear under concurrent edits.

Fix: persist metadata with Yjs state that says whether it is server-synced and at which server revision. Use it when constructing `DocSync`. If metadata is absent, force a DocSync before treating the open doc as a merge base.

Required test: open a server-synced file, make local edits, receive a remote Yjs state, and assert the CRDT merge path is used without duplicated base text.

## P1: bootstrap large blobs can bypass revision/event history

`acceptBootstrapSnapshot` pre-inserts large-object files with `revision = 0` (`server/src/sync/bootstrapUpload.ts:49` through `server/src/sync/bootstrapUpload.ts:111`) and then calls `applyMutation`. But `applyMutation` skips `storageKind: "lo"` mutations when there is no staged normal blob and no inline bytes (`server/src/sync/engine.ts:390` through `server/src/sync/engine.ts:420`).

So a bootstrap snapshot containing large files can materialize those files without a corresponding sync event or meaningful revision. Existing connected clients will not receive those files through `ChangeBatch`.

Fix: make bootstrap large-object mutations first-class `applyMutation` inputs, either by passing the bootstrap staged object into `applyMutation` or by inserting the sync event and file row in one bootstrap-specific code path.

Required test: finalize a bootstrap manifest with a large blob while another websocket client is connected. Assert the other client receives a revisioned file change and can download the blob.

## P1: revision jumps may be benign, but they hide missing assertions

`applyChangeBatch` advances `lastPulledRevision` to the max revision in the batch, even when some rows are echoed local changes skipped by `clientId` (`plugin/src/sync/SyncClient.ts:731` through `plugin/src/sync/SyncClient.ts:751`). After a stale settings write or reconnect, a client can legitimately jump hundreds of revisions with no visible local content change.

That is not automatically wrong, but tests should assert stronger invariants: after any revision advance, local content and local Yjs state must match the server materialized content for every path included in the pull/snapshot.

Required test: reconnect with 600 mostly-echoed revisions plus remote interleavings. Assert revision advances, echoed rows do not rewrite files, remote rows do apply, and final local content matches server.

## P2: markdown UpsertFile changes lose original Yjs state

`rowToChange` only attaches `yjsState` for `YjsUpdate` rows (`server/src/sync/engine.ts:248` through `server/src/sync/engine.ts:263`). The `changeBatchPacket` query joins the current materialized Yjs state (`server/src/sync/engine.ts:300` through `server/src/sync/engine.ts:317`), but the mapper intentionally drops it for markdown `UpsertFile`.

The client compensates by seeding a fresh Yjs state from the text when an `UpsertFile` has `isYjs` but no `yjsState`. That creates a different CRDT state for identical text and forces later DocSync/rebase logic to repair the lineage. This is survivable, but it increases the surface area for duplicated text if any of the repair paths are wrong.

Fix: include the event's markdown `yjsState` in sync events for `UpsertFile`, or include the current materialized `files.yjs_state` in `ServerChange` for `UpsertFile` rows where `isYjs = true`.

Required test: client B pulls a markdown file created by client A, edits it without any intervening remote YjsUpdate, uploads through DocSync, and both clients converge without text replacement fallback.

## P2: `mega-test.ts` is not a correctness harness

The current mega test is hardcoded to one local vault and one Obsidian process (`scripts/mega-test.ts:41` through `scripts/mega-test.ts:48`), resets `lastPulledRevision` and local state on the real vault (`scripts/mega-test.ts:401` through `scripts/mega-test.ts:427`), and measures one append through CDP/Obsidian CLI (`scripts/mega-test.ts:717` through `scripts/mega-test.ts:745`).

It can pass while clients are desynced because it mainly waits for plugin readiness, an append, and a revision/outbox condition. It does not run two independent vaults, does not assert byte-for-byte convergence, and does not cover restart-before-checkpoint or open-editor feedback loops.

Replace or supplement it with a headless correctness harness:

1. Create temp vault directories for client A/B/C.
2. Start a clean Postgres and real Bun server.
3. Instantiate the real `JsonlOutboxStore`, `YjsStateStore`, `SyncClient`, `VaultMutator`, and `YjsApplicator` against filesystem-backed Obsidian test doubles.
4. Use a small fake editor layer that can emit CodeMirror-like updates and observe remote dispatches.
5. Drive real websocket auth, pull, DocSync, blob upload/download, outbox drain, disconnect, reconnect, and restart.
6. Assert final server content, each vault file, each local `.sync-engine-state` file, and each `lastPulledRevision`.

Scenarios that must be covered:

- Restart with pending open-editor Yjs rows before checkpoint.
- Remote update to an open but locally untouched editor.
- Offline client makes 100 edits while online clients make 500 edits, then reconnects.
- Pull/live-push race while another client uploads.
- Snapshot reset while local files are missing from server.
- Bootstrap snapshot with large blobs.
- Config file remote apply followed by Obsidian rewriting old config on restart.

## Current Test Status

Commands run during this audit:

- `bun test shared`: pass, 24 tests.
- `bun run test:unit` in `server`: pass, 9 tests.
- `npm test` in `plugin`: pass, 98 tests.

The first attempted plugin command, `npm test -- --runInBand`, failed because Vitest does not support Jest's `--runInBand` flag. The normal plugin test script passes.
