# Sync server

Bun + Hono + PostgreSQL. HTTP polling MVP; WebSocket module is present but not registered.

## Run

```sh
# from repo root — start Postgres
./db_setup.sh

cd shared/protocol && npm ci
cd ../../plugin && npm ci && npm run build
cd ../server && bun install
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/dev_db
bun run dev
```

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `PLUGIN_DIST_DIR` | Optional directory containing built `main.js`, `manifest.json`, and `styles.css` |
| `OBJECT_STORE_DIR` | Legacy on-disk store used only to backfill NULL BYTEA rows on upgrade |
| `PORT` / `HOST` | Listen address (default `3000` / `0.0.0.0`) |

An empty server enrolls its first client automatically. Authenticated clients
can create a client-package link with `POST /client-invites`. The
unauthenticated landing page is preview-safe; its ZIP download is single-use
and expires after five minutes.

## Test

```sh
export DATABASE_URL=postgres://postgres:postgres@localhost:5434/test_db
export OBJECT_STORE_DIR=/tmp/object-store
bun test
```
