-- Migration creates a table to track the files/folders
CREATE TABLE IF NOT EXISTS files (
    id BIGSERIAL PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    hash TEXT, -- enforce in application code that this hash exists on everything except folders
    is_folder BOOLEAN NOT NULL,
    is_yjs BOOLEAN NOT NULL,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- only stores one value, meant to be used to know wether we need to ask the client "pretty please send me the entire file tree and content you have so I can have it setup for others"
CREATE TABLE IF NOT EXISTS client_bootstrapped (
    id SERIAL PRIMARY KEY,
    bootstrapped BOOLEAN NOT NULL DEFAULT FALSE
);

-- actually create the row`
INSERT INTO client_bootstrapped (id, bootstrapped) VALUES (1, FALSE) ON CONFLICT (id) DO NOTHING;