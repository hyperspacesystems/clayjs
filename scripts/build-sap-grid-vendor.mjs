// Bundles sapjs's grid plugin (src/plugins/grid.js and the grid code it imports), plus
// Sap.grid.tokenize (scripts/sap-grid-entry.js), into src/vendor/sap-grid.vendor.js, the
// module derive.js hands the engine when a page's [sap] root asks for "grid". It stands in
// for sapjs's propagate step until the grid has a manifest entry; propagate then writes the
// same file and this script goes. SAPJS_DIR names a clean sapjs tree (default: the sibling
// checkout).
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { build } from "esbuild";

const ROOT = new URL("..", import.meta.url).pathname;
const SAPJS = resolve(process.env.SAPJS_DIR || resolve(ROOT, "../sapjs"));
const git = (...args) => execFileSync("git", ["-C", SAPJS, ...args], { encoding: "utf8" }).trim();

if (git("status", "--porcelain", "--", "src")) {
  throw new Error(`${SAPJS} has uncommitted changes under src/: build the vendor from a clean tree (SAPJS_DIR)`);
}
const commit = git("rev-parse", "--short", "HEAD");

await build({
  entryPoints: [resolve(ROOT, "scripts/sap-grid-entry.js")],
  alias: { SAPJS },
  outfile: resolve(ROOT, "src/vendor/sap-grid.vendor.js"),
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2020",
  legalComments: "none",
  banner: { js: `// GENERATED — do not edit. Bundled from sapjs src/plugins/grid.js (plus Sap.grid.tokenize) at ${commit} by scripts/build-sap-grid-vendor.mjs.` },
});
console.log(`src/vendor/sap-grid.vendor.js from sapjs ${commit}`);
