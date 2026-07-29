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
	async append(path: string, value: string): Promise<void> {
		this.files.set(path, (this.files.get(path) ?? "") + value);
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
		fs.files.set("state/legacy/outbox.jsonl", '{"id":"old-outbox"}\n');
		fs.files.set("state/encoded/outbox.jsonl", '{"id":"new-outbox"}\n');
		fs.files.set("state/legacy/inbox.jsonl", '{"id":"old-inbox"}\n');
		fs.files.set("state/encoded/inbox.jsonl", '{"id":"new-inbox"}\n');
		await migrateServerState(
			fs,
			"state",
			"legacy",
			"encoded",
		);
		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe(
			'{"id":"old-outbox"}\n{"id":"new-outbox"}\n',
		);
		expect(fs.files.get("state/encoded/inbox.jsonl")).toBe(
			'{"id":"old-inbox"}\n{"id":"new-inbox"}\n',
		);
		expect(await fs.exists("state/legacy")).toBe(false);
	});

	test("quarantines a truncated source tail and keeps the destination valid", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set(
			"state/legacy/outbox.jsonl",
			'{"id":"valid"}\n{"id":"truncated"',
		);
		fs.files.set("state/encoded/outbox.jsonl", '{"id":"new"}\n');
		await migrateServerState(fs, "state", "legacy", "encoded");
		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe(
			'{"id":"valid"}\n{"id":"new"}\n',
		);
		expect(
			fs.files.get("state/encoded/outbox.jsonl.legacy.corrupt"),
		).toContain('{"id":"truncated"');
	});

	test("a restart after target replacement does not duplicate source entries", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set("state/legacy/outbox.jsonl", '{"id":"old"}\n');
		// Represents a crash after target installation but before source removal.
		fs.files.set(
			"state/encoded/outbox.jsonl",
			'{"id":"old"}\n{"id":"new"}\n',
		);
		await migrateServerState(fs, "state", "legacy", "encoded");
		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe(
			'{"id":"old"}\n{"id":"new"}\n',
		);
	});
});
