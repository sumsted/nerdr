import { build } from "esbuild";
import * as fs from "node:fs";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  external: ["vscode"],
  logLevel: "info",
};

if (watch) {
  const { context } = await import("esbuild");
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching extension sources...");
} else {
  await build(options);
  fs.mkdirSync("dist", { recursive: true });
  console.log("built dist/extension.js");
}
