export interface SyncFs {
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	append(path: string, data: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

export class MemorySyncFs implements SyncFs {
	private files = new Map<string, string>();

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
