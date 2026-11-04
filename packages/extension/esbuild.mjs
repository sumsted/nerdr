import { build } from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";

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

  // Ship the standalone daemon next to the extension so activation can deploy
  // it to ~/.nerdr without an npm install or a system service.
  const daemonSource = path.join("..", "opencode-plugin", "dist", "nerdr-telegram.mjs");
  const daemonTarget = path.join("bin", "nerdr-telegram.mjs");
  fs.mkdirSync("bin", { recursive: true });
  if (fs.existsSync(daemonSource)) {
    fs.copyFileSync(daemonSource, daemonTarget);
    fs.chmodSync(daemonTarget, 0o755);
    console.log("copied bin/nerdr-telegram.mjs");
  } else {
    console.warn(
      "warning: dist/nerdr-telegram.mjs not found; run the opencode-plugin build first",
    );
  }

  console.log("built dist/extension.js");
}
