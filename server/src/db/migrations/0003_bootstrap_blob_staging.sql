CREATE TABLE IF NOT EXISTS bootstrap_blobs (
    bootstrap_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content_oid OID NOT NULL,
    byte_size BIGINT NOT NULL,
    content_sha256 TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (bootstrap_id, path)
);
