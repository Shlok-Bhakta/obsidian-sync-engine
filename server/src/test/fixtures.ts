import { sql } from "bun";
import { Hono } from "hono";
import { registerObjectStoreRoutes } from "../object/object_store";

export function createTestApp() {
	return registerObjectStoreRoutes(new Hono());
}

export type ClientRow = {
	id: string;
	client_name: string;
	client_secret: string;
	created_at: Date;
	updated_at: Date;
};

export type FileRow = {
	id: string;
	file_path: string;
	last_updated_revision: string;
	file_is_deleted: boolean;
	author_id: string;
	content: Buffer | null;
	created_at: Date;
	updated_at: Date;
};

/** Insert a client row. Defaults to a unique name and DB-generated secret. */
export async function createClientFixture(
	overrides: Partial<{
		client_name: string;
		client_secret: string;
	}> = {},
): Promise<ClientRow> {
	const client_name = overrides.client_name ?? `client-${crypto.randomUUID()}`;

	if (overrides.client_secret !== undefined) {
		const [row] = await sql<ClientRow[]>`
			INSERT INTO clients (client_name, client_secret)
			VALUES (${client_name}, ${overrides.client_secret})
			RETURNING *
		`;
		return row;
	}

	const [row] = await sql<ClientRow[]>`
		INSERT INTO clients (client_name)
		VALUES (${client_name})
		RETURNING *
	`;
	return row;
}

/** Insert a file row. Requires an existing `author_id` (use createClientFixture). */
export async function createFileFixture(overrides: {
	file_path: string;
	author_id: string;
	file_is_deleted?: boolean;
}): Promise<FileRow> {
	const file_is_deleted = overrides.file_is_deleted ?? false;
	const [row] = await sql<FileRow[]>`
		INSERT INTO files (file_path, author_id, file_is_deleted)
		VALUES (${overrides.file_path}, ${overrides.author_id}, ${file_is_deleted})
		RETURNING *
	`;
	return row;
}
