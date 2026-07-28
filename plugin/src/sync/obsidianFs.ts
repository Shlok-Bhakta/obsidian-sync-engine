import { normalizePath, type DataAdapter } from "obsidian";
import type { VaultBlobFs } from "./engine";

/**
 * VaultBlobFs backed by Obsidian's `app.vault.adapter`. All reads/writes go
 * straight to the vault's own storage (disk or the mobile file adapter) —
 * never IndexedDB — so outbox/inbox/data survive alongside the notes they
 * describe.
 */
export class ObsidianFs implements VaultBlobFs {
	constructor(private readonly adapter: DataAdapter) {}

	async read(path: string): Promise<string> {
		return this.adapter.read(normalizePath(path));
	}

	async write(path: string, data: string): Promise<void> {
		await this.adapter.write(normalizePath(path), data);
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
		await this.adapter.writeBinary(normalizePath(path), data);
	}

	async remove(path: string): Promise<void> {
		await this.adapter.remove(normalizePath(path));
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
}
