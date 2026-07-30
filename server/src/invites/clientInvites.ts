import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "bun";
import { Hono } from "hono";
import {
	createClient,
	type ClientAuthorizer,
	getClientIdFromAuthorization,
	requireClientId,
} from "../auth/auth";
import { objectStore, type ObjectStore } from "../object/object_store";
import {
	clientInviteSchema,
	type ClientInvite,
} from "obsidian-sync-protocol";

export const CLIENT_INVITE_LIFETIME_MS = 5 * 60 * 1000;

type InviteRow = {
	archive: Buffer;
	client_id: string;
};

function hashToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

function noStoreHeaders(): Record<string, string> {
	return {
		"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
		Pragma: "no-cache",
		Expires: "0",
		"Referrer-Policy": "no-referrer",
		"X-Robots-Tag": "noindex, nofollow, noarchive",
	};
}

export async function cleanupExpiredClientInvites(
	now = new Date(),
): Promise<number> {
	return sql.begin(async (tx) => {
		const expired = await tx<{ client_id: string }[]>`
			DELETE FROM client_invites
			WHERE expires_at <= ${now}
			RETURNING client_id
		`;
		for (const invite of expired) {
			await tx`DELETE FROM clients WHERE id = ${invite.client_id}`;
		}
		return expired.length;
	}) as Promise<number>;
}

async function inviteExists(token: string, now = new Date()): Promise<boolean> {
	const [row] = await sql<{ exists: boolean }[]>`
		SELECT EXISTS (
			SELECT 1 FROM client_invites
			WHERE token_hash = ${hashToken(token)} AND expires_at > ${now}
		) AS exists
	`;
	if (!row.exists) {
		await cleanupExpiredClientInvites(now);
	}
	return row.exists;
}

async function consumeInvite(
	token: string,
	now = new Date(),
): Promise<Buffer | null> {
	await cleanupExpiredClientInvites(now);
	return sql.begin(async (tx) => {
		const [invite] = await tx<InviteRow[]>`
			DELETE FROM client_invites
			WHERE token_hash = ${hashToken(token)} AND expires_at > ${now}
			RETURNING archive, client_id
		`;
		return invite?.archive ?? null;
	}) as Promise<Buffer | null>;
}

async function createInvite(options: {
	store: ObjectStore;
	serverUrl: string;
	now?: Date;
}): Promise<{ token: string; expiresAt: Date }> {
	const now = options.now ?? new Date();
	await cleanupExpiredClientInvites(now);
	const clientName = `client-${randomUUID()}`;
	const clientSecret = await createClient(clientName);
	const clientId = await getClientIdFromAuthorization(clientSecret);
	try {
		const archive = await options.store.createClientArchive({
			serverUrl: options.serverUrl,
			clientName,
			clientSecret,
		});
		const token = randomBytes(32).toString("base64url");
		const expiresAt = new Date(now.getTime() + CLIENT_INVITE_LIFETIME_MS);
		await sql`
			INSERT INTO client_invites (
				token_hash, client_id, archive, expires_at
			) VALUES (
				${hashToken(token)}, ${clientId}, ${Buffer.from(archive)}, ${expiresAt}
			)
		`;
		const timer = setTimeout(() => {
			void cleanupExpiredClientInvites().catch((error) => {
				console.error("Could not clean up expired client invite", error);
			});
		}, CLIENT_INVITE_LIFETIME_MS);
		timer.unref?.();
		return { token, expiresAt };
	} catch (error) {
		await sql`DELETE FROM clients WHERE id = ${clientId}`.catch(() => undefined);
		throw error;
	}
}

function landingPage(token: string): string {
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <title>Obsidian Sync Engine</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #111318; }
    main { width: min(28rem, calc(100% - 3rem)); padding: 2rem; border-radius: 1rem; background: #1c2028; color: #f6f7fb; box-shadow: 0 1rem 3rem #0008; }
    h1 { margin-top: 0; font-size: 1.5rem; }
    p { color: #c8ceda; line-height: 1.5; }
    button { width: 100%; padding: .9rem 1rem; border: 0; border-radius: .65rem; background: #7c5cff; color: white; font: inherit; font-weight: 700; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Add this Obsidian client</h1>
    <p>This package can be downloaded once and expires five minutes after it was created.</p>
    <form method="post" action="/client-invites/${token}/download">
      <button type="submit">Download ZIP</button>
    </form>
  </main>
</body>
</html>`;
}

export function registerClientInviteRoutes(
	app: Hono,
	store: ObjectStore = objectStore,
	authorize: ClientAuthorizer = getClientIdFromAuthorization,
) {
	return app
		.post("/client-invites", async (c) => {
			const authorized = await requireClientId(c, authorize);
			if (authorized instanceof Response) return authorized;
			const requestUrl = new URL(c.req.url);
			const serverUrl = requestUrl.origin;
			const invite = await createInvite({ store, serverUrl });
			const response: ClientInvite = clientInviteSchema.parse({
				url: `${serverUrl}/client-invites/${invite.token}`,
				expiresAt: invite.expiresAt.toISOString(),
			});
			return c.json(response, 201);
		})
		.get("/client-invites/:token", async (c) => {
			const token = c.req.param("token");
			if (!(await inviteExists(token))) {
				return c.html("This client package has expired or was already used.", 410, noStoreHeaders());
			}
			return c.html(landingPage(token), 200, {
				...noStoreHeaders(),
				"Content-Security-Policy":
					"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
			});
		})
		.post("/client-invites/:token/download", async (c) => {
			const archive = await consumeInvite(c.req.param("token"));
			if (!archive) {
				return c.text("This client package has expired or was already used.", 410, noStoreHeaders());
			}
			const body = archive.buffer.slice(
				archive.byteOffset,
				archive.byteOffset + archive.byteLength,
			) as ArrayBuffer;
			return new Response(body, {
				status: 200,
				headers: {
					...noStoreHeaders(),
					"Content-Type": "application/zip",
					"Content-Disposition": `attachment; filename="obsidian-sync-client-${Date.now()}.zip"`,
					"Content-Length": String(archive.byteLength),
				},
			});
		});
}
