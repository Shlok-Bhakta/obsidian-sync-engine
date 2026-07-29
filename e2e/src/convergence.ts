import type { ObsidianClient, ClientDiagnostics } from "./obsidian-client";
import type { Stack } from "./stack";
import { waitFor } from "./wait";

export type SyncSnapshot = {
	revision: number;
	files: Record<string, string>;
};

type ConvergenceState = {
	server: SyncSnapshot;
	clients: Array<{
		name: string;
		diagnostics: ClientDiagnostics;
		files: Record<string, string>;
	}>;
};

/** Read authoritative live bytes and the global tip in one database snapshot. */
export async function readServerSnapshot(stack: Stack): Promise<SyncSnapshot> {
	const database = new Bun.SQL(stack.databaseUrl);
	try {
		const rows = await database<
			Array<{
				file_path: string;
				content: Uint8Array | null;
				file_is_deleted: boolean;
				last_updated_revision: string | number;
			}>
		>`
			SELECT file_path, content, file_is_deleted, last_updated_revision
			FROM files
			ORDER BY file_path
		`;
		let revision = 0;
		const files: Record<string, string> = {};
		for (const row of rows) {
			revision = Math.max(revision, Number(row.last_updated_revision));
			if (!row.file_is_deleted && row.content !== null) {
				files[row.file_path] = Buffer.from(row.content).toString("base64");
			}
		}
		return { revision, files };
	} finally {
		await database.close();
	}
}

function describeMismatch(state: ConvergenceState): string {
	const serverPaths = Object.keys(state.server.files);
	return state.clients
		.map(({ name, diagnostics, files }) => {
			const missing = serverPaths.filter((path) => files[path] === undefined);
			const extra = Object.keys(files).filter(
				(path) => state.server.files[path] === undefined,
			);
			const different = serverPaths.filter(
				(path) =>
					files[path] !== undefined &&
					files[path] !== state.server.files[path],
			);
			return JSON.stringify({
				name,
				diagnostics,
				missing,
				extra,
				different,
			});
		})
		.join("; ");
}

function filesEqual(
	left: Record<string, string>,
	right: Record<string, string>,
): boolean {
	const leftPaths = Object.keys(left).sort();
	const rightPaths = Object.keys(right).sort();
	return (
		JSON.stringify(leftPaths) === JSON.stringify(rightPaths) &&
		leftPaths.every((path) => left[path] === right[path])
	);
}

function stableSignature(state: ConvergenceState): string {
	return JSON.stringify({
		revision: state.server.revision,
		files: Object.entries(state.server.files).sort(([left], [right]) =>
			left.localeCompare(right),
		),
		clients: state.clients.map(({ name, diagnostics }) => ({
			name,
			diagnostics,
		})),
	});
}

/**
 * Drive every client until all queues are empty and all vault bytes match the
 * server, then require the exact same healthy snapshot for several rounds.
 * Repeated stability catches late debounced work without using sleeps as a
 * correctness gate.
 */
export async function waitForStableConvergence(
	clients: readonly ObsidianClient[],
	stack: Stack,
	options: {
		timeoutMs?: number;
		stableRounds?: number;
		label?: string;
	} = {},
): Promise<ConvergenceState> {
	const requiredStableRounds = options.stableRounds ?? 3;
	let previousSignature: string | null = null;
	let stableRounds = 0;

	return waitFor(
		async () => {
			await Promise.all(clients.map((client) => client.forceTick()));
			const [server, ...clientStates] = await Promise.all([
				readServerSnapshot(stack),
				...clients.map(async (client) => ({
					name: client.name,
					diagnostics: await client.diagnostics(),
					files: await client.snapshotFiles(),
				})),
			]);
			const state: ConvergenceState = {
				server,
				clients: clientStates as ConvergenceState["clients"],
			};
			const healthy = state.clients.every(
				({ diagnostics, files }) =>
					diagnostics.revision === server.revision &&
					diagnostics.outboxDepth === 0 &&
					diagnostics.inboxDepth === 0 &&
					diagnostics.lastError === null &&
					filesEqual(files, server.files),
			);
			if (!healthy) {
				previousSignature = null;
				stableRounds = 0;
				throw new Error(describeMismatch(state));
			}

			const signature = stableSignature(state);
			stableRounds =
				signature === previousSignature ? stableRounds + 1 : 1;
			previousSignature = signature;
			return stableRounds >= requiredStableRounds ? state : false;
		},
		{
			timeoutMs: options.timeoutMs ?? 120_000,
			intervalMs: 300,
			label: options.label ?? "stable byte-identical client convergence",
		},
	);
}

/**
 * A bootstrap client starts at the server tip and must remain read-only until
 * the user actually changes its vault.
 */
export async function assertBootstrapIsReadOnly(
	client: ObsidianClient,
	stack: Stack,
	expected: SyncSnapshot,
): Promise<void> {
	await waitForStableConvergence([client], stack, {
		timeoutMs: 45_000,
		stableRounds: 4,
		label: `${client.name} bootstrap startup without outbound writes`,
	});
	const after = await readServerSnapshot(stack);
	if (
		after.revision !== expected.revision ||
		!filesEqual(after.files, expected.files)
	) {
		throw new Error(
			`${client.name} changed server state during bootstrap: expected revision ` +
				`${expected.revision}, got ${after.revision}`,
		);
	}
}
