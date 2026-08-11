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

The server logs startup, migrations, authentication outcomes, every HTTP
request, object-store/database operations, revisions, paths, byte counts, and
errors as structured JSON. Server logging is always enabled; credentials and
file contents are never logged.

The server imposes no practical per-file upload limit, so all vault files are
eligible to sync regardless of size.

## Environment

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `PLUGIN_DIST_DIR` | Optional directory containing built `main.js`, `manifest.json`, and `styles.css` |
| `PORT` / `HOST` | Listen address (default `3000` / `0.0.0.0`) |

An empty server enrolls its first client automatically. Authenticated clients
start a progress-reporting archive with `POST /client-invite-builds` and poll
`GET /client-invite-builds/:buildId` until the response is ready. The legacy
synchronous `POST /client-invites` endpoint remains available for older plugin
versions. The unauthenticated landing page is preview-safe; its ZIP download is
single-use and expires five minutes after the archive finishes building.

## Test

```sh
export DATABASE_URL=postgres://postgres:postgres@localhost:5434/test_db
bun test
```
