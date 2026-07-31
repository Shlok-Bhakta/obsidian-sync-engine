import { describe, it, expect } from "bun:test";
import { sql } from "bun";
import { createClientFixture, createFileFixture } from "./fixtures";

describe("db fixtures", () => {
	it("starts each test with empty tables", async () => {
		const clients = await sql`SELECT count(*)::int AS count FROM clients`;
		const files = await sql`SELECT count(*)::int AS count FROM files`;
		expect(clients[0].count).toBe(0);
		expect(files[0].count).toBe(0);
	});

	it("createClientFixture inserts a client", async () => {
		const client = await createClientFixture({ client_name: "alice" });
		expect(client.client_name).toBe("alice");
		expect(client.client_secret).toStartWith("obs_sync_");

		const rows = await sql`SELECT * FROM clients`;
		expect(rows).toHaveLength(1);
	});

	it("createFileFixture inserts a file for an author", async () => {
		const client = await createClientFixture();
		const file = await createFileFixture({
			file_path: "notes/hello.md",
			author_id: client.id,
		});

		expect(file.file_path).toBe("notes/hello.md");
		expect(file.author_id).toBe(client.id);
		expect(file.file_is_deleted).toBe(false);
	});

	it("rejects active files without database content", async () => {
		const client = await createClientFixture();
		let error: unknown;

		try {
			await sql`
				INSERT INTO files (file_path, author_id, file_is_deleted, content)
				VALUES ('missing.md', ${client.id}, FALSE, NULL)
			`;
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
	});
});
