import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/nerdr.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  legalComments: "none",
  external: ["@opencode/plugin", "node:*"],
  banner: {
    js: "// Nerdr OpenCode plugin - reports agent state to the VSCodium extension. Bundled by esbuild.",
  },
});

await build({
  entryPoints: ["src/telegram/daemon.ts"],
  outfile: "dist/nerdr-telegram.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  legalComments: "none",
  external: ["node:*"],
  banner: {
    js: "#!/usr/bin/env node\n// Nerdr standalone Telegram daemon - supervised by the VSCodium extension.",
  },
});

console.log("built dist/nerdr.js and dist/nerdr-telegram.mjs");
