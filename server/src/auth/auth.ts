import { createHash, randomBytes } from "node:crypto";
import { sql } from "bun";
import type { Context, Hono, Next } from "hono";
import { z } from "zod";

export type AuthenticatedClient = { id: string; displayName: string };

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function generateClientSecret(): string {
  return `obs_sync_${randomBytes(32).toString("base64url")}`;
}

export async function createClient(displayName: string): Promise<AuthenticatedClient & { secret: string }> {
  const secret = generateClientSecret();
  const [row] = await sql<{ id: string; display_name: string }[]>`
    INSERT INTO clients(display_name, secret_hash)
    VALUES (${displayName}, ${hashSecret(secret)})
    RETURNING id, display_name
  `;
  if (!row) throw new Error("client creation did not return a row");
  return { id: row.id, displayName: row.display_name, secret };
}

export async function authenticateClient(
  clientId: string,
  credential: string,
  expectedName?: string,
): Promise<AuthenticatedClient | null> {
  const [row] = await sql<{ id: string; display_name: string }[]>`
    UPDATE clients
    SET last_seen_at = NOW(), updated_at = NOW()
    WHERE id = ${clientId} AND secret_hash = ${hashSecret(credential)} AND status = 'active'
      AND (${expectedName ?? null}::text IS NULL OR display_name = ${expectedName ?? null})
    RETURNING id, display_name
  `;
  return row ? { id: row.id, displayName: row.display_name } : null;
}

export function bearerCredential(c: Context): string | null {
  const value = c.req.header("Authorization");
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1] ?? null;
}

export async function requireBearer(c: Context, next: Next): Promise<Response | void> {
  const credential = bearerCredential(c);
  const clientId = c.req.header("X-Client-Id");
  if (!credential || !clientId) return c.json({ code: "AUTH_REQUIRED", message: "Bearer authentication is required" }, 401);
  const client = await authenticateClient(clientId, credential);
  if (!client) return c.json({ code: "AUTH_INVALID", message: "The client credential is invalid or revoked" }, 401);
  c.set("client", client);
  await next();
}

export function getAuthenticatedClient(c: Context): AuthenticatedClient {
  const client = c.get("client") as AuthenticatedClient | undefined;
  if (!client) throw new Error("authenticated client context is missing");
  return client;
}

const nameSchema = z.object({ displayName: z.string().trim().min(1).max(100) }).strict();

export function registerAuthRoutes(app: Hono): void {
  app.post("/v1/auth/register-initial", async (c) => {
    const parsed = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: "VALIDATION_FAILED", message: "A valid display name is required" }, 400);
    try {
      const result = await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(73194521)`;
        const [{ count }] = await tx<{ count: string }[]>`SELECT COUNT(*)::text AS count FROM clients`;
        if (count !== "0") return null;
        const secret = generateClientSecret();
        const [row] = await tx<{ id: string; display_name: string }[]>`
          INSERT INTO clients(display_name, secret_hash) VALUES (${parsed.data.displayName}, ${hashSecret(secret)})
          RETURNING id, display_name
        `;
        return row ? { clientId: row.id, displayName: row.display_name, clientSecret: secret } : null;
      });
      if (!result) return c.json({ code: "INITIAL_CLIENT_EXISTS", message: "The server has already been claimed" }, 409);
      return c.json(result, 201);
    } catch (error) {
      if (String(error).includes("clients_display_name_key")) {
        return c.json({ code: "NAME_TAKEN", message: "That client name is already in use" }, 409);
      }
      throw error;
    }
  });

  app.post("/v1/auth/rotate-secret", requireBearer, async (c) => {
    const client = getAuthenticatedClient(c);
    const secret = generateClientSecret();
    await sql`UPDATE clients SET secret_hash = ${hashSecret(secret)}, updated_at = NOW() WHERE id = ${client.id}`;
    return c.json({ clientSecret: secret });
  });

  app.patch("/v1/auth/name", requireBearer, async (c) => {
    const parsed = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ code: "VALIDATION_FAILED", message: "A valid display name is required" }, 400);
    const client = getAuthenticatedClient(c);
    try {
      await sql`UPDATE clients SET display_name = ${parsed.data.displayName}, updated_at = NOW() WHERE id = ${client.id}`;
      return c.json({ displayName: parsed.data.displayName });
    } catch (error) {
      if (String(error).includes("clients_display_name_key")) {
        return c.json({ code: "NAME_TAKEN", message: "That client name is already in use" }, 409);
      }
      throw error;
    }
  });
}
