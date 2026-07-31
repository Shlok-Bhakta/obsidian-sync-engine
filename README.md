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

## Conflict / convergence policy

- Local edits are written to a durable outbox **immediately**, then drained over the network
- Pending local paths are not overwritten by inbound pulls
- Server revisions are assigned under a Postgres advisory lock with file bytes stored as `BYTEA` in the same transaction
- Deletes are idempotent (unknown paths become tombstones)

## Deploy with Docker Compose

Save the following as `compose.yaml` on the server. It runs the sync server and
Postgres with persistent database storage; no `.env` file is required. The same
sample is available in [`compose.deploy.yaml`](compose.deploy.yaml).

```yaml
services:
  server:
    image: ghcr.io/shlok-bhakta/obsidian-sync-engine:latest
    pull_policy: always
    restart: unless-stopped
    depends_on:
      database:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://obsidian:obsidian-password@database:5432/obsidian
    ports:
      # Change 3000 on the left to use a different host port.
      - "3000:3000"
    healthcheck:
      test: ["CMD", "bun", "-e", "const response = await fetch('http://127.0.0.1:3000/health'); if (!response.ok) process.exit(1)"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s

  database:
    image: docker.io/library/postgres:18-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: obsidian
      POSTGRES_USER: obsidian
      POSTGRES_PASSWORD: obsidian-password
    volumes:
      # Change ./data/postgres to store database files somewhere else on the host.
      - ./data/postgres:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U obsidian -d obsidian"]
      interval: 5s
      timeout: 5s
      retries: 20
      start_period: 10s
```

Start it and confirm both services are healthy:

```sh
docker compose up -d
docker compose ps
curl --fail http://localhost:3000/health
```

Run `docker compose up -d` again to pull and deploy the newest released server
image. If port `3000` is reachable from the internet, put the service behind an
HTTPS reverse proxy before connecting a vault.

## Install the Obsidian plugin

Download `obsidian-sync-engine.zip` from the latest GitHub release and extract
it directly into the vault's plugin directory:

```sh
unzip obsidian-sync-engine.zip -d "<Vault>/.obsidian/plugins"
```

Reload Obsidian, enable **Obsidian Sync Engine** under **Settings → Community
plugins**, then set **Server URL** to the deployed server (for example,
`https://sync.example.com`).

## Development setup

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

### Plugin development

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
`<Vault>/.obsidian/plugins/obsidian-sync-engine/` for a local development install.

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
  bun test --cwd server
```

GitHub Actions runs plugin unit tests, server unit tests (Postgres service), lint, and Obsidian e2e.

Pushing a tag that exactly matches `plugin/manifest.json` publishes the plugin
files and installable ZIP to GitHub Releases and publishes the server image to
`ghcr.io/shlok-bhakta/obsidian-sync-engine` with version and `latest` tags.
GitHub creates a new container package as private, so after the first release a
package owner must change its visibility to **Public** once. Deployments can
then pull it anonymously with the Compose sample above.
