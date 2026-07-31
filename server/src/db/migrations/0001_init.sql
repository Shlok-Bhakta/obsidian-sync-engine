CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    client_name TEXT NOT NULL,
    client_secret TEXT NOT NULL DEFAULT concat('obs_sync_', encode(gen_random_bytes(32), 'base64')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (client_name)
);

CREATE SEQUENCE global_revision AS BIGINT;


CREATE TABLE files (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    file_path TEXT NOT NULL UNIQUE,
    last_updated_revision BIGINT NOT NULL DEFAULT NEXTVAL('global_revision'),
    file_is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    content BYTEA,
    author_id UUID NOT NULL REFERENCES clients(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    CHECK (file_is_deleted OR content IS NOT NULL)
);

CREATE TABLE client_invites (
    token_hash TEXT PRIMARY KEY,
    client_id UUID NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
    archive BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX client_invites_expires_at_idx ON client_invites (expires_at);
