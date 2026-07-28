# Sync server

Bun + Hono + PostgreSQL. HTTP polling MVP; WebSocket module is present but not registered.

## Run

```sh
# from repo root — start Postgres
./db_setup.sh

cd shared/protocol && npm ci
cd ../../server && bun install
export DATABASE_URL=postgres://postgres:postgres@localhost:5433/dev_db
export BOOTSTRAP_TOKEN='long-random-secret'
bun run dev
```

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `BOOTSTRAP_TOKEN` | Required for `GET /bootstrap.zip` |
| `OBJECT_STORE_DIR` | Legacy on-disk store used only to backfill NULL BYTEA rows on upgrade |
| `PORT` / `HOST` | Listen address (default `3000` / `0.0.0.0`) |

Prefer `Authorization: Bearer $BOOTSTRAP_TOKEN` over `?token=` (query strings often land in access logs).

## Test

```sh
export DATABASE_URL=postgres://postgres:postgres@localhost:5434/test_db
export OBJECT_STORE_DIR=/tmp/object-store
bun test
```
