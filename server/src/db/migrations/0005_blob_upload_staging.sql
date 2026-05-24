CREATE TABLE IF NOT EXISTS blob_uploads (
    upload_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES clients(client_id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    content_oid OID NOT NULL,
    byte_size BIGINT NOT NULL,
    content_sha256 TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS blob_uploads_client_path_sha_idx
    ON blob_uploads(client_id, path, content_sha256, created_at DESC);
