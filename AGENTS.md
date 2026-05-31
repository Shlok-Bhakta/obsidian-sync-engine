# Repository Guidelines

Obsidian sync engine: an Obsidian plugin client, a Bun sync server, and shared wire-protocol code.

## Project Structure & Module Organization

```
plugin/     Obsidian client (src/, esbuild → main.js)
server/     Bun/Hono backend (src/sync/, src/yjs/, src/db/migrations/)
shared/     Protocol, types, path policy, validation
scripts/    E2E and performance harnesses
docs/       Manual test docs (e.g. docs/sync-smoke.md)
```

Keep protocol changes in `shared/` and update both consumers. Plugin-specific Obsidian details live in `plugin/AGENTS.md`.

## Build, Test, and Development Commands

Install shared deps first: `cd shared && npm ci`.

| Location | Command | Purpose |
|----------|---------|---------|
| `plugin/` | `npm run dev` | Watch-build plugin to `main.js` |
| `plugin/` | `npm run build` | Typecheck + production bundle |
| `plugin/` | `npm run lint` | ESLint (typescript-eslint + obsidianmd) |
| `plugin/` | `npm test` | Vitest unit tests |
| `server/` | `bun run dev` | Hot-reload server on `:3000` |
| `server/` | `bun test` | Server unit and integration tests |
| repo root | `./db_setup.sh` | Local PostgreSQL for server dev |
| repo root | `mprocs` | Run plugin, server, db, and helpers |

## Coding Style & Naming Conventions

- **Indentation:** tabs, width 4 (`.editorconfig`).
- **Language:** TypeScript strict; prefer `async/await`.
- **Naming:** `camelCase` functions/variables; `PascalCase` types; colocate `*.test.ts` beside source.
- Do not commit `node_modules/`, `main.js`, or `db_data/`.

## Testing Guidelines

- **Plugin:** Vitest in `plugin/src/**/*.test.ts`; use `plugin/src/test/obsidianMock.ts` for Obsidian stubs.
- **Server:** Bun test; integration suite in `server/src/sync/engine.integration.test.ts`.
- **Shared:** `shared/*.test.ts` for protocol and path policy.
- **Manual:** follow `docs/sync-smoke.md` before shipping sync behavior changes.

Add tests for regressions and non-trivial sync logic; no fixed coverage threshold.

## Commit & Pull Request Guidelines

Recent commits use short, imperative, lowercase messages (`fix network reconnect desync bug`, `implement huge speedups`). Describe the outcome, not just the file touched.

PRs should pass CI (plugin build/lint/test; server `bun test`), note which packages changed, and link issues when applicable.

## Architecture & Configuration

Yjs CRDT updates flow over WebSockets; PostgreSQL stores revisions and blobs. Server reads `DATABASE_URL` via `server/src/db/`.
