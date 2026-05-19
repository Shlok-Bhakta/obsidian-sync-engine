import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["../shared/protocol.test.ts"],
        exclude: ["**/node_modules/**"],
    },
});
