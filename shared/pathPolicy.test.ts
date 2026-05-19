import { describe, expect, it } from "vitest";
import { shouldSyncPath } from "./pathPolicy";

describe("path policy", () => {
    it("syncs normal vault files and config files", () => {
        expect(shouldSyncPath("notes/test.md")).toBe(true);
        expect(shouldSyncPath(".obsidian/workspace.json")).toBe(true);
        expect(shouldSyncPath(".obsidian/themes/theme.css")).toBe(true);
    });

    it("does not sync this plugin or Obsidian trash", () => {
        expect(shouldSyncPath(".obsidian/plugins/obsidian-sync-engine")).toBe(false);
        expect(shouldSyncPath(".obsidian/plugins/obsidian-sync-engine/main.js")).toBe(false);
        expect(shouldSyncPath(".obsidian/plugins/obsidian-sync-engine/data.json")).toBe(false);
        expect(shouldSyncPath(".trash/Images/Pasted image.png")).toBe(false);
    });
});
