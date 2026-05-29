#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const pluginRoot = resolve(repoRoot, "plugin");
const outdir = resolve(repoRoot, ".real-e2e-cache");

await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(repoRoot, "scripts/real-e2e-impl.ts")],
  outdir,
  target: "bun",
  format: "esm",
  sourcemap: "inline",
  plugins: [{
    name: "real-e2e-aliases",
    setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({
        path: resolve(repoRoot, "scripts/obsidian-real-e2e-mock.ts"),
      }));
      build.onResolve({ filter: /^@codemirror\/state$/ }, () => ({
        path: resolve(pluginRoot, "node_modules/@codemirror/state/dist/index.js"),
      }));
      build.onResolve({ filter: /^yjs$/ }, () => ({
        path: resolve(pluginRoot, "node_modules/yjs/dist/yjs.mjs"),
      }));
      build.onResolve({ filter: /^zod$/ }, () => ({
        path: resolve(pluginRoot, "node_modules/zod/index.js"),
      }));
      build.onResolve({ filter: /^db\/(.*)$/ }, args => ({
        path: resolve(pluginRoot, "src/db", args.path.replace(/^db\//, "")),
      }));
      build.onResolve({ filter: /^yjs\/(.*)$/ }, args => ({
        path: resolve(pluginRoot, "src/yjs", args.path.replace(/^yjs\//, "")),
      }));
      build.onResolve({ filter: /^sync\/(.*)$/ }, args => ({
        path: resolve(pluginRoot, "src/sync", args.path.replace(/^sync\//, "")),
      }));
      build.onResolve({ filter: /^utils\/(.*)$/ }, args => ({
        path: resolve(pluginRoot, "src/utils", args.path.replace(/^utils\//, "")),
      }));
    },
  }],
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

const output = result.outputs.find(file => file.path.endsWith(".js"));
if (!output) {
  console.error("real-e2e bundle did not produce a JS output");
  process.exit(1);
}

const proc = Bun.spawn(["bun", output.path, ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: Bun.env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await proc.exited);
