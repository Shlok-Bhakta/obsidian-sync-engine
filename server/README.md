# Revision Sync server

The server requires Bun, PostgreSQL 18, and durable local filesystem storage. Set `DATABASE_URL` before starting it.

```sh
bun install
bun run typecheck
bun test
bun run dev
```

Configuration:

- `DATABASE_URL`: PostgreSQL connection string.
- `OBJECT_STORE_DIR`: durable storage root; defaults to `server/object-data`.
- `MAX_OBJECT_BYTES`: request/object limit; defaults to 100 MiB.
- `PLUGIN_BUNDLE_DIR`: directory containing built `main.js`, `manifest.json`, and optionally `styles.css` for bootstrap zips. In a source checkout it defaults to `plugin/`.

Terminate TLS in front of the server outside a trusted private network. The application deliberately never logs bearer credentials or vault bodies. Keep PostgreSQL, the object directory, and the generated-bootstrap temporary directory on trusted storage.

Run the PostgreSQL-backed integration suite against a disposable database with:

```sh
RUN_POSTGRES_TESTS=1 DATABASE_URL=postgres://... bun run test:integration
```
