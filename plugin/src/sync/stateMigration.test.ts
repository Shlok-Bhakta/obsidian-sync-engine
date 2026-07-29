import { describe, expect, test } from "bun:test";
import { migrateServerState } from "./stateMigration";

class MemoryAdapter {
	readonly files = new Map<string, string>();
	readonly dirs = new Set<string>();

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.dirs.has(path);
	}
	async read(path: string): Promise<string> {
		const value = this.files.get(path);
		if (value === undefined) throw new Error(`missing ${path}`);
		return value;
	}
	async write(path: string, value: string): Promise<void> {
		this.files.set(path, value);
	}
	async rename(from: string, to: string): Promise<void> {
		if (this.files.has(from)) {
			this.files.set(to, this.files.get(from) ?? "");
			this.files.delete(from);
			return;
		}
		if (this.dirs.has(from)) {
			this.dirs.delete(from);
			this.dirs.add(to);
			for (const [path, value] of [...this.files]) {
				if (path.startsWith(`${from}/`)) {
					this.files.delete(path);
					this.files.set(`${to}${path.slice(from.length)}`, value);
				}
			}
			return;
		}
		throw new Error(`missing ${from}`);
	}
	async remove(path: string): Promise<void> {
		this.files.delete(path);
	}
	async rmdir(path: string): Promise<void> {
		this.dirs.delete(path);
		for (const file of [...this.files.keys()]) {
			if (file.startsWith(`${path}/`)) this.files.delete(file);
		}
	}
}

describe("migrateServerState", () => {
	test("renames an untouched legacy state directory", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.files.set("state/legacy/outbox.jsonl", '{"path":"a.md"}\n');
		await migrateServerState(
			fs,
			"state",
			"legacy",
			"encoded",
		);
		expect(fs.files.get("state/encoded/outbox.jsonl")).toContain("a.md");
		expect(await fs.exists("state/legacy")).toBe(false);
	});

	test("merges pending outbox and inbox ahead of newer destination work", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set("state/legacy/outbox.jsonl", "old-outbox\n");
		fs.files.set("state/encoded/outbox.jsonl", "new-outbox\n");
		fs.files.set("state/legacy/inbox.jsonl", "old-inbox\n");
		fs.files.set("state/encoded/inbox.jsonl", "new-inbox\n");
		await migrateServerState(
			fs,
			"state",
			"legacy",
			"encoded",
		);
		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe(
			"old-outbox\nnew-outbox\n",
		);
		expect(fs.files.get("state/encoded/inbox.jsonl")).toBe(
			"old-inbox\nnew-inbox\n",
		);
		expect(await fs.exists("state/legacy")).toBe(false);
	});
});
