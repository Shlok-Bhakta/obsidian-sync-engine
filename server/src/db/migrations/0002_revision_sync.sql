DROP TABLE IF EXISTS bootstrap_links CASCADE;
DROP TABLE IF EXISTS bootstrap_commits CASCADE;
DROP TABLE IF EXISTS sync_events CASCADE;
DROP TABLE IF EXISTS files CASCADE;
DROP TABLE IF EXISTS objects CASCADE;
DROP TABLE IF EXISTS server_meta CASCADE;
DROP TABLE IF EXISTS clients CASCADE;
DROP SEQUENCE IF EXISTS global_revision;

CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name TEXT NOT NULL UNIQUE,
    secret_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ
);

CREATE SEQUENCE global_revision AS BIGINT START WITH 1;

CREATE TABLE objects (
    sha256 CHAR(64) PRIMARY KEY,
    byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
    reference_state TEXT NOT NULL DEFAULT 'staged' CHECK (reference_state IN ('staged', 'referenced')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    referenced_at TIMESTAMPTZ
);

CREATE TABLE files (
    id UUID PRIMARY KEY,
    current_path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('markdown', 'blob')),
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    current_revision BIGINT NOT NULL,
    object_hash CHAR(64) REFERENCES objects(sha256),
    yjs_state_hash CHAR(64) REFERENCES objects(sha256),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((kind = 'markdown' AND object_hash IS NULL) OR (kind = 'blob' AND yjs_state_hash IS NULL))
);
CREATE UNIQUE INDEX files_live_path_unique ON files(current_path) WHERE deleted = FALSE;

CREATE TABLE sync_events (
    revision BIGINT PRIMARY KEY DEFAULT nextval('global_revision'),
    client_id UUID NOT NULL REFERENCES clients(id),
    mutation_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('create', 'update', 'rename', 'delete', 'yjs_update')),
    file_id UUID NOT NULL REFERENCES files(id),
    path TEXT NOT NULL,
    destination_path TEXT,
    object_hash CHAR(64) REFERENCES objects(sha256),
    result_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, mutation_id)
);
CREATE INDEX sync_events_revision_idx ON sync_events(revision);

CREATE TABLE bootstrap_commits (
    bootstrap_id UUID PRIMARY KEY,
    client_id UUID NOT NULL REFERENCES clients(id),
    snapshot_revision BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE bootstrap_links (
    capability_hash CHAR(64) PRIMARY KEY,
    generated_client_id UUID NOT NULL REFERENCES clients(id),
    snapshot_revision BIGINT NOT NULL,
    zip_path TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE server_meta (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    bootstrap_state TEXT NOT NULL DEFAULT 'empty' CHECK (bootstrap_state IN ('empty', 'committed')),
    current_snapshot_revision BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO server_meta(singleton) VALUES (TRUE);
