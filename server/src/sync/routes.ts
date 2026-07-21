import { sql } from "bun";
import type { Hono } from "hono";
import {
  changesResponseSchema,
  mutationRequestSchema,
  revisionSchema,
  type ChangesResponse,
  type SyncEvent,
} from "obsidian-sync-protocol";
import { getAuthenticatedClient, requireBearer } from "../auth/auth";
import { InvalidMutationError, syncEngine, type SyncEngine } from "./engine";

type ChangeRow = {
  revision: string;
  client_id: string;
  mutation_id: string;
  operation: SyncEvent["operation"];
  file_id: string;
  path: string;
  destination_path: string | null;
  object_hash: string | null;
  created_at: Date | string;
};

export function registerSyncRoutes(app: Hono, engine: SyncEngine = syncEngine): void {
  app.get("/v1/changes", requireBearer, async (c) => {
    const since = c.req.query("since") ?? "0";
    const limitRaw = c.req.query("limit") ?? "500";
    if (!revisionSchema.safeParse(since).success || !/^\d+$/.test(limitRaw)) {
      return c.json({ code: "VALIDATION_FAILED", message: "Invalid revision or limit" }, 400);
    }
    const limit = Math.min(Math.max(Number(limitRaw), 1), 2000);
    const rows = await sql<ChangeRow[]>`
      SELECT revision::text, client_id, mutation_id, operation, file_id, path, destination_path,
        object_hash, created_at
      FROM sync_events WHERE revision > ${since}::bigint ORDER BY revision ASC LIMIT ${limit + 1}
    `;
    const hasMore = rows.length > limit;
    const changes = rows.slice(0, limit).map((row) => ({
      revision: row.revision,
      clientId: row.client_id,
      mutationId: row.mutation_id,
      operation: row.operation,
      fileId: row.file_id,
      path: row.path,
      destinationPath: row.destination_path,
      objectHash: row.object_hash,
      createdAt: new Date(row.created_at).toISOString(),
    }));
    const response: ChangesResponse = { changes, currentServerRevision: await engine.currentRevision(), hasMore };
    return c.json(changesResponseSchema.parse(response));
  });

  app.post("/v1/mutations", requireBearer, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = mutationRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ code: "VALIDATION_FAILED", message: "Malformed mutation request", issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) }, 400);
    }
    if (await engine.bootstrapRequired()) {
      return c.json({ code: "BOOTSTRAP_REQUIRED", message: "Commit the initial bootstrap snapshot before mutations" }, 409);
    }
    const client = getAuthenticatedClient(c);
    try { return c.json(await engine.applyMutations(client.id, parsed.data.mutations)); }
    catch (error) {
      if (error instanceof InvalidMutationError) return c.json({ code: error.code, message: error.message }, 400);
      throw error;
    }
  });
}
