import { timingSafeEqual } from "node:crypto";

/**
 * Bootstrap zip downloads mint a new client credential and ship vault bytes.
 * They must never be open to the network without a shared admin token.
 *
 * Set BOOTSTRAP_TOKEN in the server environment. Prefer
 * `Authorization: Bearer <token>` (query `?token=` is accepted but may leak
 * into access logs).
 */
export function getConfiguredBootstrapToken(): string | null {
	const raw = process.env.BOOTSTRAP_TOKEN?.trim();
	return raw && raw.length > 0 ? raw : null;
}

export function extractBootstrapToken(opts: {
	authorizationHeader: string | undefined;
	queryToken: string | undefined;
}): string | null {
	const header = opts.authorizationHeader?.trim();
	if (header) {
		const bearer = /^Bearer\s+(.+)$/i.exec(header);
		if (bearer?.[1]) {
			return bearer[1].trim();
		}
		// Allow raw token in Authorization for simple curl/scripts.
		return header;
	}
	const query = opts.queryToken?.trim();
	return query && query.length > 0 ? query : null;
}

function tokensEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) {
		// Still compare equal-length buffers to keep runtime roughly flat.
		timingSafeEqual(left, left);
		return false;
	}
	return timingSafeEqual(left, right);
}

export function assertBootstrapAuthorized(opts: {
	authorizationHeader: string | undefined;
	queryToken: string | undefined;
}): { ok: true } | { ok: false; status: 401 | 503; error: string } {
	const configured = getConfiguredBootstrapToken();
	if (!configured) {
		return {
			ok: false,
			status: 503,
			error: "Bootstrap is disabled: set BOOTSTRAP_TOKEN on the server",
		};
	}
	const provided = extractBootstrapToken(opts);
	if (!provided || !tokensEqual(provided, configured)) {
		return {
			ok: false,
			status: 401,
			error: "Invalid or missing bootstrap token",
		};
	}
	return { ok: true };
}
