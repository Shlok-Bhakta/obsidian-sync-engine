import { describe, it, expect } from "bun:test";
import { sql } from "bun";
import { createClientFixture, createFileFixture } from "./fixtures";
import { Glob } from "bun";
import { DEFAULT_OBJECT_STORE_DIR } from "../object/object_store";

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

	it("starts each test with an empty object store", async () => {
		const glob = new Glob("**/*");
		const hasFiles = !glob.scanSync({ cwd: DEFAULT_OBJECT_STORE_DIR }).next().done;
		expect(hasFiles).toBe(false);
	});

	
});
