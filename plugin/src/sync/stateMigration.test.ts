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

class InterruptedMarkerAdapter extends MemoryAdapter {
	private interruptMarkerPublish = true;

	override async rename(from: string, to: string): Promise<void> {
		if (this.interruptMarkerPublish && to.endsWith(".migration.json")) {
			this.interruptMarkerPublish = false;
			throw new Error("simulated interruption during marker publication");
		}
		await super.rename(from, to);
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
		fs.files.set(
			"state/encoded/outbox.jsonl.migration.json",
			JSON.stringify({ body: '{"id":"old"}\n{"id":"new"}\n' }),
		);
		await migrateServerState(fs, "state", "legacy", "encoded");
		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe(
			'{"id":"old"}\n{"id":"new"}\n',
		);
	});

	test("preserves identical corrupt records from both namespaces", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set("state/legacy/outbox.jsonl", '{"id":"valid"}\n');
		fs.files.set(
			"state/legacy/outbox.jsonl.corrupt",
			'{"id":"truncated"\n',
		);
		fs.files.set("state/encoded/outbox.jsonl", '{"id":"valid"}\n');
		fs.files.set(
			"state/encoded/outbox.jsonl.legacy.corrupt",
			'{"id":"truncated"\n',
		);
		await migrateServerState(fs, "state", "legacy", "encoded");
		expect(
			fs.files.get("state/encoded/outbox.jsonl.legacy.corrupt"),
		).toBe('{"id":"truncated"\n{"id":"truncated"\n');
	});

	test("marker recovery installs the exact quarantine body without replay", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set("state/legacy/outbox.jsonl", '{"id":"old"}\n');
		fs.files.set("state/legacy/outbox.jsonl.corrupt", "broken\n");
		fs.files.set(
			"state/encoded/outbox.jsonl",
			'{"id":"old"}\n{"id":"new"}\n',
		);
		fs.files.set(
			"state/encoded/outbox.jsonl.legacy.corrupt",
			"broken\nbroken\n",
		);
		fs.files.set(
			"state/encoded/outbox.jsonl.migration.json",
			JSON.stringify({
				body: '{"id":"old"}\n{"id":"new"}\n',
				quarantineBody: "broken\nbroken\n",
			}),
		);

		await migrateServerState(fs, "state", "legacy", "encoded");

		expect(
			fs.files.get("state/encoded/outbox.jsonl.legacy.corrupt"),
		).toBe("broken\nbroken\n");
		expect(
			await fs.exists("state/encoded/outbox.jsonl.migration.json"),
		).toBe(false);
		expect(
			await fs.exists("state/legacy/outbox.jsonl.corrupt"),
		).toBe(false);
	});

	test("restarts safely after marker publication is interrupted", async () => {
		const fs = new InterruptedMarkerAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set("state/legacy/outbox.jsonl", '{"id":"old"}\n');
		fs.files.set("state/encoded/outbox.jsonl", '{"id":"new"}\n');

		let interruption: unknown;
		try {
			await migrateServerState(fs, "state", "legacy", "encoded");
		} catch (error) {
			interruption = error;
		}
		expect(interruption).toBeInstanceOf(Error);
		expect((interruption as Error).message).toContain("simulated interruption");
		expect(fs.files.get("state/legacy/outbox.jsonl")).toBe('{"id":"old"}\n');
		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe('{"id":"new"}\n');

		await migrateServerState(fs, "state", "legacy", "encoded");

		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe(
			'{"id":"old"}\n{"id":"new"}\n',
		);
		expect(
			await fs.exists("state/encoded/outbox.jsonl.migration.json.tmp"),
		).toBe(false);
	});

	test("restores the backup before rebuilding from an invalid legacy marker", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set("state/legacy/outbox.jsonl", '{"id":"old"}\n');
		fs.files.set(
			"state/encoded/outbox.jsonl",
			'{"id":"old"}\n{"id":"new"}\n',
		);
		fs.files.set(
			"state/encoded/outbox.jsonl.migration.bak",
			'{"id":"new"}\n',
		);
		fs.files.set("state/encoded/outbox.jsonl.migration.json", '{"body":');

		await migrateServerState(fs, "state", "legacy", "encoded");

		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe(
			'{"id":"old"}\n{"id":"new"}\n',
		);
	});

	test("recovers a source journal from its ordinary write backup", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set("state/legacy/outbox.jsonl.bak", '{"id":"old"}\n');

		await migrateServerState(fs, "state", "legacy", "encoded");

		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe('{"id":"old"}\n');
	});

	test("recovers a destination journal backup before merging the source", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set("state/legacy/outbox.jsonl", '{"id":"old"}\n');
		fs.files.set("state/encoded/outbox.jsonl.bak", '{"id":"new"}\n');
		fs.files.set("state/encoded/outbox.jsonl.tmp", '{"id":"uncommitted"}\n');

		await migrateServerState(fs, "state", "legacy", "encoded");

		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe(
			'{"id":"old"}\n{"id":"new"}\n',
		);
		expect(await fs.exists("state/encoded/outbox.jsonl.tmp")).toBe(false);
	});

	test("recovers a destination backup before considering source-only fast path", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set("state/legacy/outbox.jsonl", '{"id":"old"}\n');
		fs.files.set(
			"state/encoded/outbox.jsonl.migration.bak",
			'{"id":"new"}\n',
		);

		await migrateServerState(fs, "state", "legacy", "encoded");

		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe(
			'{"id":"old"}\n{"id":"new"}\n',
		);
		expect(
			await fs.exists("state/encoded/outbox.jsonl.migration.bak"),
		).toBe(false);
	});

	test("preserves duplicate entries within both source and destination", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set(
			"state/legacy/outbox.jsonl",
			'{"id":"old"}\n{"id":"old"}\n',
		);
		fs.files.set(
			"state/encoded/outbox.jsonl",
			'{"id":"new"}\n{"id":"new"}\n',
		);

		await migrateServerState(fs, "state", "legacy", "encoded");

		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe(
			'{"id":"old"}\n{"id":"old"}\n{"id":"new"}\n{"id":"new"}\n',
		);
	});

	test("does not mistake a coincidental destination prefix for a restart", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set("state/legacy/outbox.jsonl", '{"id":"same"}\n');
		fs.files.set(
			"state/encoded/outbox.jsonl",
			'{"id":"same"}\n{"id":"new"}\n',
		);

		await migrateServerState(fs, "state", "legacy", "encoded");

		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe(
			'{"id":"same"}\n{"id":"same"}\n{"id":"new"}\n',
		);
	});

	test("preserves quarantine when the destination journal is absent", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set("state/legacy/outbox.jsonl", '{"id":"old"}\n');
		fs.files.set("state/legacy/outbox.jsonl.corrupt", "broken\n");

		await migrateServerState(fs, "state", "legacy", "encoded");

		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe('{"id":"old"}\n');
		expect(
			fs.files.get("state/encoded/outbox.jsonl.legacy.corrupt"),
		).toBe("broken\n");
	});

	test("preserves an orphan quarantine without a source journal", async () => {
		const fs = new MemoryAdapter();
		fs.dirs.add("state/legacy");
		fs.dirs.add("state/encoded");
		fs.files.set("state/legacy/outbox.jsonl.corrupt", "orphan\n");

		await migrateServerState(fs, "state", "legacy", "encoded");

		expect(fs.files.get("state/encoded/outbox.jsonl")).toBe("");
		expect(
			fs.files.get("state/encoded/outbox.jsonl.legacy.corrupt"),
		).toBe("orphan\n");
	});
});
