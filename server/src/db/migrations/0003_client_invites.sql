CREATE TABLE client_invites (
    token_hash TEXT PRIMARY KEY,
    client_id UUID NOT NULL UNIQUE REFERENCES clients(id) ON DELETE CASCADE,
    archive BYTEA NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX client_invites_expires_at_idx ON client_invites (expires_at);
