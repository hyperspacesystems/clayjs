#!/usr/bin/env node
// Runs the frozen lab's oracle against a protocol implementation.
//   --adapter lab      the lab's own core (tests/live-room/lab), as frozen
//   --adapter product  src/live-room/core (or --core <dir>) driven by the lab harness.
//                      Only the protocol calls the drivers make, and `replay`, reach
//                      the product; every judge (oracle, fake host, generator,
//                      scenario checks, limits) keeps the lab's own core, and every
//                      edit also checks the product's view against the lab's.
//   --adapter broken   the lab core with a false "saved" planted, which must fail
// Suites: vectors (every scenario and every recorded regression), fuzz (seeded
// sessions per delivery mode, seeds --from to --from + --seeds - 1), long (long
// sessions), files (file-only mode, profiles v1 to v3), plants (product adapter only:
// for each planted defect of the lab core, a product core with that one defect switched
// on must fail the scenarios that list it), all.
// Exit 0 when nothing failed, 1 when a session failed, 2 when the run itself broke.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildCore, writeCore, corePlants } from "./build-live-room-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LAB = path.join(ROOT, "tests/live-room/lab");
export const PRODUCT_CORE = path.join(ROOT, "src/live-room/core");
export const BROKEN_PLANT = "ack-on-delivery";
const FILE_PROFILES = ["v1", "v2", "v3"];

// Which names each harness file takes from the product core; "*" is every name of
// that module. Everything else a harness file imports comes from ref-core/.
export const PRODUCT_IMPORTS = {
  "world.mjs": { "ledger.mjs": "*", "room.mjs": "*", "record.mjs": "*", "tab.mjs": "*", "host.mjs": "*" },
  "fileworld.mjs": { "fileonly.mjs": "*", "record.mjs": ["serialize", "DOC"], "ledger.mjs": ["trimLedger"], "recover.mjs": ["replay"] },
  "oracle.mjs": { "recover.mjs": ["replay"] },
  "scenarios.mjs": { "recover.mjs": ["replay"], "room.mjs": ["admit"], "host.mjs": ["fileAccepted"] },
};

const VIEW_LINE = "  const shown = view(tab);\n";

const DEFAULTS = { adapter: "product", core: "", suite: "vectors", from: 1, seeds: 200, longSeeds: 20, steps: 400, longSteps: 2000, fileSeeds: 0, modes: ["ordered", "scrambled"], profile: "", faults: "", workers: 0, out: "", keep: false };

const whole = (name, value) => {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a whole number of at least 1, not ${value}`);
  return value;
};

export function check(opts) {
  if (!["lab", "product", "broken"].includes(opts.adapter)) throw new Error(`unknown adapter ${opts.adapter}`);
  if (!["vectors", "fuzz", "long", "files", "plants", "all"].includes(opts.suite)) throw new Error(`unknown suite ${opts.suite}`);
  if (!opts.modes.length) throw new Error("--modes names no delivery mode");
  for (const mode of opts.modes) if (!["ordered", "scrambled"].includes(mode)) throw new Error(`unknown mode ${mode}`);
  for (const name of ["from", "seeds", "longSeeds", "steps", "longSteps", "fileSeeds"]) whole(name, opts[name]);
  if (opts.core && opts.adapter !== "product") throw new Error("--core applies only to the product adapter");
  if (opts.suite === "plants" && opts.adapter !== "product") throw new Error("--suite plants applies only to the product adapter");
  return opts;
}

export function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  const numbers = { "--from": "from", "--seeds": "seeds", "--long-seeds": "longSeeds", "--steps": "steps", "--long-steps": "longSteps", "--file-seeds": "fileSeeds", "--workers": "workers" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--keep") {
      opts.keep = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} needs a value`);
    if (arg in numbers) opts[numbers[arg]] = Number(value);
    else if (arg === "--adapter") opts.adapter = value;
    else if (arg === "--core") opts.core = path.resolve(value);
    else if (arg === "--suite") opts.suite = value;
    else if (arg === "--modes") opts.modes = value.split(",").filter(Boolean);
    else if (arg === "--profile") opts.profile = value;
    else if (arg === "--faults") opts.faults = value;
    else if (arg === "--out") opts.out = value;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!opts.fileSeeds) opts.fileSeeds = opts.seeds;
  return check(opts);
}

function harnessFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) return harnessFiles(at);
    return entry.name.endsWith(".mjs") ? [at] : [];
  });
}

// Splits every `import { … } from "../core/x.mjs"` (and `export { … } from`) of one
// harness file between core/ (the product) and ref-core/ (the lab), by PRODUCT_IMPORTS.
export function route(text, file, used = new Set()) {
  const table = PRODUCT_IMPORTS[file] ?? {};
  const routed = text.replace(/^(import|export) \{([^}]*)\} from "((?:\.\.\/)+)core\/([\w-]+\.mjs)";$/gm, (line, kind, list, up, module) => {
    if (module === "planted.mjs") return line;
    const wanted = table[module];
    const names = list.split(",").map((name) => name.trim()).filter(Boolean);
    const product = names.filter((name) => wanted === "*" || wanted?.includes(name.split(/\s+as\s+/)[0]));
    for (const name of product) used.add(`${file} ${module} ${wanted === "*" ? "*" : name.split(/\s+as\s+/)[0]}`);
    const lines = [];
    if (product.length) lines.push(`${kind} { ${product.join(", ")} } from "${up}core/${module}";`);
    const ref = names.filter((name) => !product.includes(name));
    if (ref.length) lines.push(`${kind} { ${ref.join(", ")} } from "${up}ref-core/${module}";`);
    return lines.join("\n");
  });
  const stray = routed.split("\n").find((line) => /(?:\.\.\/)+core\/(?!planted\.mjs")/.test(line) && !/^(import|export) \{[^}]*\} from "(?:\.\.\/)+core\/[\w-]+\.mjs";$/.test(line));
  if (stray) throw new Error(`harness/${file} imports the core in a form the runner cannot route: ${stray.trim()}`);
  return routed;
}

export function productTree(core = PRODUCT_CORE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-room-product-"));
  fs.cpSync(path.join(LAB, "codec-tiny"), path.join(dir, "codec-tiny"), { recursive: true });
  fs.cpSync(path.join(LAB, "harness"), path.join(dir, "harness"), { recursive: true });
  fs.cpSync(path.join(LAB, "core"), path.join(dir, "ref-core"), { recursive: true });
  fs.mkdirSync(path.join(dir, "core"));
  fs.copyFileSync(path.join(LAB, "core/planted.mjs"), path.join(dir, "core/planted.mjs"));
  for (const name of fs.readdirSync(path.join(LAB, "core"))) {
    if (!name.endsWith(".mjs") || name === "planted.mjs") continue;
    const source = path.join(core, name.replace(/\.mjs$/, ".js"));
    if (!fs.existsSync(source)) throw new Error(`${core} has no ${path.basename(source)} for the lab's core/${name}`);
    fs.writeFileSync(path.join(dir, "core", name), fs.readFileSync(source, "utf8").replace(/from "\.\/([\w-]+)\.js"/g, 'from "./$1.mjs"'));
  }
  const used = new Set();
  for (const file of harnessFiles(path.join(dir, "harness"))) fs.writeFileSync(file, route(fs.readFileSync(file, "utf8"), path.basename(file), used));
  for (const [file, modules] of Object.entries(PRODUCT_IMPORTS)) {
    for (const [module, names] of Object.entries(modules)) {
      for (const name of names === "*" ? ["*"] : names) if (!used.has(`${file} ${module} ${name}`)) throw new Error(`harness/${file} no longer imports ${name} from core/${module}; update PRODUCT_IMPORTS`);
    }
  }
  const host = path.join(dir, "harness/host.mjs");
  const hostText = fs.readFileSync(host, "utf8");
  if (!hostText.includes("\nuseCodec(codec);\n")) throw new Error("harness/host.mjs no longer installs the codec with useCodec(codec)");
  fs.writeFileSync(host, `import { useCodec as useProductCodec } from "../core/codec.mjs";\n${hostText.replace("\nuseCodec(codec);\n", "\nuseCodec(codec);\nuseProductCodec(codec);\n")}`);
  const world = path.join(dir, "harness/world.mjs");
  const worldText = fs.readFileSync(world, "utf8");
  if (!worldText.includes(VIEW_LINE)) throw new Error("harness/world.mjs userEdit no longer starts with `const shown = view(tab);`");
  fs.writeFileSync(world, `import { view as labView } from "../ref-core/tab.mjs";\nimport { canon as canonOf } from "./lib.mjs";\n${worldText.replace(VIEW_LINE, `${VIEW_LINE}  if (canonOf(shown) !== canonOf(labView(tab))) throw new Error(\`V1 \${tab.id} shows a table the lab's view does not\`);\n`)}`);
  return dir;
}

const VECTORS = `
import fs from "node:fs";
const [tree, plant] = process.argv.slice(1);
const { SCENARIOS, runScenario } = await import(tree + "/harness/scenarios.mjs");
const { run, runMoves } = await import(tree + "/harness/gen.mjs");
const { runFile } = await import(tree + "/harness/filefuzz.mjs");
const { usePlant } = await import(tree + "/core/planted.mjs");
const rows = JSON.parse(fs.readFileSync(tree + "/harness/regressions.json", "utf8"));
const failures = [];
for (const scenario of SCENARIOS) {
  const result = runScenario(scenario, plant);
  if (!result.ok) failures.push({ name: scenario.name, message: result.message.slice(0, 300) });
}
rows.forEach(({ seed, mode, profile = "v1", limits, steps = 400, moves, faults, removals, end }, index) => {
  usePlant(plant);
  try {
    if (mode === "file") runFile(seed, 300, { profile });
    else if (moves) runMoves(moves, { mode, profile, seed, limits, faults, removals, end });
    else run(seed, steps, { mode, profile, limits });
  } catch (error) {
    failures.push({ name: "regression-" + index + "-seed-" + seed + "-" + mode, message: error.message.slice(0, 300) });
  } finally {
    usePlant("");
  }
});
console.log(JSON.stringify({ runs: SCENARIOS.length + rows.length, failures }));
`;

const LISTED = `
const [tree, plant] = process.argv.slice(1);
const { SCENARIOS, runScenario } = await import(tree + "/harness/scenarios.mjs");
const listed = SCENARIOS.filter((scenario) => scenario.plants.includes(plant));
const failed = listed.filter((scenario) => !runScenario(scenario).ok).length;
console.log(JSON.stringify({ runs: listed.length, failed }));
`;

const FILES = `
const [tree, plant, from, to, steps, profile] = process.argv.slice(1);
const { fuzzFile } = await import(tree + "/harness/filefuzz.mjs");
const result = fuzzFile({ from: Number(from), to: Number(to), steps: Number(steps), plant, profile });
console.log(JSON.stringify({ runs: result.seeds, failures: result.failures, caught: result.caught }));
`;

const classOf = (message) => /^([A-Z]+\d+[a-z]?)\b/.exec(message ?? "")?.[1] ?? "other";

function node(cwd, args) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}

function inline(tree, code, args) {
  const result = node(tree, ["--input-type=module", "-e", code, "--", tree, ...args]);
  if (result.status !== 0) throw new Error(`a run in ${tree} exited ${result.status ?? result.signal}: ${result.stderr.slice(-800)}`);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

function counted(part, wanted, runs, failures) {
  if (runs !== wanted) throw new Error(`${part} ran ${runs} sessions, not the ${wanted} asked for`);
  const classes = {};
  for (const failure of failures) classes[classOf(failure.message)] = (classes[classOf(failure.message)] ?? 0) + 1;
  return classes;
}

function vectors(tree, plant) {
  const result = inline(tree, VECTORS, [plant]);
  if (!(result.runs > 0)) throw new Error("the vectors suite ran nothing");
  return { part: "vectors", runs: result.runs, failures: result.failures.length, classes: counted("vectors", result.runs, result.runs, result.failures), first: result.failures.slice(0, 10) };
}

function sweep(tree, plant, opts, part, seeds, steps, mode) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "live-room-report-"));
  const out = path.join(scratch, `${part}.json`);
  try {
    const args = ["harness/fuzz.mjs", "--seeds", `${opts.from}..${opts.from + seeds - 1}`, "--steps", String(steps), "--mode", mode, "--shrink", "0", "--out", out];
    if (plant) args.push("--plant", plant);
    if (opts.profile) args.push("--profile", opts.profile);
    if (opts.faults) args.push("--faults", opts.faults);
    if (opts.workers) args.push("--workers", String(opts.workers));
    const result = node(tree, args);
    if (result.status !== 0 && result.status !== 1) throw new Error(`fuzz ${part} exited ${result.status ?? result.signal}: ${result.stderr.slice(-800)}`);
    if (!fs.existsSync(out)) throw new Error(`fuzz ${part} wrote no report (exit ${result.status}): ${result.stderr.slice(-800)}`);
    const report = JSON.parse(fs.readFileSync(out, "utf8"));
    if (report.seeds !== seeds) throw new Error(`${part} ran ${report.seeds} sessions, not the ${seeds} asked for`);
    if (report.failures > 0 && result.status !== 1) throw new Error(`fuzz ${part} reported failures but exited ${result.status}`);
    return { part, runs: report.seeds, failures: report.failures, classes: report.classes, first: (report.caught ?? []).slice(0, 10), totals: report.totals };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// A missed plant is this suite's failure: the product adapter let a known defect pass.
function plants() {
  const names = corePlants();
  const missed = [];
  for (const plant of names) {
    const core = fs.mkdtempSync(path.join(os.tmpdir(), "live-room-forced-"));
    let tree;
    try {
      writeCore(core, buildCore({ force: [plant] }));
      tree = productTree(core);
      const result = inline(tree, LISTED, [plant]);
      if (!result.runs) throw new Error(`no scenario lists the planted defect ${plant}`);
      if (!result.failed) missed.push({ name: plant, message: `M0 a product core with ${plant} switched on passed the ${result.runs} scenarios that list it` });
    } finally {
      fs.rmSync(core, { recursive: true, force: true });
      if (tree) fs.rmSync(tree, { recursive: true, force: true });
    }
  }
  return { part: "plants", runs: names.length, failures: missed.length, classes: missed.length ? { M0: missed.length } : {}, first: missed.slice(0, 20) };
}

function files(tree, plant, opts, profile) {
  const result = inline(tree, FILES, [plant, String(opts.from), String(opts.from + opts.fileSeeds - 1), "300", profile]);
  return { part: `files-${profile}`, runs: result.runs, failures: result.failures, classes: counted(`files-${profile}`, opts.fileSeeds, result.runs, result.caught), first: result.caught.slice(0, 10) };
}

export function conform(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!opts.fileSeeds) opts.fileSeeds = opts.seeds;
  check(opts);
  const tree = opts.adapter === "product" ? productTree(opts.core || PRODUCT_CORE) : LAB;
  const plant = opts.adapter === "broken" ? BROKEN_PLANT : "";
  const want = (suite) => opts.suite === suite || opts.suite === "all";
  const parts = [];
  try {
    if (want("vectors")) parts.push(vectors(tree, plant));
    for (const mode of opts.modes) if (want("fuzz")) parts.push(sweep(tree, plant, opts, `fuzz-${mode}`, opts.seeds, opts.steps, mode));
    for (const mode of opts.modes) if (want("long")) parts.push(sweep(tree, plant, opts, `long-${mode}`, opts.longSeeds, opts.longSteps, mode));
    for (const profile of opts.profile ? [opts.profile] : FILE_PROFILES) if (want("files")) parts.push(files(tree, plant, opts, profile));
    if (want("plants") && opts.adapter === "product" && !opts.core) parts.push(plants());
  } finally {
    if (tree !== LAB && !opts.keep) fs.rmSync(tree, { recursive: true, force: true });
  }
  return { adapter: opts.adapter, suite: opts.suite, tree: opts.keep && tree !== LAB ? tree : undefined, failures: parts.reduce((sum, part) => sum + part.failures, 0), parts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let opts;
  let report;
  try {
    opts = parseArgs(process.argv.slice(2));
    report = conform(opts);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  for (const part of report.parts) console.log(`${part.part}: ${part.failures} of ${part.runs} failed ${JSON.stringify(part.classes)}`);
  if (report.tree) console.log(`product tree kept at ${report.tree}`);
  console.log(`${report.adapter}: ${report.failures ? `${report.failures} failed` : "every run passed"}`);
  if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify(report, null, 1)}\n`);
  process.exit(report.failures ? 1 : 0);
}
