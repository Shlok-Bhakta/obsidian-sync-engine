import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
    resolve: {
        alias: [
            { find: /^db\/(.*)$/, replacement: `${resolve(__dirname, "src/db")}/$1` },
            { find: /^yjs\/(.*)$/, replacement: `${resolve(__dirname, "src/yjs")}/$1` },
            { find: /^sync\/(.*)$/, replacement: `${resolve(__dirname, "src/sync")}/$1` },
            { find: /^utils\/(.*)$/, replacement: `${resolve(__dirname, "src/utils")}/$1` },
        ],
    },
    test: {
        include: ["src/**/*.test.ts", "../shared/*.test.ts"],
        exclude: ["**/node_modules/**"],
    },
});
