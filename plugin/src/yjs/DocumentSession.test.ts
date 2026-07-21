import { describe, expect, test } from "bun:test";
import { smallestChange } from "./DocumentSession";

describe("smallest editor change", () => {
  test("preserves common prefix and suffix", () => {
    expect(smallestChange("hello world", "hello brave world")).toEqual({ from: 6, deleteCount: 0, insert: "brave " });
    expect(smallestChange("alpha beta omega", "alpha omega")).toEqual({ from: 6, deleteCount: 5, insert: "" });
  });
});
