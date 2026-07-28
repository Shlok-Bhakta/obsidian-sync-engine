import { normalizePath, type DataAdapter } from "obsidian";
import type { VaultBlobFs } from "./engine";
import { ancestorDirs } from "./paths";

/**
 * VaultBlobFs backed by Obsidian's `app.vault.adapter`. All reads/writes go
 * straight to the vault's own storage (disk or the mobile file adapter) —
 * never IndexedDB — so outbox/inbox/data survive alongside the notes they
 * describe.
 */
export class ObsidianFs implements VaultBlobFs {
	/**
	 * Depth counter, >0 while a write/writeBinary/remove call made *through
	 * this instance* is in flight (including nested/concurrent calls).
	 * Callers that detect local vault edits check `isWriting` to avoid
	 * re-enqueueing a write that originated here — e.g. the sync engine
	 * applying a remote put/delete — which would otherwise loop it straight
	 * back out.
	 */
	private writeDepth = 0;

	constructor(private readonly adapter: DataAdapter) {}

	get isWriting(): boolean {
		return this.writeDepth > 0;
	}

	private async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
		this.writeDepth++;
		try {
			return await fn();
		} finally {
			this.writeDepth--;
		}
	}

	async read(path: string): Promise<string> {
		return this.adapter.read(normalizePath(path));
	}

	async write(path: string, data: string): Promise<void> {
		const normalized = normalizePath(path);
		await this.trackWrite(async () => {
			await this.ensureParentDir(normalized);
			await this.adapter.write(normalized, data);
		});
	}

	async exists(path: string): Promise<boolean> {
		return this.adapter.exists(normalizePath(path));
	}

	async mkdir(path: string): Promise<void> {
		await this.adapter.mkdir(normalizePath(path));
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		return this.adapter.readBinary(normalizePath(path));
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const normalized = normalizePath(path);
		await this.trackWrite(async () => {
			await this.ensureParentDir(normalized);
			await this.adapter.writeBinary(normalized, data);
		});
	}

	async remove(path: string): Promise<void> {
		const normalized = normalizePath(path);
		await this.trackWrite(async () => {
			// Idempotent: applying a remote delete for a path already gone
			// locally (or retried after a partial failure) should be a no-op,
			// not an error.
			if (!(await this.adapter.exists(normalized))) {
				return;
			}
			await this.adapter.remove(normalized);
		});
	}

	/** Recursively lists every file path in the vault, mirroring the old main.ts `listVaultFiles`. */
	async listAllFiles(): Promise<string[]> {
		return this.listFilesUnder("");
	}

	private async listFilesUnder(folderPath: string): Promise<string[]> {
		const listed = await this.adapter.list(folderPath);
		const nested = await Promise.all(
			listed.folders.map((childFolderPath) =>
				this.listFilesUnder(childFolderPath),
			),
		);
		return [...listed.files, ...nested.flat()];
	}

	/**
	 * Ensures every ancestor directory of `normalizedPath` exists, creating
	 * them one level at a time from the root down. `DataAdapter.mkdir` is NOT
	 * recursive, so for `a/b/c.md` this must `mkdir("a")` before `mkdir("a/b")`
	 * — creating `a/b` first would fail because `a` doesn't exist yet.
	 */
	private async ensureParentDir(normalizedPath: string): Promise<void> {
		for (const dir of ancestorDirs(normalizedPath)) {
			await this.ensureDir(dir);
		}
	}

	private async ensureDir(path: string): Promise<void> {
		if (await this.adapter.exists(path)) {
			return;
		}
		try {
			await this.adapter.mkdir(path);
		} catch (error) {
			// Another writer may have created it concurrently; only surface the
			// error if the directory still doesn't exist.
			if (!(await this.adapter.exists(path))) {
				throw error;
			}
		}
	}
}
