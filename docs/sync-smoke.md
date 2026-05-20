# Sync Smoke Test

Use this before shipping sync changes to verify the product path, not just the protocol.

## Setup

1. Start the sync server with a clean test database.
2. Open the same vault on desktop and phone, using the same backend URL.
3. Confirm both clients show the same last pulled revision before editing.

## Live Edit

1. On desktop, open `notes/smoke.md`.
2. Type a short sentence and stop typing.
3. Confirm the phone shows the same text within 2 seconds.
4. On phone, append a second sentence.
5. Confirm desktop shows both sentences within 2 seconds.

## Resume

1. Background the phone app for 30 seconds.
2. Edit `notes/smoke.md` on desktop.
3. Resume the phone app.
4. Confirm the phone catches up within 3 seconds without toggling settings.

## Conflict Path

1. Put both clients in the same note.
2. Type different short suffixes on both clients within the same 2-second window.
3. Confirm both clients converge to the same note content.
4. Confirm the server revision and both clients' last pulled revision stop advancing only after the content matches.

## Config Path

1. Change a visible Obsidian setting on desktop.
2. Confirm the phone receives the corresponding `.obsidian` file change.
3. Restart both clients and confirm the setting does not revert or loop as a new local edit.

## Failure Checks

The smoke fails if any of these happen:

- A settings toggle is required to unstick sync.
- Last pulled revision advances while note content stays stale.
- The phone misses edits after resume.
- Either client rewrites `.obsidian/plugins/<plugin-id>/data.json`, `yjs-state`, or `outbox` from the other device.
- A later edit overwrites a remote Yjs merge that was visible on the other device.
