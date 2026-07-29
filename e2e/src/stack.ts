import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { waitFor } from "./wait";
import { CONTAINER_BIN, hostGateway } from "./container";

const REPO_ROOT = join(import.meta.dir, "../..");
const SERVER_DIR = join(REPO_ROOT, "server");
const COMPOSE_FILE = join(REPO_ROOT, "compose.yaml");

export type Stack = {
	databaseUrl: string;
	/** URL Obsidian containers should use (host gateway). */
	serverUrl: string;
	/** URL the harness uses (localhost). */
	serverUrlLocal: string;
	serverPort: number;
	objectStoreDir: string;
	runDir: string;
	/** Admin token required for GET /bootstrap.zip. */
	bootstrapToken: string;
	stopServer: () => Promise<void>;
};

function composeCommand(args: string[]): string[] {
	return [CONTAINER_BIN, "compose", ...args];
}

async function freePort(): Promise<number> {
	const server = Bun.listen({
		hostname: "0.0.0.0",
		port: 0,
		socket: { data() {} },
	});
	const { port } = server;
	server.stop(true);
	return port;
}

async function waitPostgres(databaseUrl: string): Promise<void> {
	await waitFor(
		async () => {
			try {
				const sql = new Bun.SQL(databaseUrl);
				await sql`SELECT 1`;
				await sql.close();
				return true;
			} catch {
				return false;
			}
		},
		{ timeoutMs: 60_000, intervalMs: 500, label: "postgres ready" },
	);
}

export async function wipeTestDatabase(databaseUrl: string): Promise<void> {
	if (!databaseUrl.includes("test_db")) {
		throw new Error("Refusing to wipe non-test database");
	}
	const sql = new Bun.SQL(databaseUrl);
	await sql.unsafe(`
		DO $$ DECLARE r RECORD;
		BEGIN
		  FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'migrations') LOOP
		    EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
		  END LOOP;
		  FOR r IN (
		    SELECT c.relname AS sequencename
		    FROM pg_class c
		    JOIN pg_namespace n ON n.oid = c.relnamespace
		    WHERE c.relkind = 'S' AND n.nspname = 'public' AND c.relname <> 'migrations_id_seq'
		  ) LOOP
		    EXECUTE format('ALTER SEQUENCE %I RESTART WITH 1', r.sequencename);
		  END LOOP;
		END $$;
	`);
	await sql.close();
}

async function spawnServer(opts: {
	databaseUrl: string;
	objectStoreDir: string;
	serverPort: number;
	bootstrapToken: string;
}): Promise<{ stop: () => Promise<void>; localUrl: string; containerUrl: string }> {
	const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
		cwd: SERVER_DIR,
		env: {
			...process.env,
			DATABASE_URL: opts.databaseUrl,
			OBJECT_STORE_DIR: opts.objectStoreDir,
			PORT: String(opts.serverPort),
			HOST: "0.0.0.0",
			BOOTSTRAP_TOKEN: opts.bootstrapToken,
			PUBLIC_SERVER_URL: `http://${hostGateway()}:${opts.serverPort}`,
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	const localUrl = `http://127.0.0.1:${opts.serverPort}`;
	await waitFor(
		async () => {
			try {
				const res = await fetch(localUrl + "/");
				return res.ok;
			} catch {
				return false;
			}
		},
		{ timeoutMs: 30_000, label: "sync server ready" },
	);

	return {
		localUrl,
		containerUrl: `http://${hostGateway()}:${opts.serverPort}`,
		stop: async () => {
			proc.kill();
			await proc.exited.catch(() => undefined);
		},
	};
}

/**
 * Bring up test-db via compose (unless E2E_SKIP_COMPOSE=1) and a sync server
 * on a free port. Pass `wipe: false` to keep existing rows (offline reconnect).
 */
export async function startStack(options: { wipe?: boolean; reuse?: Stack } = {}): Promise<Stack> {
	const wipe = options.wipe ?? true;

	if (process.env.E2E_SKIP_COMPOSE !== "1") {
		const compose = Bun.spawn(
			composeCommand(["-f", COMPOSE_FILE, "up", "-d", "test-db"]),
			{ cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
		);
		await compose.exited;
	}

	const databaseUrl =
		process.env.E2E_DATABASE_URL ??
		"postgres://postgres:postgres@localhost:5434/test_db";
	await waitPostgres(databaseUrl);

	let runDir: string;
	let objectStoreDir: string;
	let serverPort: number;

	if (options.reuse) {
		runDir = options.reuse.runDir;
		objectStoreDir = options.reuse.objectStoreDir;
		serverPort = options.reuse.serverPort;
		await options.reuse.stopServer().catch(() => undefined);
	} else {
		runDir = join(REPO_ROOT, "e2e", ".run", `run-${Date.now()}`);
		await mkdir(runDir, { recursive: true });
		objectStoreDir = join(runDir, "object-store");
		await mkdir(objectStoreDir, { recursive: true });
		serverPort = await freePort();
	}

	if (wipe) {
		await wipeTestDatabase(databaseUrl);
		await rm(objectStoreDir, { recursive: true, force: true });
		await mkdir(objectStoreDir, { recursive: true });
	}

	const bootstrapToken =
		process.env.E2E_BOOTSTRAP_TOKEN ?? "e2e-bootstrap-token";

	const server = await spawnServer({
		databaseUrl,
		objectStoreDir,
		serverPort,
		bootstrapToken,
	});

	return {
		databaseUrl,
		serverUrl: server.containerUrl,
		serverUrlLocal: server.localUrl,
		serverPort,
		objectStoreDir,
		runDir,
		bootstrapToken,
		stopServer: server.stop,
	};
}
