# Obsidian Sync Engine

Self-hosted sync for Obsidian vaults. MVP transport is **HTTP polling**. WebSocket
code is retained under `*/websockets/` for a later live-push iteration and is
not registered on the server entrypoint yet.

## What syncs

- Vault notes and attachments (create, modify, rename, delete)
- Plugin bookkeeping files (`outbox.jsonl`, `inbox.jsonl`, `data.json`) are excluded

## What does not sync (MVP)

- `.obsidian` config / other plugin settings (deferred; incomplete and privacy-sensitive)
- Live WebSocket push (deferred)

## Limits

- Max upload body: **10 MiB** (server `maxRequestBodySize`)
- Oversized or permanently rejected files are **dead-lettered** so they do not block other paths
- Paths must be vault-relative and canonical (no `..`, absolute paths, or backslashes)

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
cd ../../server && bun install
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/dev_db
export BOOTSTRAP_TOKEN='generate-a-long-random-secret'
bun run dev
```

`BOOTSTRAP_TOKEN` is **required** for `GET /bootstrap.zip`. Without it the route returns 503; with a wrong token, 401.

### Plugin

```sh
cd plugin && npm ci && npm run build
```

Copy `main.js`, `manifest.json` (and `styles.css` if present) into
`<Vault>/.obsidian/plugins/obsidian-sync-engine/`.

1. Set **Server URL** and **Client name**
2. **Pair now** (first client on an empty server receives a secret)
3. **Seed server** once to upload the vault
4. Second devices: download `/bootstrap.zip` with `Authorization: Bearer $BOOTSTRAP_TOKEN`, unzip as a vault, then open Obsidian

## Privacy

- The sync server stores vault file bytes and paths in PostgreSQL
- Client secrets authenticate every file/inbox request; treat them like passwords
- Bootstrap zips mint a new client credential — protect `BOOTSTRAP_TOKEN`

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
