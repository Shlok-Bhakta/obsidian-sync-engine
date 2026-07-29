import {
	normalizePath,
	TFile,
	TFolder,
	type DataAdapter,
	type Vault,
} from "obsidian";
import type { VaultBlobFs } from "./engine";
import {
	InboundEventSuppressor,
	type InboundEvent,
} from "./inboundEventSuppressor";
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
	private readonly inboundEvents = new InboundEventSuppressor();

	constructor(
		private readonly adapter: DataAdapter,
		private readonly vault?: Vault,
	) {}

	consumeInboundEvent(path: string, event: InboundEvent): boolean {
		const normalized = normalizePath(path);
		return this.inboundEvents.consume(normalized, event);
	}

	private expectInboundEvent(path: string, ...events: InboundEvent[]): void {
		this.inboundEvents.expect(path, ...events);
	}

	private cancelInboundEvent(path: string): void {
		this.inboundEvents.cancel(path);
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
		try {
			const existing = this.vault.getAbstractFileByPath(normalized);
			if (existing instanceof TFile) {
				this.expectInboundEvent(normalized, "modify");
				await this.vault.modifyBinary(existing, data);
				return;
			}
			if (existing instanceof TFolder) {
				if (existing.children.length > 0) {
					throw new Error(`Cannot replace non-empty folder "${normalized}"`);
				}
				this.expectInboundEvent(normalized, "rename-delete", "delete");
				// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file
				await this.vault.delete(existing, true);
			}
			await this.ensureVaultParentDir(normalized);
			this.expectInboundEvent(normalized, "create");
			await this.vault.createBinary(normalized, data);
		} catch (error) {
			this.cancelInboundEvent(normalized);
			throw error;
		}
	}

	async remove(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (this.vault) {
			const existing = this.vault.getAbstractFileByPath(normalized);
			if (!existing) return;
			this.expectInboundEvent(normalized, "rename-delete", "delete");
			try {
				// A remote tombstone must not create a new synced file in `.trash`.
				// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file
				await this.vault.delete(existing, true);
			} catch (error) {
				this.cancelInboundEvent(normalized);
				throw error;
			}
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
			const existing = this.vault.getAbstractFileByPath(dir);
			if (existing instanceof TFile) {
				this.expectInboundEvent(dir, "rename-delete", "delete");
				try {
					// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file
					await this.vault.delete(existing, true);
				} catch (error) {
					this.cancelInboundEvent(dir);
					throw error;
				}
			}
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
