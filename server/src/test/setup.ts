import { afterAll, afterEach, beforeAll, beforeEach } from "bun:test";
import { bootstrapDB } from "../db/MigrationRunner";
import { cleanDatabase, cleanObjectStore, deleteObjectStore } from "./cleanForTests";

beforeAll(async () => {
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
