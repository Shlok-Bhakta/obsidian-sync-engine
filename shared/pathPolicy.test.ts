import { describe, expect, it } from "vitest";
import { isPluginInternalPath, shouldSyncPath } from "./pathPolicy";

describe("path policy", () => {
    it("syncs normal vault files and config files", () => {
        expect(shouldSyncPath("notes/test.md")).toBe(true);
        expect(shouldSyncPath(".obsidian/workspace.json")).toBe(true);
        expect(shouldSyncPath(".obsidian/themes/theme.css")).toBe(true);
    });

    it("syncs this plugin's release artifacts but not its local state", () => {
        expect(shouldSyncPath(".obsidian/plugins/obsidian-sync-engine")).toBe(true);
        expect(shouldSyncPath(".obsidian/plugins/obsidian-sync-engine/main.js")).toBe(true);
        expect(shouldSyncPath(".obsidian/plugins/obsidian-sync-engine/styles.css")).toBe(true);
        expect(shouldSyncPath(".obsidian/plugins/obsidian-sync-engine/manifest.json")).toBe(true);
        expect(shouldSyncPath(".obsidian/plugins/obsidian-sync-engine/data.json")).toBe(false);
        expect(shouldSyncPath(".obsidian/plugins/obsidian-sync-engine/yjs-state/notes/test.md.state")).toBe(false);
        expect(shouldSyncPath(".obsidian/plugins/obsidian-sync-engine/outbox/active.jsonl")).toBe(false);
        expect(shouldSyncPath(".obsidian/plugins/obsidian-sync-engine/bootstrap/manifest.json")).toBe(false);
        expect(isPluginInternalPath(".obsidian/plugins/obsidian-sync-engine/main.js")).toBe(false);
        expect(isPluginInternalPath(".obsidian/plugins/obsidian-sync-engine/data.json")).toBe(true);
        expect(isPluginInternalPath(".obsidian/plugins/obsidian-sync-engine/bootstrap/manifest.json")).toBe(true);
    });

    it("does not sync Obsidian trash", () => {
        expect(shouldSyncPath(".trash/Images/Pasted image.png")).toBe(false);
    });

    it("does not sync Git repository internals", () => {
        expect(shouldSyncPath(".git/objects/pack/file.idx")).toBe(false);
        expect(shouldSyncPath(".obsidian/plugins/hot-reload/.git/objects/pack/file.idx")).toBe(false);
    });

    it("does not sync local sync engine state", () => {
        expect(shouldSyncPath(".sync-engine-state/obsidian-sync-engine/yjs/notes/test.md.state")).toBe(false);
        expect(shouldSyncPath(".sync-engine-state/obsidian-sync-engine/yjs/notes/test.md.state.sha256")).toBe(false);
        expect(shouldSyncPath(".sync-engine-sync/wal/active.jsonl")).toBe(false);
    });
});
