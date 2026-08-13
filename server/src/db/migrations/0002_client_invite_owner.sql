ALTER TABLE client_invites
ADD COLUMN owner_client_id UUID;

ALTER TABLE client_invites
ADD CONSTRAINT client_invites_owner_client_id_fkey
FOREIGN KEY (owner_client_id)
REFERENCES clients(id)
ON DELETE RESTRICT
NOT VALID;
