import {
	normalizePath,
	type TAbstractFile,
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
import { NoopLogger, type Logger } from "../logger";

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
	private readonly inboundObjects = new WeakMap<
		TAbstractFile,
		Set<InboundEvent>
	>();
	private readonly inboundDeletions = new Map<
		string,
		{
			ctime: number;
			mtime: number;
			size: number;
			events: Set<InboundEvent>;
		}
	>();
	private readonly inboundAdapterChanges = new Map<string, number>();
	private readonly logger: Logger;

	constructor(
		private readonly adapter: DataAdapter,
		private readonly vault?: Vault,
		logger: Logger = new NoopLogger(),
	) {
		this.logger = logger.child("fs");
	}

	consumeInboundEvent(
		file: TAbstractFile,
		path: string,
		event: InboundEvent,
	): boolean {
		const objectEvents = this.inboundObjects.get(file);
		if (objectEvents?.has(event)) {
			this.inboundObjects.delete(file);
			this.logger.debug("inbound_event.consumed", {
				path,
				event,
				source: "object",
			});
			return true;
		}
		const normalized = normalizePath(path);
		const deletion = this.inboundDeletions.get(normalized);
		if (
			deletion &&
			file instanceof TFile &&
			file.stat.ctime === deletion.ctime &&
			file.stat.mtime === deletion.mtime &&
			file.stat.size === deletion.size &&
			deletion.events.has(event)
		) {
			this.inboundDeletions.delete(normalized);
			this.logger.debug("inbound_event.consumed", {
				path: normalized,
				event,
				source: "deletion",
			});
			return true;
		}
		const consumed = this.inboundEvents.consume(normalized, event);
		if (consumed) {
			this.logger.debug("inbound_event.consumed", {
				path: normalized,
				event,
				source: "path",
			});
		}
		return consumed;
	}

	consumeInboundAdapterChange(path: string): boolean {
		const normalized = normalizePath(path);
		const count = this.inboundAdapterChanges.get(normalized) ?? 0;
		if (count === 0) return false;
		if (count === 1) this.inboundAdapterChanges.delete(normalized);
		else this.inboundAdapterChanges.set(normalized, count - 1);
		this.logger.debug("inbound_adapter_change.consumed", {
			path: normalized,
		});
		return true;
	}

	private expectInboundAdapterChange(path: string): void {
		const normalized = normalizePath(path);
		this.inboundAdapterChanges.set(
			normalized,
			(this.inboundAdapterChanges.get(normalized) ?? 0) + 1,
		);
	}

	private cancelInboundAdapterChange(path: string): void {
		this.consumeInboundAdapterChange(path);
	}

	private expectInboundEvent(path: string, ...events: InboundEvent[]): void {
		this.inboundEvents.expect(path, ...events);
	}

	private cancelInboundEvent(path: string): void {
		this.inboundEvents.cancel(path);
	}

	private settleInboundEvent(path: string): void {
		this.inboundEvents.settle(path);
	}

	private expectInboundObject(
		file: TAbstractFile,
		...events: InboundEvent[]
	): void {
		this.inboundObjects.set(file, new Set(events));
	}

	private cancelInboundObject(file: TAbstractFile): void {
		this.inboundObjects.delete(file);
	}

	private settleInboundObject(file: TAbstractFile): void {
		const generation = this.inboundObjects.get(file);
		if (!generation) return;
		globalThis.setTimeout(() => {
			if (this.inboundObjects.get(file) === generation) {
				this.inboundObjects.delete(file);
			}
		}, 0);
	}

	private expectInboundDeletion(file: TFile): void {
		this.inboundDeletions.set(file.path, {
			ctime: file.stat.ctime,
			mtime: file.stat.mtime,
			size: file.stat.size,
			events: new Set(["rename-delete", "delete"]),
		});
	}

	private cancelInboundDeletion(path: string): void {
		this.inboundDeletions.delete(path);
	}

	async read(path: string): Promise<string> {
		const normalized = normalizePath(path);
		this.logger.debug("read.started", { path: normalized });
		await this.recoverJournal(normalized);
		const data = await this.adapter.read(normalized);
		this.logger.debug("read.completed", {
			path: normalized,
			bytes: data.length,
		});
		return data;
	}

	async write(path: string, data: string): Promise<void> {
		const normalized = normalizePath(path);
		this.logger.debug("write.started", {
			path: normalized,
			bytes: data.length,
		});
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
		this.logger.debug("write.completed", {
			path: normalized,
			bytes: data.length,
		});
	}

	async append(path: string, data: string): Promise<void> {
		const normalized = normalizePath(path);
		this.logger.debug("append.started", {
			path: normalized,
			bytes: data.length,
		});
		await this.ensureParentDir(normalized);
		await this.recoverJournal(normalized);
		await this.adapter.append(normalized, data);
		this.logger.debug("append.completed", {
			path: normalized,
			bytes: data.length,
		});
	}

	async exists(path: string): Promise<boolean> {
		const normalized = normalizePath(path);
		return (
			(await this.adapter.exists(normalized)) ||
			(await this.adapter.exists(`${normalized}.bak`))
		);
	}

	async readBinary(path: string): Promise<ArrayBuffer> {
		const normalized = normalizePath(path);
		this.logger.debug("read_binary.started", { path: normalized });
		const data = await this.adapter.readBinary(normalized);
		this.logger.debug("read_binary.completed", {
			path: normalized,
			bytes: data.byteLength,
		});
		return data;
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const normalized = normalizePath(path);
		this.logger.debug("write_binary.started", {
			path: normalized,
			bytes: data.byteLength,
		});
		if (!this.vault) {
			await this.ensureParentDir(normalized);
			await this.adapter.writeBinary(normalized, data);
			this.logger.debug("write_binary.completed", {
				path: normalized,
				bytes: data.byteLength,
				target: "adapter",
			});
			return;
		}
		let expectedObject: TAbstractFile | null = null;
		try {
			const existing = this.vault.getAbstractFileByPath(normalized);
			if (existing instanceof TFile) {
				expectedObject = existing;
				this.expectInboundObject(existing, "modify");
				await this.vault.modifyBinary(existing, data);
				this.settleInboundObject(existing);
				this.logger.debug("write_binary.completed", {
					path: normalized,
					bytes: data.byteLength,
					target: "vault_modify",
				});
				return;
			}
			if (existing instanceof TFolder) {
				if (existing.children.length > 0) {
					throw new Error(`Cannot replace non-empty folder "${normalized}"`);
				}
				// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file
				await this.vault.delete(existing, true);
			}
			// Obsidian deliberately does not index its hidden configuration
			// directory in the Vault API. Apply those remote bytes through the
			// adapter while marking the write so our adapter observer does not
			// echo it back to the server.
			if (normalized.startsWith(".")) {
				await this.ensureParentDir(normalized);
				this.expectInboundAdapterChange(normalized);
				try {
					await this.adapter.writeBinary(normalized, data);
				} catch (error) {
					this.cancelInboundAdapterChange(normalized);
					throw error;
				}
				this.logger.debug("write_binary.completed", {
					path: normalized,
					bytes: data.byteLength,
					target: "hidden_adapter",
				});
				return;
			}
			await this.ensureVaultParentDir(normalized);
			this.expectInboundEvent(normalized, "create");
			await this.vault.createBinary(normalized, data);
			this.settleInboundEvent(normalized);
			this.logger.debug("write_binary.completed", {
				path: normalized,
				bytes: data.byteLength,
				target: "vault_create",
			});
		} catch (error) {
			this.cancelInboundEvent(normalized);
			if (expectedObject) this.cancelInboundObject(expectedObject);
			this.logger.error("write_binary.failed", {
				path: normalized,
				error,
			});
			throw error;
		}
	}

	async remove(path: string): Promise<void> {
		const normalized = normalizePath(path);
		this.logger.debug("remove.started", { path: normalized });
		if (this.vault) {
			const existing = this.vault.getAbstractFileByPath(normalized);
			if (!existing) {
				let removed = false;
				if (normalized.startsWith(".") && await this.adapter.exists(normalized)) {
					this.expectInboundAdapterChange(normalized);
					try {
						await this.adapter.remove(normalized);
						removed = true;
					} catch (error) {
						this.cancelInboundAdapterChange(normalized);
						throw error;
					}
				}
				this.logger.debug("remove.completed", {
					path: normalized,
					existed: removed,
					target: normalized.startsWith(".")
						? "hidden_adapter"
						: "vault",
				});
				return;
			}
			if (existing instanceof TFile) {
				this.expectInboundDeletion(existing);
			}
			try {
				// A remote tombstone must not create a new synced file in `.trash`.
				// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file
				await this.vault.delete(existing, true);
			} catch (error) {
				if (existing instanceof TFile) {
					this.cancelInboundDeletion(normalized);
				}
				throw error;
			}
			this.logger.debug("remove.completed", {
				path: normalized,
				existed: true,
				target: "vault",
			});
			return;
		}
		if (await this.adapter.exists(normalized)) {
			await this.adapter.remove(normalized);
			this.logger.debug("remove.completed", {
				path: normalized,
				existed: true,
				target: "adapter",
			});
		} else {
			this.logger.debug("remove.completed", {
				path: normalized,
				existed: false,
				target: "adapter",
			});
		}
	}

	/** Recursively lists every file path in the vault, mirroring the old main.ts `listVaultFiles`. */
	async listAllFiles(): Promise<string[]> {
		this.logger.info("list_all_files.started");
		const files = await this.listFilesUnder("");
		this.logger.info("list_all_files.completed", { fileCount: files.length });
		return files;
	}

	private async listFilesUnder(folderPath: string): Promise<string[]> {
		this.logger.debug("list_folder.started", { folderPath });
		let listed: { files: string[]; folders: string[] };
		try {
			listed = await this.adapter.list(folderPath);
		} catch (error) {
			this.logger.error("list_folder.failed", { folderPath, error });
			throw error;
		}
		this.logger.debug("list_folder.completed", {
			folderPath,
			directFiles: listed.files.length,
			directFolders: listed.folders.length,
		});
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
				this.expectInboundDeletion(existing);
				try {
					// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file
					await this.vault.delete(existing, true);
				} catch (error) {
					this.cancelInboundDeletion(dir);
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
