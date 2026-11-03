import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { SyncEngine, type VaultBlobFs } from "../../plugin/src/sync/engine";
import { HttpTransport } from "../../plugin/src/sync/httpTransport";
import type { HttpRequestFn } from "../../plugin/src/http";

const STATE_DIR = ".obsidian/plugins/obsidian-sync-engine/state/interop";

class NodeVaultFs implements VaultBlobFs {
	constructor(private readonly root: string) {}

	private full(path: string): string {
		return join(this.root, path);
	}

	async read(path: string): Promise<string> {
		return readFile(this.full(path), "utf8");
	}

	async write(path: string, data: string): Promise<void> {
		await mkdir(dirname(this.full(path)), { recursive: true });
		await writeFile(this.full(path), data);
	}

	async append(path: string, data: string): Promise<void> {
		await mkdir(dirname(this.full(path)), { recursive: true });
		await appendFile(this.full(path), data);
	}

	async exists(path: string): Promise<boolean> {
		return stat(this.full(path)).then(
			() => true,
			() => false,
		);
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const bytes = await readFile(this.full(path));
		return bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer;
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const target = this.full(path);
		// ObsidianFs replaces a file ancestor or an empty folder at the target.
		const segments = path.split("/").slice(0, -1);
		let current = this.root;
		for (const segment of segments) {
			current = join(current, segment);
			const existing = await stat(current).catch(() => null);
			if (existing?.isFile()) await rm(current);
			if (!existing?.isDirectory()) await mkdir(current);
		}
		const existing = await stat(target).catch(() => null);
		if (existing?.isDirectory()) await rm(target, { recursive: true });
		await writeFile(target, new Uint8Array(data));
	}

	async remove(path: string): Promise<void> {
		await rm(this.full(path), { recursive: true, force: true });
	}

	async listAllFiles(): Promise<string[]> {
		const entries = await readdir(this.root, { recursive: true, withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile())
			.map((entry) => relative(this.root, join(entry.parentPath, entry.name)));
	}
}

const request: HttpRequestFn = async (params) => {
	const response = await fetch(params.url, {
		method: params.method ?? "GET",
		headers: {
			...(params.contentType ? { "Content-Type": params.contentType } : {}),
			...params.headers,
		},
		body: params.body as BodyInit | undefined,
		signal: AbortSignal.timeout(30_000),
	});
	const arrayBuffer = await response.arrayBuffer();
	const text = new TextDecoder().decode(arrayBuffer);
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	return {
		status: response.status,
		headers: Object.fromEntries(response.headers),
		arrayBuffer,
		text,
		json,
	};
};

/**
 * The plugin's real SyncEngine and HttpTransport on a directory, without the
 * Obsidian renderer. Callers report local changes the way vault events do.
 */
export class HeadlessPluginClient {
	revision = 0;
	readonly engine: SyncEngine;

	constructor(
		readonly vaultDir: string,
		serverUrl: string,
		secret: string,
	) {
		this.engine = new SyncEngine({
			fs: new NodeVaultFs(vaultDir),
			transport: new HttpTransport({
				getServerUrl: () => serverUrl,
				getAuthorization: () => secret,
				request,
			}),
			outboxPath: `${STATE_DIR}/outbox.jsonl`,
			inboxPath: `${STATE_DIR}/inbox.jsonl`,
			deadLetterPath: `${STATE_DIR}/dead-letter.jsonl`,
			getRevision: () => this.revision,
			setRevision: (revision) => {
				this.revision = revision;
			},
			debounceMs: 60_000,
		});
	}

	async write(path: string, content: string | Uint8Array): Promise<void> {
		const target = join(this.vaultDir, path);
		await mkdir(dirname(target), { recursive: true });
		await writeFile(target, content);
		await this.engine.enqueueDurable(path, "put");
	}

	async delete(path: string): Promise<void> {
		await rm(join(this.vaultDir, path), { force: true });
		await this.engine.enqueueDurable(path, "delete");
	}

	async tick(): Promise<void> {
		const result = await this.engine.tick();
		if (!result.ok) throw new Error(result.error);
	}

	/** Settles pending work, leaving only the engine's disarmed debounce timer. */
	async stop(): Promise<void> {
		await this.engine.quiesce();
	}
}
