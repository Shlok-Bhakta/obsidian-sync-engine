import { expect, test } from "bun:test";
import type { DataAdapter } from "obsidian";
import * as Y from "yjs";
import { OutboxStore } from "./OutboxStore";
import { sha256 } from "./storage";

class MemoryAdapter {
  files = new Map<string, string | ArrayBuffer>();
  async exists(path: string): Promise<boolean> { return this.files.has(path) || [...this.files].some(([key]) => key.startsWith(`${path}/`)); }
  async mkdir(_path: string): Promise<void> {}
  async write(path: string, value: string): Promise<void> { this.files.set(path, value); }
  async read(path: string): Promise<string> { return this.files.get(path) as string; }
  async writeBinary(path: string, value: ArrayBuffer): Promise<void> { this.files.set(path, value.slice(0)); }
  async readBinary(path: string): Promise<ArrayBuffer> { return (this.files.get(path) as ArrayBuffer).slice(0); }
  async remove(path: string): Promise<void> { this.files.delete(path); }
  async rename(from: string, to: string): Promise<void> { this.files.set(to, this.files.get(from)!); this.files.delete(from); }
}

test("outbox survives restart and coalesces adjacent Yjs updates", async () => {
  const memory = new MemoryAdapter();
  const adapter = memory as unknown as DataAdapter;
  const outbox = new OutboxStore(adapter, "state/outbox.json", "state/payloads");
  await outbox.load();
  const doc = new Y.Doc();
  let first: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let second: Uint8Array<ArrayBufferLike> = new Uint8Array();
  doc.on("update", (update: Uint8Array) => { if (first.length === 0) first = update; else second = update; });
  doc.getText("content").insert(0, "a");
  doc.getText("content").insert(1, "b");
  const fileId = crypto.randomUUID();
  await outbox.enqueue({ mutationId: "one", operation: "yjs_update", fileId, path: "note.md", baseRevision: "0", objectHash: await sha256(first) }, first);
  await outbox.enqueue({ mutationId: "two", operation: "yjs_update", fileId, path: "note.md", baseRevision: "0", objectHash: await sha256(second) }, second);
  expect(outbox.list()).toHaveLength(1);
  const restarted = new OutboxStore(adapter, "state/outbox.json", "state/payloads");
  await restarted.load();
  expect(restarted.list()).toHaveLength(1);
  expect(restarted.list()[0]?.mutation.mutationId).toBe("one");
  await restarted.rebaseFile(fileId, "7");
  expect(restarted.list()[0]?.mutation.baseRevision).toBe("7");
});
