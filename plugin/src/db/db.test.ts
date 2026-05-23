import { describe, expect, it } from "vitest";
import { JsonlOutboxStore } from "./db";

function makeAdapter() {
	const files = new Map<string, string>();
	const folders = new Set<string>();
	const normalize = (path: string) => path.replace(/^\/+|\/+$/g, "");
	return {
		exists: async (path: string) => files.has(normalize(path)) || folders.has(normalize(path)),
		mkdir: async (path: string) => {
			folders.add(normalize(path));
		},
		write: async (path: string, content: string) => {
			files.set(normalize(path), content);
		},
		append: async (path: string, content: string) => {
			const normalized = normalize(path);
			files.set(normalized, (files.get(normalized) ?? "") + content);
		},
		read: async (path: string) => files.get(normalize(path)) ?? "",
		rename: async (from: string, to: string) => {
			const normalizedFrom = normalize(from);
			const normalizedTo = normalize(to);
			const value = files.get(normalizedFrom);
			if (value !== undefined) {
				files.delete(normalizedFrom);
				files.set(normalizedTo, value);
				return;
			}
			if (folders.has(normalizedFrom)) {
				folders.delete(normalizedFrom);
				folders.add(normalizedTo);
			}
		},
		remove: async (path: string) => {
			files.delete(normalize(path));
		},
		list: async (path: string) => {
			const dir = normalize(path);
			const prefix = dir ? `${dir}/` : "";
			const listedFiles: string[] = [];
			const listedFolders = new Set<string>();
			for (const filePath of files.keys()) {
				if (!filePath.startsWith(prefix)) {
					continue;
				}
				const rest = filePath.slice(prefix.length);
				if (!rest || rest.includes("/")) {
					continue;
				}
				listedFiles.push(filePath);
			}
			for (const folderPath of folders) {
				if (!folderPath.startsWith(prefix)) {
					continue;
				}
				const rest = folderPath.slice(prefix.length);
				if (!rest || rest.includes("/")) {
					continue;
				}
				listedFolders.add(folderPath);
			}
			return {
				files: listedFiles.sort(),
				folders: [...listedFolders].sort(),
			};
		},
	};
}

describe("JsonlOutboxStore", () => {
	it("round-trips markdown create yjsState rows", async () => {
		const adapter = makeAdapter();
		const store = new JsonlOutboxStore({
			vault: {
				configDir: ".obsidian",
				adapter,
			},
		} as never, { id: "obsidian-sync-engine" } as never);
		const yjsState = new Uint8Array([1, 2, 3, 4]);

		await store.open();
		await store.putInOutbox({
			mutationId: "create-md",
			operation: "UpsertFile",
			path: "Notes/new.md",
			content: "draft",
			yjsState,
			isYjs: true,
			storageKind: "text",
			created: 1,
		});
		const segment = await store.claimNextSegment(true);

		expect(segment).not.toBeNull();
		const rows = await store.readSegment(segment!);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			mutationId: "create-md",
			operation: "UpsertFile",
			path: "Notes/new.md",
			content: "draft",
			isYjs: true,
			storageKind: "text",
		});
		expect(rows[0]?.yjsState).toEqual(yjsState);
	});
});
