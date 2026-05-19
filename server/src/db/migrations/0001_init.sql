CREATE TABLE IF NOT EXISTS client_keys (
    id BIGSERIAL PRIMARY KEY,
    client_key TEXT NOT NULL UNIQUE,
    previous_key_id BIGINT REFERENCES client_keys(id),
    valid BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS client_keys_one_valid_child_per_previous
    ON client_keys(previous_key_id)
    WHERE previous_key_id IS NOT NULL AND valid = TRUE;

CREATE TABLE IF NOT EXISTS clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    current_key_id BIGINT REFERENCES client_keys(id),
    previous_key_id BIGINT REFERENCES client_keys(id),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_acked_revision BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    content TEXT,
    yjs_state BYTEA,
    is_folder BOOLEAN NOT NULL,
    is_yjs BOOLEAN NOT NULL DEFAULT FALSE,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    revision BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sync_events (
    revision BIGSERIAL PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(client_id),
    mutation_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    path TEXT NOT NULL,
    to_path TEXT,
    content TEXT,
    payload BYTEA,
    is_folder BOOLEAN,
    is_yjs BOOLEAN,
    compacted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, mutation_id)
);

CREATE INDEX IF NOT EXISTS sync_events_path_revision_idx
    ON sync_events(path, revision);

CREATE TABLE IF NOT EXISTS server_meta (
    id SMALLINT PRIMARY KEY DEFAULT 1,
    compacted_revision BIGINT NOT NULL DEFAULT 0,
    CHECK (id = 1)
);

INSERT INTO server_meta (id, compacted_revision)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;
