import { Context, Hono } from "hono";
import { join, resolve } from "node:path";
import { sql } from "bun";
import { zipSync } from "fflate";
import {
	type ClientAuthorizer,
	getClientIdFromAuthorization,
	requireClientId,
} from "../auth/auth";
import {
	CLIENT_DATA_PATH,
	type ClientConfig,
	type DeleteResponse,
	type InboxOp,
	revisionSchema,
	serializeInboxNdjson,
	type UploadResponse,
} from "obsidian-sync-protocol";
import { canonicalizePath, InvalidPathError } from "./paths";
import { serverLogger, type Logger } from "../logger";

export { InvalidPathError };

export const DEFAULT_OBJECT_STORE_DIR = resolve(
    import.meta.dir,
    "../../",
    process.env.OBJECT_STORE_DIR ?? "object-data",
);

/**
 * Advisory-lock key shared by every upload/delete. Holding it from the
 * moment we ask Postgres for the next revision until the transaction
 * commits (or rolls back) guarantees commit order matches revision order:
 * a transaction cannot observe/assign a revision while another
 * revision-assigning transaction is still in flight, so a lower revision
 * can never commit after a client has already observed a higher one.
 */
const REVISION_LOCK_KEY = "obsidian-sync-revision";
const PLUGIN_ID = "obsidian-sync-engine";
const PLUGIN_DIR = resolve(
	process.env.PLUGIN_DIST_DIR ?? join(import.meta.dir, "../../../plugin"),
);

async function addPluginToArchive(
	entries: Record<string, Uint8Array>,
): Promise<void> {
	const pluginVaultDir = `.obsidian/plugins/${PLUGIN_ID}`;
	for (const name of ["main.js", "manifest.json"] as const) {
		const file = Bun.file(join(PLUGIN_DIR, name));
		if (!(await file.exists())) {
			throw new Error(
				`Plugin artifact ${name} is missing from ${PLUGIN_DIR}; build the plugin before starting the server`,
			);
		}
		entries[`${pluginVaultDir}/${name}`] = new Uint8Array(
			await file.arrayBuffer(),
		);
	}
	const styles = Bun.file(join(PLUGIN_DIR, "styles.css"));
	if (await styles.exists()) {
		entries[`${pluginVaultDir}/styles.css`] = new Uint8Array(
			await styles.arrayBuffer(),
		);
	}
	const communityPluginsPath = ".obsidian/community-plugins.json";
	let communityPlugins: string[] = [];
	const existing = entries[communityPluginsPath];
	if (existing) {
		try {
			const parsed = JSON.parse(new TextDecoder().decode(existing));
			if (Array.isArray(parsed)) {
				communityPlugins = parsed.filter(
					(value): value is string => typeof value === "string",
				);
			}
		} catch {
			// Replace invalid Obsidian plugin metadata with a usable list.
		}
	}
	if (!communityPlugins.includes(PLUGIN_ID)) {
		communityPlugins.push(PLUGIN_ID);
	}
	entries[communityPluginsPath] = new TextEncoder().encode(
		JSON.stringify(communityPlugins),
	);
}

export type ObjectStoreUploadContent = {
    path: string;
    content: Bun.BlobOrStringOrBuffer;
    id: string;
};

export type ObjectStoreUploadResult = UploadResponse;

export type ObjectStoreOutboxItem = {
    path: string;
    lastUpdatedRevision: number;
    isDeleted: boolean;
};

type FileContentRow = { last_updated_revision: number };

/** Normalizes any upload body shape into a Buffer suitable for a BYTEA column. */
async function toBuffer(content: Bun.BlobOrStringOrBuffer): Promise<Buffer> {
    if (typeof content === "string") {
        return Buffer.from(content, "utf-8");
    }
    if (content instanceof Blob) {
        return Buffer.from(await content.arrayBuffer());
    }
    if (ArrayBuffer.isView(content)) {
        return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    }
    return Buffer.from(content);
}

