import { beforeAll, beforeEach } from "bun:test";
import { bootstrapDB } from "../db/MigrationRunner";
import { cleanDatabase } from "./cleanForTests";

beforeAll(async () => {
	await bootstrapDB();
});

beforeEach(async () => {
	await cleanDatabase();
});
