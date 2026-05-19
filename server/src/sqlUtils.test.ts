import { describe, expect, it } from "bun:test";
import { escapeLikePattern, folderDescendantLike } from "./sqlUtils";

describe("escapeLikePattern", () => {
    it("escapes percent and underscore", () => {
        expect(escapeLikePattern("100%_done")).toBe("100\\%\\_done");
    });

    it("escapes backslashes", () => {
        expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
    });
});

describe("folderDescendantLike", () => {
    it("appends descendant suffix", () => {
        expect(folderDescendantLike("vault")).toBe("vault/%");
    });

    it("escapes metacharacters in folder names", () => {
        expect(folderDescendantLike("weird%name")).toBe("weird\\%name/%");
    });
});
