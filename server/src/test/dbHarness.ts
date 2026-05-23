import { sql } from "bun";
import { bootstrapDB } from "../db/MigrationRunner";
import { flushScheduledYjsCompaction, registerClient } from "../sync/engine";

export async function canConnectToDatabase(): Promise<boolean> {
  try {
    const rows = await sql`SELECT 1 AS ok;`;
    return rows[0]?.ok === 1;
  } catch {
    return false;
  }
}

export async function setupIntegrationDb(): Promise<void> {
  await bootstrapDB();
  await resetIntegrationData();
}

export async function resetIntegrationData(): Promise<void> {
  await flushScheduledYjsCompaction();
  await sql`TRUNCATE TABLE sync_events, files, bootstrap_blobs, clients, client_keys RESTART IDENTITY CASCADE;`;
  await sql`
    UPDATE server_meta
    SET compacted_revision = 0
    WHERE id = 1;
  `;
}

export async function ensureIntegrationClient(clientId: string): Promise<void> {
  await registerClient(clientId, "integration-test");
}
