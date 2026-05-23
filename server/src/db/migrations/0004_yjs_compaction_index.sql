CREATE INDEX IF NOT EXISTS sync_events_yjs_uncompacted_path_revision_idx
    ON sync_events(path, revision)
    WHERE operation = 'YjsUpdate' AND compacted = FALSE;
