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
  external: ["@opencode-ai/plugin", "node:*"],
  banner: {
    js: "// Nerdr OpenCode plugin - reports agent state to the VSCodium extension. Bundled by esbuild.",
  },
});

console.log("built dist/nerdr.js");
