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
| E1 | Fresh auth + automatic vault seed at revision `0` |
| E2 | Preview-safe, single-use client package as a second client without startup re-uploads |
| E3 | Edit on A → appears on B |
| E4 | Delete on A → gone on B |
| E4b | Folder delete on A → folder gone on B, folders with other files stay |
| E5 | Self-echo does not duplicate |
| E6 | Offline edits drain after reconnect |
| E7 | Binary / html / nested round-trip |
| E8 | Rapid put+delete does not stall B |
| E9 | Remote file/directory shape transitions |
| E10 | Causal subtree delete preserves newer descendants |
| E11 | Four independent packaged clients under rapid edits, conflicts, rename/delete/recreate, and subtree races |

The four-client scenario requires byte-identical vault/server snapshots, equal
revisions, empty durable queues, and no plugin errors for five consecutive
explicit sync rounds. Polling observes those conditions directly; fixed sleeps
are not used as correctness gates.

Runtime artifacts land in `e2e/.run/` (gitignored).

## Rust client interop

`tests/rust-client` runs the compiled Rust client against the real server, with the
plugin's own `SyncEngine` and `HttpTransport` as the second device. It needs no
Obsidian image.

```bash
cargo build --manifest-path rust-client/Cargo.toml
cd e2e && bun test tests/rust-client
```

On a machine that filters loopback traffic, new connections to the Bun server can
stall on connect and tests time out, with sockets piling up in `LAST-ACK`. If you see
that, run the suite in a network namespace that has Postgres in it, such as the
database container's (`podman unshare nsenter --net=/proc/<pid>/ns/net ...`).
