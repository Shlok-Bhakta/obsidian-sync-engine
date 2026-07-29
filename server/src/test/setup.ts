import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { bootstrapDB } from "../db/MigrationRunner";
import { cleanDatabase, cleanObjectStore, deleteObjectStore } from "./cleanForTests";

beforeAll(async () => {
	process.env.PUBLIC_SERVER_URL ??= "http://localhost:3000";
	process.env.BOOTSTRAP_TOKEN ??= "test-bootstrap-token";
	await bootstrapDB();
	await cleanObjectStore();
});

beforeEach(async () => {
	await cleanDatabase();
});

afterEach(async () => {
	await cleanObjectStore();
});

afterAll(async () => {
	await deleteObjectStore();
});
