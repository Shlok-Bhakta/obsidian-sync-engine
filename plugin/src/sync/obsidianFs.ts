import {
	normalizePath,
	TFile,
	type DataAdapter,
	type Vault,
} from "obsidian";
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
	 * Exact inbound path/operation tokens suppress only the Vault event caused
	 * by applying that same remote mutation. Unrelated user edits remain live.
	 */
	private readonly inboundEvents = new Map<
		string,
		{ operation: "put" | "delete"; timeout: ReturnType<typeof setTimeout> }
	>();

	constructor(
		private readonly adapter: DataAdapter,
		private readonly vault?: Vault,
	) {}

	consumeInboundEvent(path: string, operation: "put" | "delete"): boolean {
		const normalized = normalizePath(path);
		const expected = this.inboundEvents.get(normalized);
		if (expected?.operation !== operation) {
			return false;
		}
		clearTimeout(expected.timeout);
		this.inboundEvents.delete(normalized);
		return true;
	}

	private expectInboundEvent(path: string, operation: "put" | "delete"): void {
		const previous = this.inboundEvents.get(path);
		if (previous) clearTimeout(previous.timeout);
		const timeout = setTimeout(() => {
			const expected = this.inboundEvents.get(path);
			if (expected?.timeout === timeout) this.inboundEvents.delete(path);
		}, 5000);
		this.inboundEvents.set(path, { operation, timeout });
	}

	async read(path: string): Promise<string> {
		const normalized = normalizePath(path);
		await this.recoverJournal(normalized);
		return this.adapter.read(normalized);
	}

	async write(path: string, data: string): Promise<void> {
		const normalized = normalizePath(path);
		await this.ensureParentDir(normalized);
		await this.recoverJournal(normalized);
		const tmpPath = `${normalized}.tmp`;
		const backupPath = `${normalized}.bak`;
		if (await this.adapter.exists(tmpPath)) await this.adapter.remove(tmpPath);
		if (await this.adapter.exists(backupPath)) await this.adapter.remove(backupPath);
		await this.adapter.write(tmpPath, data);
		if (await this.adapter.exists(normalized)) {
			await this.adapter.rename(normalized, backupPath);
		}
		await this.adapter.rename(tmpPath, normalized);
		if (await this.adapter.exists(backupPath)) {
			await this.adapter.remove(backupPath);
		}
	}

	async append(path: string, data: string): Promise<void> {
		const normalized = normalizePath(path);
		await this.ensureParentDir(normalized);
		await this.recoverJournal(normalized);
		await this.adapter.append(normalized, data);
	}

	async exists(path: string): Promise<boolean> {
		const normalized = normalizePath(path);
		return (
			(await this.adapter.exists(normalized)) ||
			(await this.adapter.exists(`${normalized}.bak`))
		);
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		return this.adapter.readBinary(normalizePath(path));
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const normalized = normalizePath(path);
		if (!this.vault) {
			await this.ensureParentDir(normalized);
			await this.adapter.writeBinary(normalized, data);
			return;
		}
		this.expectInboundEvent(normalized, "put");
		const existing = this.vault.getAbstractFileByPath(normalized);
		if (existing instanceof TFile) {
			await this.vault.modifyBinary(existing, data);
			return;
		}
		await this.ensureVaultParentDir(normalized);
		await this.vault.createBinary(normalized, data);
	}

	async remove(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (this.vault) {
			const existing = this.vault.getAbstractFileByPath(normalized);
			if (!existing) return;
			this.expectInboundEvent(normalized, "delete");
			// A remote tombstone must not create a new synced file in `.trash`.
			// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file
			await this.vault.delete(existing, true);
			return;
		}
		if (await this.adapter.exists(normalized)) {
			await this.adapter.remove(normalized);
		}
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

	private async recoverJournal(normalizedPath: string): Promise<void> {
		if (await this.adapter.exists(normalizedPath)) return;
		const backupPath = `${normalizedPath}.bak`;
		if (await this.adapter.exists(backupPath)) {
			await this.adapter.rename(backupPath, normalizedPath);
		}
	}

	private async ensureVaultParentDir(normalizedPath: string): Promise<void> {
		if (!this.vault) return;
		for (const dir of ancestorDirs(normalizedPath)) {
			if (!this.vault.getAbstractFileByPath(dir)) {
				await this.vault.createFolder(dir);
			}
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