/** Copies a Buffer/Uint8Array read back from Postgres into a right-sized ArrayBuffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// Object store backed entirely by Postgres: file bytes live in the `files.content`
// BYTEA column alongside their metadata, written in the same transaction so there is
// no window where metadata and bytes can disagree (no dual-write race with disk).
export class ObjectStore {
	private readonly logger: Logger;

    constructor(
		private readonly rootDirectory = DEFAULT_OBJECT_STORE_DIR,
		logger: Logger = serverLogger,
	) {
		this.logger = logger.child("object_store");
	}

    /**
     * All store methods take already-decoded paths. Callers (routes) are responsible for
     * decoding: query params are decoded once by the URL parser already, headers are not.
     */
    async upload(content: ObjectStoreUploadContent): Promise<ObjectStoreUploadResult> {
		const startedAt = Date.now();
        const path = canonicalizePath(content.path);
        const buffer = await toBuffer(content.content);
		this.logger.info("upload.started", {
			path,
			bytes: buffer.byteLength,
			clientId: content.id,
		});

        const [row] = (await sql.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${REVISION_LOCK_KEY}))`;
			const conflicts = await tx<{ file_path: string }[]>`
				SELECT file_path FROM files
				WHERE file_is_deleted = FALSE
				  AND (
					position(file_path || '/' in ${path}) = 1
					OR position(${path + "/"} in file_path) = 1
				  )
			`;
			if (conflicts.length > 0) {
				this.logger.warn("upload.structural_conflicts", {
					path,
					conflictPaths: conflicts.map(({ file_path }) => file_path),
				});
			}
			for (const conflict of conflicts) {
				await tx`
					UPDATE files
					SET file_is_deleted = TRUE, content = NULL, author_id = ${content.id},
						updated_at = NOW(), last_updated_revision = NEXTVAL('global_revision')
					WHERE file_path = ${conflict.file_path}
				`;
			}
            return tx<FileContentRow[]>`
                INSERT INTO files (file_path, author_id, content, file_is_deleted)
                VALUES (${path}, ${content.id}, ${buffer}, FALSE)
                ON CONFLICT (file_path) DO UPDATE SET
                    author_id = EXCLUDED.author_id,
                    content = EXCLUDED.content,
                    file_is_deleted = FALSE,
                    last_updated_revision = EXCLUDED.last_updated_revision,
                    updated_at = NOW()
                RETURNING last_updated_revision
            `;
        })) as FileContentRow[];

        const result = {
            path,
            bytesWritten: buffer.byteLength,
            revision: Number(row.last_updated_revision),
        };
		this.logger.info("upload.completed", {
			...result,
			clientId: content.id,
			durationMs: Date.now() - startedAt,
		});
		return result;
    }

    /** Soft-deletes a file. Idempotent: unknown paths get a tombstone revision. */
    async delete(
        path: string,
        authorId: string,
        baseRevision?: number,
    ): Promise<{ revision: number }> {
		const startedAt = Date.now();
        const canonicalPath = canonicalizePath(path);
		this.logger.info("delete.started", {
			path: canonicalPath,
			clientId: authorId,
			baseRevision,
		});

        const [row] = (await sql.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${REVISION_LOCK_KEY}))`;
            const active = await tx<{
                file_path: string;
                last_updated_revision: string;
            }[]>`
                SELECT file_path, last_updated_revision FROM files
                WHERE file_is_deleted = FALSE
                  AND (
                    file_path = ${canonicalPath}
                    OR position(${canonicalPath + "/"} in file_path) = 1
                  )
                ORDER BY file_path
            `;
            const newer = active.filter(
                ({ last_updated_revision }) =>
                    baseRevision !== undefined &&
                    Number(last_updated_revision) > baseRevision,
            );
            let lastDeletedRevision: number | null = null;
            for (const candidate of active) {
                if (
                    candidate.file_path === canonicalPath ||
                    (baseRevision !== undefined &&
                        Number(candidate.last_updated_revision) > baseRevision)
                ) {
                    continue;
                }
                const [deleted] = await tx<{ last_updated_revision: string }[]>`
                    UPDATE files
                    SET author_id = ${authorId}, file_is_deleted = TRUE,
                        content = NULL, updated_at = NOW(),
                        last_updated_revision = NEXTVAL('global_revision')
                    WHERE file_path = ${candidate.file_path}
                    RETURNING last_updated_revision
                `;
                lastDeletedRevision = Number(deleted.last_updated_revision);
            }
            if (newer.length > 0) {
                // A parent tombstone would recursively erase the newer members
                // on clients. Emit only tombstones for members visible at the
                // deleting client's base revision.
                const acknowledgedRevision =
                    lastDeletedRevision ??
                    Math.max(
                        ...newer.map(({ last_updated_revision }) =>
                            Number(last_updated_revision)
                        ),
                    );
                return [{ last_updated_revision: acknowledgedRevision }];
            }
            return tx<FileContentRow[]>`
                INSERT INTO files (file_path, author_id, file_is_deleted, content)
                VALUES (${canonicalPath}, ${authorId}, TRUE, NULL)
                ON CONFLICT (file_path) DO UPDATE SET
                    author_id = EXCLUDED.author_id,
                    file_is_deleted = TRUE,
                    content = NULL,
                    updated_at = NOW(),
                    last_updated_revision = NEXTVAL('global_revision')
                RETURNING last_updated_revision
            `;
        })) as FileContentRow[];
        const revision = Number(row.last_updated_revision);
		this.logger.info("delete.completed", {
			path: canonicalPath,
			clientId: authorId,
			baseRevision,
			revision,
			durationMs: Date.now() - startedAt,
		});
		return { revision };
    }

    /** Current global tip revision: highest revision stamped on any file (including deletes), or 0 if none exist. */
    async getTipRevision(): Promise<number> {
		this.logger.debug("tip_revision.query_started");
        const [row] = await sql<{ tip: string | null }[]>`
            SELECT MAX(last_updated_revision) AS tip FROM files
        `;
        const revision = row?.tip ? Number(row.tip) : 0;
		this.logger.debug("tip_revision.query_completed", { revision });
		return revision;
    }

    /** Downloads a file's bytes. Returns null if the file doesn't exist, is soft-deleted, or has no content. */
    async download(path: string): Promise<ArrayBuffer | null> {
		const startedAt = Date.now();
        const canonicalPath = canonicalizePath(path);
		this.logger.debug("download.started", { path: canonicalPath });

        const [row] = await sql<{ file_is_deleted: boolean; content: Buffer | null }[]>`
            SELECT file_is_deleted, content FROM files WHERE file_path = ${canonicalPath}
        `;
        if (!row || row.file_is_deleted || row.content === null) {
			this.logger.warn("download.not_found", {
				path: canonicalPath,
				durationMs: Date.now() - startedAt,
			});
            return null;
        }
        const data = toArrayBuffer(row.content);
		this.logger.info("download.completed", {
			path: canonicalPath,
			bytes: data.byteLength,
			durationMs: Date.now() - startedAt,
		});
		return data;
    }

    /**
     * One-shot upgrade helper: for rows with NULL content, copy bytes from the
     * legacy filesystem object store (OBJECT_STORE_DIR) if present. Safe to call
     * repeatedly — only fills missing BYTEA values and never bumps revisions.
     */
    async backfillContentFromLegacyDisk(): Promise<number> {
		const startedAt = Date.now();
		this.logger.info("legacy_backfill.started", {
			rootDirectory: this.rootDirectory,
		});
        const missing = await sql<{ file_path: string }[]>`
            SELECT file_path FROM files
            WHERE file_is_deleted = FALSE AND content IS NULL
        `;
        let filled = 0;
        for (const { file_path } of missing) {
			this.logger.debug("legacy_backfill.file_started", { path: file_path });
            let diskPath: string;
            try {
                diskPath = resolve(this.rootDirectory, file_path);
                if (
                    diskPath !== resolve(this.rootDirectory) &&
                    !diskPath.startsWith(resolve(this.rootDirectory) + "/")
                ) {
					this.logger.warn("legacy_backfill.file_skipped", {
						path: file_path,
						reason: "outside_root",
					});
                    continue;
                }
            } catch {
				this.logger.warn("legacy_backfill.file_skipped", {
					path: file_path,
					reason: "invalid_path",
				});
                continue;
            }
            const file = Bun.file(diskPath);
            if (!(await file.exists())) {
				this.logger.warn("legacy_backfill.file_skipped", {
					path: file_path,
					reason: "file_missing",
				});
                continue;
            }
            const bytes = Buffer.from(await file.arrayBuffer());
            const result = await sql`
                UPDATE files
                SET content = ${bytes}, updated_at = NOW()
                WHERE file_path = ${file_path}
                  AND file_is_deleted = FALSE
                  AND content IS NULL
            `;
            if (Number(result.count ?? 0) > 0) {
                filled++;
				this.logger.info("legacy_backfill.file_completed", {
					path: file_path,
					bytes: bytes.byteLength,
				});
            }
        }
		this.logger.info("legacy_backfill.completed", {
			missingRows: missing.length,
			filled,
			durationMs: Date.now() - startedAt,
		});
        return filled;
    }

	async assertContentComplete(): Promise<void> {
		this.logger.debug("content_check.started");
		const [{ count }] = await sql<{ count: string }[]>`
			SELECT COUNT(*)::text AS count FROM files
			WHERE file_is_deleted = FALSE AND content IS NULL
		`;
		if (Number(count) > 0) {
			this.logger.error("content_check.failed", {
				incompleteFiles: Number(count),
			});
			throw new Error(
				`Object store is not ready: ${count} active file(s) have no content`,
			);
		}
		this.logger.info("content_check.completed", { incompleteFiles: 0 });
	}

    async createClientArchive(options: {
		serverUrl: string;
		clientName: string;
		clientSecret: string;
	}): Promise<Uint8Array> {
		const startedAt = Date.now();
		this.logger.info("client_archive.started", {
			serverUrl: options.serverUrl,
			clientName: options.clientName,
		});
		await this.assertContentComplete();
		const entries: Record<string, Uint8Array> = {};

		// Snapshot the tip before reading rows. A concurrent write can then cause
		// at worst an extra inbox fetch, never a missing file hidden behind the tip.
		const revision = await this.getTipRevision();
		const files = await sql<{ file_path: string; content: Buffer | null }[]>`
			SELECT file_path, content FROM files
			WHERE file_is_deleted = FALSE AND content IS NOT NULL
		`;
		this.logger.info("client_archive.files_loaded", {
			fileCount: files.length,
			revision,
		});
		for (const file of files) {
			if (file.file_path === CLIENT_DATA_PATH) continue;
			const canonicalPath = canonicalizePath(file.file_path);
			entries[canonicalPath] = new Uint8Array(file.content as Buffer);
		}

		await addPluginToArchive(entries);
		const clientConfig: ClientConfig = {
			clientName: options.clientName,
			clientSecret: options.clientSecret,
			revision,
			serverUrl: options.serverUrl,
		};
		entries[CLIENT_DATA_PATH] = new TextEncoder().encode(
			JSON.stringify(clientConfig, null, 2),
		);
		const archive = zipSync(entries, { level: 6 });
		this.logger.info("client_archive.completed", {
			fileCount: files.length,
			revision,
			bytes: archive.byteLength,
			durationMs: Date.now() - startedAt,
		});
		return archive;
    }

    async client_zip_create(
		path: string,
		serverUrl = "http://localhost:3000",
    ): Promise<void> {
		this.logger.info("client_zip.started", { outputPath: path, serverUrl });
		const clientName = `client-${crypto.randomUUID()}`;
		const [client] = await sql<{ id: string; client_secret: string }[]>`
			INSERT INTO clients (client_name)
			VALUES (${clientName})
			RETURNING id, client_secret
		`;
		try {
			const archive = await this.createClientArchive({
				serverUrl,
				clientName,
				clientSecret: client.client_secret,
			});
			await Bun.write(path, archive);
			this.logger.info("client_zip.completed", {
				outputPath: path,
				bytes: archive.byteLength,
			});
		} catch (error) {
			this.logger.error("client_zip.failed", {
				outputPath: path,
				error,
			});
			await sql`DELETE FROM clients WHERE id = ${client.id}`.catch(() => undefined);
			throw error;
		}
    }

    // to create the client inbox
    async inbox(rev: number): Promise<ObjectStoreOutboxItem[]> {
		const startedAt = Date.now();
		this.logger.debug("inbox.started", { revision: rev });
        const result = await sql<{ file_path: string; last_updated_revision: string; file_is_deleted: boolean }[]>`
            SELECT file_path, last_updated_revision, file_is_deleted FROM files
            WHERE last_updated_revision > ${rev}
            ORDER BY last_updated_revision ASC
        `;
        const items = result.map((r: { file_path: string; last_updated_revision: string; file_is_deleted: boolean }) => ({
            path: r.file_path,
            lastUpdatedRevision: Number(r.last_updated_revision),
            isDeleted: r.file_is_deleted,
        }));
		this.logger.info("inbox.completed", {
			revision: rev,
			operationCount: items.length,
			tipRevision: items.at(-1)?.lastUpdatedRevision ?? rev,
			durationMs: Date.now() - startedAt,
		});
		return items;
    }
}

