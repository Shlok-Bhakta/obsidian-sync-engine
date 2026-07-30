export interface SyncFs {
	read(path: string): Promise<string>;
	write(path: string, data: string): Promise<void>;
	append(path: string, data: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}
