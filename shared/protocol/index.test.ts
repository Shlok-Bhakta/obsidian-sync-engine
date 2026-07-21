import { describe, expect, test } from "bun:test";
import {
  MessageType,
  PROTOCOL_VERSION,
  deserialize,
  mutationSchema,
  revisionSchema,
  serialize,
  shouldSyncVaultPath,
  websocketMessageSchema,
} from "./index";

describe("WebSocket protocol", () => {
  test("round trips a revision notification", () => {
    const value = { type: MessageType.REVISION_AVAILABLE, latestServerRevision: "9007199254740993" } as const;
    expect(deserialize(serialize(value))).toEqual(value);
  });

  test("rejects durable data and generic payloads", () => {
    expect(() => websocketMessageSchema.parse({ type: "MESSAGE", payload: "note body" })).toThrow();
    expect(() => websocketMessageSchema.parse({
      type: MessageType.REVISION_AVAILABLE,
      latestServerRevision: "1",
      objectHash: "a".repeat(64),
    })).toThrow();
  });

  test("validates authentication", () => {
    const auth = {
      type: MessageType.AUTH,
      clientId: crypto.randomUUID(),
      clientName: "laptop",
      credential: "x".repeat(32),
      protocolVersion: PROTOCOL_VERSION,
      lastAppliedRevision: "0",
    } as const;
    expect(deserialize(serialize(auth))).toEqual(auth);
  });
});

describe("vault scope", () => {
  test.each([
    ["Notes/hello.md", true],
    [".obsidian/appearance.json", true],
    [".obsidian/plugins/calendar/main.js", true],
    [".obsidian/workspace.json", false],
    [".obsidian/plugins/obsidian-sync-engine/data.json", false],
    [".obsidian/plugins/obsidian-sync-engine/outbox/op.json", false],
    [".trash/deleted.md", false],
    ["folder/.git/config", false],
    ["../escape", false],
    ["/absolute", false],
    ["Notes/a.md.sync-tmp-deadbeef", false],
  ])("classifies %s", (path, expected) => expect(shouldSyncVaultPath(path)).toBe(expected));
});

test("revisions preserve values larger than Number.MAX_SAFE_INTEGER", () => {
  expect(revisionSchema.parse("9007199254740993")).toBe("9007199254740993");
  expect(revisionSchema.parse("9223372036854775807")).toBe("9223372036854775807");
  expect(() => revisionSchema.parse("9223372036854775808")).toThrow();
  expect(() => revisionSchema.parse(9_007_199_254_740_992)).toThrow();
});

test("mutation schema enforces operation-specific fields", () => {
  expect(() => mutationSchema.parse({
    mutationId: "m1",
    operation: "rename",
    fileId: crypto.randomUUID(),
    path: "a.md",
    baseRevision: "1",
  })).toThrow();
});
