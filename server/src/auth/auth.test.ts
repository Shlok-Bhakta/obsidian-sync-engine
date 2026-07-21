import { describe, expect, test } from "bun:test";
import { generateClientSecret, hashSecret } from "./auth";

describe("client credentials", () => {
  test("generates high-entropy distinct bearer tokens and stores only a one-way hash", () => {
    const first = generateClientSecret();
    const second = generateClientSecret();
    expect(first).toStartWith("obs_sync_");
    expect(first.length).toBeGreaterThan(48);
    expect(first).not.toBe(second);
    expect(hashSecret(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSecret(first)).not.toContain(first);
  });
});
