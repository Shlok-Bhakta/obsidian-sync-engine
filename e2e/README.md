# Obsidian sync engine — e2e

Real Obsidian clients via [linuxserver/obsidian](https://github.com/linuxserver/docker-obsidian), driven **only** with `obsidian-cli` (no Playwright).

## Prerequisites

- `podman` + `podman-compose` (or Docker: set `CONTAINER_BIN=docker`)
- `bun`
- `unzip` / `zip`
- Network once to pull `lscr.io/linuxserver/obsidian:latest`

## Run

```bash
# Start Postgres (test_db on :5434)
podman compose up -d test-db

# From repo root
cd e2e && bun install && bun test tests/obsidian
```

Docker / CI style:

```bash
export CONTAINER_BIN=docker
export E2E_SKIP_COMPOSE=1          # when Postgres is already running
export E2E_DATABASE_URL=postgres://postgres:postgres@localhost:5434/test_db
export E2E_HOST_GATEWAY=host.docker.internal
cd e2e && bun test tests/obsidian
```

## What it covers

| ID | Scenario |
| --- | --- |
| E1 | Fresh auth + vault seed |
| E2 | `/bootstrap.zip` as second client |
| E3 | Edit on A → appears on B |
| E4 | Delete on A → gone on B |
| E5 | Self-echo does not duplicate |
| E6 | Offline edits drain after reconnect |
| E7 | Binary / html / nested round-trip |
| E8 | Rapid put+delete does not stall B |

Runtime artifacts land in `e2e/.run/` (gitignored).
