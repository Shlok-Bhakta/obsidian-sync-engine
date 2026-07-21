import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ObjectStore, ObjectStoreError } from "./object_store";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function store(max = 1024): Promise<ObjectStore> {
  const root = await mkdtemp(join(tmpdir(), "sync-object-test-"));
  directories.push(root);
  return new ObjectStore(root, max, async () => {});
}

function request(bytes: Uint8Array): Request {
  return new Request("http://test/object", { method: "PUT", headers: { "Content-Length": String(bytes.byteLength) }, body: bytes.slice().buffer as ArrayBuffer });
}

describe("content-addressed object store", () => {
  test("verifies hashes and remains idempotent", async () => {
    const target = await store();
    const bytes = new TextEncoder().encode("immutable bytes");
    const hash = createHash("sha256").update(bytes).digest("hex");
    expect((await target.putRequest(hash, request(bytes))).existed).toBe(false);
    expect((await target.putRequest(hash, request(bytes))).existed).toBe(true);
    expect(await target.read(hash)).toEqual(bytes);
    const wrong = new TextEncoder().encode("changed content");
    await expect(target.putRequest(hash, request(wrong))).rejects.toMatchObject({ code: "HASH_MISMATCH" });
  });

  test("rejects hash mismatch, traversal-shaped hashes, and oversized requests", async () => {
    const target = await store(4);
    const bytes = new TextEncoder().encode("too large");
    await expect(target.putRequest("0".repeat(64), request(bytes))).rejects.toBeInstanceOf(ObjectStoreError);
    await expect(target.putRequest("../escape", request(new Uint8Array()))).rejects.toThrow();
  });
});
