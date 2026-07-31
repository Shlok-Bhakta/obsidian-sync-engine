/**
 * Bun defaults to a 128 MiB request-body limit when this option is omitted.
 * Use the largest exact integer JavaScript can represent so the sync server
 * does not impose a practical per-file upload limit.
 */
export const MAX_REQUEST_BODY_SIZE = Number.MAX_SAFE_INTEGER;
