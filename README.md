# Obsidian Sync Engine

Self-hosted sync for Obsidian vaults. The MVP transport is **HTTP polling**.

## What syncs

- Vault notes, attachments, and `.obsidian` configuration
- This plugin's per-client `data.json` and durable sync journals stay local

## What does not sync (MVP)

- Live WebSocket push (deferred)

## Limits

- Files of any size are eligible for sync; the server imposes no practical per-file upload limit
- Permanently rejected files are **dead-lettered** so they do not block other paths
- Paths must be vault-relative and canonical (no `..`, absolute paths, or backslashes)

## Upgrading from the filesystem object store

Primary file bytes now live in Postgres (`BYTEA`). On startup the server copies
any still-missing bytes from `OBJECT_STORE_DIR` into NULL `content` rows **before
accepting requests**. Point `OBJECT_STORE_DIR` at your previous object-data
directory when upgrading an existing deployment, then restart once.

## Conflict / convergence policy

- Local edits are written to a durable outbox **immediately**, then drained over the network
- Pending local paths are not overwritten by inbound pulls
- Server revisions are assigned under a Postgres advisory lock with file bytes stored as `BYTEA` in the same transaction
- Deletes are idempotent (unknown paths become tombstones)

## Setup

### Database (Podman)

```sh
./db_setup.sh
# or: podman compose up -d
# dev:  postgres://postgres:postgres@localhost:5433/dev_db
# test: postgres://postgres:postgres@localhost:5434/test_db
```

### Server

```sh
cd shared/protocol && npm ci
cd ../../plugin && npm ci && npm run build
cd ../server && bun install
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/dev_db
bun run dev
```

### Plugin

```sh
cd plugin && npm ci && npm run build
```

For a one-shot development build with inline source maps and client logging
enabled, run:

```sh
cd plugin && npm run build:dev
```

Open **View → Toggle developer tools** in Obsidian to see logs prefixed with
`[obsidian-sync:client]`. Production client builds inject a no-op logger. The
server always emits structured JSON logs to stdout/stderr; logs include sync
paths and operational metadata but omit credentials and file contents.

For a vault seed, the useful client event sequence is:
`auto_seed.decision` → `vault_scan.completed` / `vault_scan.file_included` →
`seed.file` → `outbox:enqueue.appended` → `outbox.operation_pushed` →
`http.request.completed` → `tick.completed`. The server side then records
`upload.accepted` → `object_store:upload.started` →
`object_store:upload.completed`, including the committed database revision.
Skipped, deferred, rejected, corrupt, and retry paths emit an explicit
`reason` field.

Copy `main.js`, `manifest.json` (and `styles.css` if present) into
`<Vault>/.obsidian/plugins/obsidian-sync-engine/`.

1. Set **Server URL** and **Client name**. The first client to reach an empty server is enrolled automatically.
2. The first client automatically uploads its vault when its last synced revision is `0`.
3. Select **Create client package** for another device. The settings page copies a five-minute link.
4. Open the link, select **Download ZIP**, extract it as a vault, and open it in Obsidian.

The landing page can be previewed safely. Its download button works once; a
successful or interrupted download consumes the package.

## Privacy

- The sync server stores vault file bytes and paths in PostgreSQL
- Client secrets authenticate every file/inbox request; treat them like passwords
- Client-package links are temporary bearer credentials; send them only to the intended device

## Recovery

- Outbox/inbox live next to the plugin as JSONL; a corrupt JSONL tail is moved to `*.corrupt` and valid lines kept
- Permanent upload failures land in `dead-letter.jsonl`
- Sync status view shows the last tick error when a tick fails

## Tests / CI

```sh
cd plugin && bun test src/sync
DATABASE_URL=postgres://postgres:postgres@localhost:5434/test_db \
  OBJECT_STORE_DIR=/tmp/object-store \
  bun test --cwd server
```

GitHub Actions runs plugin unit tests, server unit tests (Postgres service), lint, and Obsidian e2e.
