CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE client (
    id UUID PRIMARY KEY DEFAULT uuidv7(),
    client_name TEXT NOT NULL,
    client_secret TEXT NOT NULL DEFAULT concat('obs_sync_', encode(gen_random_bytes(32), 'base64url')),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (client_name)
)