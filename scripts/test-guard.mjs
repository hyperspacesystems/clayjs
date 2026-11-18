import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { options } = require("../node_modules/jest-cli/build/args.js");
const SELECTORS = new Set(["testNamePattern", "testPathPattern", "findRelatedTests", "onlyChanged", "changedSince", "onlyFailures", "lastCommit", "listTests"]);

const flags = new Map();
for (const [name, spec] of Object.entries(options)) {
  flags.set(`--${name}`, name);
  flags.set(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, name);
  if (spec.alias) flags.set(`-${spec.alias}`, name);
}

function isFocused(args) {
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("-")) return true;
    const [flag, inline] = args[i].split(/=(.*)/s);
    const name = flags.get(flag);
    const boolean = !name || options[name].type === "boolean";
    let value = inline;
    if (value === undefined && (!boolean || args[i + 1] === "true" || args[i + 1] === "false")) value = args[++i];
    if (SELECTORS.has(name) && (boolean ? value !== "false" : Boolean(value))) return true;
  }
  return false;
}

const args = process.argv.slice(2);

if (process.platform === "darwin" && !isFocused(args) && process.env.CLAYJS_LOCAL_SUITE !== "1") {
  console.error(`The full clayjs suite runs on the test box, not on this Mac.

    testbox run            (from clayjs: npm test, conformance and standalone)

A focused run stays local: npm test -- <path or pattern>, or -t <test name>.
To run the whole suite here anyway: CLAYJS_LOCAL_SUITE=1 npm test`);
  process.exit(2);
}

// On a test box, passing files' console output is dropped and file events go to $TESTBOX_OUT.
// verbose would print console output past any reporter, and 'summary' keeps the Tests: line.
// The package.json jest config ships with the package, so these flags live here instead.
const passed = (name) => args.some((arg) => flags.get(arg.split("=")[0]) === name);
const ownFile = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const extra = [];
if (process.env.TESTBOX === "1" && process.env.JEST_CONSOLE !== "all" && !passed("reporters")) {
  extra.push("--verbose=false", `--reporters=${ownFile("../tests/reporters/failing-console.cjs")}`, "--reporters=summary");
}
if (!passed("testSequencer")) extra.push(`--testSequencer=${ownFile("../tests/duration-sequencer.cjs")}`);

const jest = fileURLToPath(new URL("../node_modules/jest/bin/jest.js", import.meta.url));
const nodeOptions = [process.env.NODE_OPTIONS, "--experimental-vm-modules"].filter(Boolean).join(" ");
const { status } = spawnSync(process.execPath, [jest, ...args, ...extra], {
  stdio: "inherit",
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
});
process.exit(status ?? 1);
