import type { VaultBlobFs } from "../sync/engine";
import type { SyncFs } from "../sync/fs";

export class MemorySyncFs implements SyncFs {
	protected readonly files = new Map<string, string>();

	async read(path: string): Promise<string> {
		const data = this.files.get(path);
		if (data === undefined) {
			throw new Error(`ENOENT: no such file: ${path}`);
		}
		return data;
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}

	async append(path: string, data: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? "") + data);
	}

	async exists(path: string): Promise<boolean> {
		return this.files.has(path);
	}
}

/** In-memory vault filesystem with the binary extensions SyncEngine requires. */
export class MemoryVaultFs extends MemorySyncFs implements VaultBlobFs {
	async readBinary(path: string): Promise<ArrayBuffer> {
		return new TextEncoder().encode(await this.read(path)).buffer;
	}

	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		this.files.set(path, new TextDecoder().decode(data));
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}

	async listAllFiles(): Promise<string[]> {
		return [...this.files.keys()];
	}
}

export function createRevisionStore(initial = 0) {
	let revision = initial;
	return {
		get: () => revision,
		set: (nextRevision: number) => {
			revision = nextRevision;
		},
	};
}