export const objectStore = new ObjectStore();

/**
 * Resolves the file path for a request, decoding exactly once regardless of source:
 * query params are already percent-decoded by the URL parser, headers are not.
 */
function resolvePathFromRequest(c: Context): string | undefined {
    const queryPath = c.req.query("path");
    if (queryPath !== undefined) {
        return queryPath;
    }
    const headerPath = c.req.header("X-Obsidian-Path");
    if (headerPath === undefined) {
        return undefined;
    }
	try {
		return decodeURIComponent(headerPath);
	} catch (error) {
		if (error instanceof URIError) {
			throw new InvalidPathError(headerPath, "malformed percent encoding");
		}
		throw error;
	}
}

export function registerObjectStoreRoutes(
	app: Hono,
	store = objectStore,
	authorize: ClientAuthorizer = getClientIdFromAuthorization,
	injectedLogger: Logger = serverLogger,
) {
	const logger = injectedLogger.child("object_routes");
    // Chain so Hono accumulates route types (needed by testClient inference).
    return app
        .post('/files', async (c) => {
			let path: string | undefined;
			try {
				path = resolvePathFromRequest(c);
			} catch (error) {
				if (error instanceof InvalidPathError) {
					logger.warn("upload.rejected", {
						reason: "invalid_path",
						error,
					});
					return c.json({ error: "Invalid path" }, 400);
				}
				throw error;
			}
            if (!path) {
				logger.warn("upload.rejected", { reason: "path_missing" });
                return c.json({ error: "Request body is required" }, 400);
            }
			const authorized = await requireClientId(c, authorize, logger);
			if (authorized instanceof Response) {
				logger.warn("upload.rejected", {
					path,
					reason: "unauthorized",
				});
				return authorized;
			}
            const clientId = authorized;
            try {
				const body = await c.req.arrayBuffer();
				logger.info("upload.accepted", {
					path,
					clientId,
					bytes: body.byteLength,
				});
                const result = await store.upload({
                    path: path,
                    content: body,
                    id: clientId
                });
				logger.info("upload.completed", {
					path: result.path,
					clientId,
					bytes: result.bytesWritten,
					revision: result.revision,
				});
                return c.json(result, 200);
            } catch (error) {
                if (error instanceof InvalidPathError) {
					logger.warn("upload.rejected", {
						path,
						clientId,
						reason: "invalid_path",
						error,
					});
                    return c.json({ error: "Invalid path" }, 400);
                }
				logger.error("upload.failed", { path, clientId, error });
                throw error;
            }
        })
        .get('/inbox', async (c) => {
			const authorized = await requireClientId(c, authorize, logger);
			if (authorized instanceof Response) {
				logger.warn("inbox.rejected", { reason: "unauthorized" });
				return authorized;
			}
			const rawRev = c.req.query("rev");
			const parsedRev =
				rawRev === undefined || rawRev.trim() === ""
					? { success: false as const }
					: revisionSchema.safeParse(Number(rawRev));
			if (!parsedRev.success) {
				logger.warn("inbox.rejected", {
					clientId: authorized,
					reason: "invalid_revision",
					rawRevision: rawRev,
				});
				return c.json({ error: "rev must be a safe nonnegative integer" }, 400);
			}
            const rev = parsedRev.data;
			logger.debug("inbox.accepted", {
				clientId: authorized,
				revision: rev,
			});
            const inbox = await store.inbox(rev);
            const ops: InboxOp[] = inbox.map((item) => ({
                rev: item.lastUpdatedRevision,
                op: item.isDeleted ? "delete" : "put",
                path: item.path,
            }));
            const body = serializeInboxNdjson(ops);
			logger.info("inbox.completed", {
				clientId: authorized,
				revision: rev,
				operationCount: ops.length,
				bytes: body.length,
			});
            return new Response(body, {
                status: 200,
                headers: { "Content-Type": "application/x-ndjson" },
            });
        })
        .get('/files', async (c) => {
			const authorized = await requireClientId(c, authorize, logger);
			if (authorized instanceof Response) {
				logger.warn("download.rejected", { reason: "unauthorized" });
				return authorized;
			}
			let path: string | undefined;
			try {
				path = resolvePathFromRequest(c);
			} catch (error) {
				if (error instanceof InvalidPathError) {
					logger.warn("download.rejected", {
						clientId: authorized,
						reason: "invalid_path",
						error,
					});
					return c.json({ error: "Invalid path" }, 400);
				}
				throw error;
			}
            if (!path) {
				logger.warn("download.rejected", {
					clientId: authorized,
					reason: "path_missing",
				});
                return c.json({ error: "path is required" }, 400);
            }

            try {
                const data = await store.download(path);
                if (!data) {
					logger.warn("download.not_found", {
						path,
						clientId: authorized,
					});
                    return c.json({ error: "Not found" }, 404);
                }
				logger.info("download.completed", {
					path,
					clientId: authorized,
					bytes: data.byteLength,
				});
                return new Response(data, {
                    status: 200,
                    headers: { "Content-Type": "application/octet-stream" },
                });
            } catch (error) {
                if (error instanceof InvalidPathError) {
					logger.warn("download.rejected", {
						path,
						clientId: authorized,
						reason: "invalid_path",
						error,
					});
                    return c.json({ error: "Invalid path" }, 400);
                }
				logger.error("download.failed", {
					path,
					clientId: authorized,
					error,
				});
                throw error;
            }
        })
        .delete('/files', async (c) => {
			const authorized = await requireClientId(c, authorize, logger);
			if (authorized instanceof Response) {
				logger.warn("delete.rejected", { reason: "unauthorized" });
				return authorized;
			}
			let path: string | undefined;
			try {
				path = resolvePathFromRequest(c);
			} catch (error) {
				if (error instanceof InvalidPathError) {
					logger.warn("delete.rejected", {
						clientId: authorized,
						reason: "invalid_path",
						error,
					});
					return c.json({ error: "Invalid path" }, 400);
				}
				throw error;
			}
            if (!path) {
				logger.warn("delete.rejected", {
					clientId: authorized,
					reason: "path_missing",
				});
                return c.json({ error: "path is required" }, 400);
            }
            try {
                const clientId = authorized;
                const rawBaseRevision = c.req.header("X-Obsidian-Base-Revision");
                const parsedBaseRevision =
                    rawBaseRevision === undefined
                        ? { success: true as const, data: undefined }
                        : rawBaseRevision.trim() === ""
                            ? { success: false as const }
                            : revisionSchema.safeParse(Number(rawBaseRevision));
                if (!parsedBaseRevision.success) {
					logger.warn("delete.rejected", {
						path,
						clientId,
						reason: "invalid_base_revision",
						rawBaseRevision,
					});
                    return c.json(
                        { error: "base revision must be a safe nonnegative integer" },
                        400,
                    );
                }
                const result = await store.delete(
                    path,
                    clientId,
                    parsedBaseRevision.data,
                );
				const response: DeleteResponse = {
					path,
					revision: result.revision,
				};
				logger.info("delete.completed", {
					path,
					clientId,
					baseRevision: parsedBaseRevision.data,
					revision: result.revision,
				});
                return c.json(response, 200);
            } catch (error) {
                if (error instanceof InvalidPathError) {
					logger.warn("delete.rejected", {
						path,
						clientId: authorized,
						reason: "invalid_path",
						error,
					});
                    return c.json({ error: "Invalid path" }, 400);
                }
                if (error instanceof Error && error.message === "Invalid authorization") {
					logger.warn("delete.rejected", {
						path,
						reason: "unauthorized",
					});
                    return c.json({ error: "Unauthorized" }, 401);
                }
				logger.error("delete.failed", {
					path,
					clientId: authorized,
					error,
				});
                throw error;
            }
        });
}
