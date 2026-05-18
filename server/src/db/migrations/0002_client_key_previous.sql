ALTER TABLE client_keys
    ADD COLUMN IF NOT EXISTS previous_key_id BIGINT REFERENCES client_keys(id);

CREATE UNIQUE INDEX IF NOT EXISTS client_keys_one_valid_child_per_previous
    ON client_keys(previous_key_id)
    WHERE previous_key_id IS NOT NULL AND valid = TRUE;
