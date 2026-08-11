ALTER TABLE client_invites
ADD COLUMN owner_client_id UUID REFERENCES clients(id) ON DELETE CASCADE;
