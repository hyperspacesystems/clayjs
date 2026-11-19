import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newFileWorld, alive, view, open, close, edit, refresh, save, hostTake, deliver, push, outside, finish, checkFileStep } from "./fileworld.mjs";
import { keyBetween } from "./vendor/order-keys.mjs";
import { usePlant, PLANTS } from "../core/planted.mjs";
import { faultPlan } from "./host.mjs";
import { rng, rowsInOrder, COLS } from "./lib.mjs";
import { CODEC } from "./lens.mjs";

export const FILE_PLANTS = Object.keys(PLANTS).filter((plant) => plant.startsWith("file-"));
export const FILE_PROFILES = ["v1", "v2", "v3"];
export const FILE_PROFILE = "v2";

const pick = (rnd, list) => (list.length ? list[Math.floor(rnd() * list.length)] : null);

const awake = (world, rnd) => {
  const tab = pick(rnd, alive(world));
  if (!tab) return null;
  const away = world.sleepy === tab.id || (world.dark && tab.unknown);
  return away && rnd() < 0.85 ? null : tab;
};

const between = (left, right) => {
  try {
    return keyBetween(left, right);
  } catch {
    return left ?? right ?? keyBetween(null, null);
  }
};

const MOVES = {
  value(world, rnd) {
    const tab = pick(rnd, alive(world));
    const row = tab && pick(rnd, rowsInOrder(view(tab)));
    if (!row) return null;
    return [tab.id, edit(world, tab, { t: "set", row, col: pick(rnd, COLS), value: `v${++world.values}` })];
  },
  insert(world, rnd) {
    const tab = pick(rnd, alive(world));
    if (!tab) return null;
    const wb = view(tab);
    const rows = rowsInOrder(wb);
    const at = Math.floor(rnd() * (rows.length + 1));
    const pos = between(at > 0 ? wb.rows[rows[at - 1]].pos : null, at < rows.length ? wb.rows[rows[at]].pos : null);
    return [tab.id, edit(world, tab, { t: "ins", row: `n${++world.rows}`, pos, cells: {} })];
  },
  remove(world, rnd) {
    const tab = pick(rnd, alive(world));
    const rows = tab ? rowsInOrder(view(tab)) : [];
    if (rows.length < 2) return null;
    return [tab.id, edit(world, tab, { t: "del", row: pick(rnd, rows) })];
  },
  save(world, rnd) {
    const tab = awake(world, rnd);
    return tab && save(world, tab) ? [tab.id] : null;
  },
  host(world, rnd) {
    if (!world.inflight.length) return null;
    const at = Math.floor(rnd() * world.inflight.length);
    const lost = rnd() < 0.12;
    hostTake(world, at, lost);
    return [at, lost ? "lost" : "ok"];
  },
  deliver(world, rnd) {
    if (!world.answers.length) return null;
    const at = Math.floor(rnd() * world.answers.length);
    const lost = rnd() < world.lossy;
    deliver(world, at, lost);
    return [at, lost ? "lost" : "ok"];
  },
  refresh(world, rnd) {
    const tab = awake(world, rnd);
    return tab && refresh(world, tab) ? [tab.id] : null;
  },
  push(world, rnd) {
    const waiting = [...new Set(world.pushes.map((one) => one.tab))];
    const tab = pick(rnd, waiting);
    if (!tab) return null;
    const lost = rnd() < world.lossy / 2;
    push(world, tab, lost);
    return [tab.id, lost ? "lost" : "ok"];
  },
  open(world) {
    return alive(world).length < 5 ? [open(world).id] : null;
  },
  close(world, rnd) {
    const tab = alive(world).length > 1 ? pick(rnd, alive(world)) : null;
    if (!tab) return null;
    close(world, tab);
    return [tab.id];
  },
  outside(world, rnd) {
    const raw = rnd() < 0.4;
    const count = world.host.versions.length;
    const undo = world.undo !== null && rnd() < 0.3;
    const at = undo ? world.undo : rnd() < 0.3 ? "live" : rnd() < 0.6 ? Math.max(0, count - 1 - Math.floor(rnd() * 4)) : Math.floor(rnd() * count);
    world.undo = count - 1;
    if (world.bursts) world.heat = 3;
    const patch = rnd() < 0.6;
    const source = at === "live" ? world.host : world.host.versions[at];
    const row = patch ? pick(rnd, rowsInOrder(parseRows(source.body))) : null;
    outside(world, at, row ? { t: "set", row, col: pick(rnd, COLS), value: `o${++world.values}` } : null, raw);
    return [raw ? "raw" : "host", at];
  },
};

function parseRows(body) {
  const rows = {};
  const tag = CODEC === "list" ? /<li data-key="([^"]*)" data-at="([^"]*)">/g : /<tr data-id="([^"]*)" data-pos="([^"]*)">/g;
  for (const [, id, pos] of body.matchAll(tag)) rows[id] = { pos, cells: {} };
  return { rows };
}

const WEIGHTS = [
  ["value", 18],
  ["insert", 3],
  ["remove", 2],
  ["save", 16],
  ["host", 14],
  ["deliver", 14],
  ["refresh", 6],
  ["open", 3],
  ["close", 3],
  ["outside", 2],
];

function nextMove(rnd, weights) {
  let x = rnd() * weights.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [name, weight] of weights) {
    x -= weight;
    if (x < 0) return name;
  }
  return weights.at(-1)[0];
}

export function runFile(seed, steps = 300, { profile = "v1" } = {}) {
  if (!FILE_PROFILES.includes(profile)) throw new Error(`unknown file-only profile ${profile}`);
  const rnd = rng(seed);
  const traits = rng((seed ^ 0x51f1e) >>> 0);
  const world = newFileWorld({ ledgerCap: pick(traits, [undefined, undefined, 160, 160, 102]), pushing: profile !== "v1" });
  const weights = WEIGHTS.map(([name, weight]) => [name, weight * pick(traits, name === "outside" ? [0.3, 1, 2, 4] : [0.3, 1, 1, 3])]);
  world.shown = [];
  world.lossy = pick(traits, [0.05, 0.12, 0.3, 0.5]);
  world.sleepy = pick(traits, [null, null, "f1", "f2"]);
  world.undo = null;
  world.dark = traits() < 0.5;
  world.bursts = traits() < 0.5;
  world.heat = 0;
  if (world.pushing) weights.push(["push", 12 * pick(traits, [0.2, 1, 1, 3])]);
  if (profile === "v3") world.host.faults = faultPlan(traits, pick(traits, [0.1, 0.3, 0.6, 1]), pick(traits, [1, 3, 8]));
  else if (world.pushing && traits() < 0.25) world.host.faults = [pick(traits, ["drop", "blank"])];
  open(world);
  open(world);
  try {
    for (let i = 0; i < steps; i++) {
      const name = world.heat-- > 0 && rnd() < 0.35 ? "outside" : nextMove(rnd, weights);
      const args = MOVES[name](world, rnd);
      world.shown.push(args ? [name, ...args] : [name, "(nothing to do)"]);
      checkFileStep(world);
    }
    return finish(world);
  } catch (error) {
    error.world = world;
    throw error;
  }
}

export function fuzzFile({ from = 1, to = 500, steps = 300, plant = "", profile = "v1" } = {}) {
  usePlant(plant);
  const caught = [];
  const totals = { edits: 0, accepted: 0, refused: 0, replaced: 0, copies: 0, ledger: 0, stored: 0, unprovable: 0, replayUnjudged: 0, replayResolved: 0, replayApplied: 0, replayMisfit: 0, replayConflict: 0, endApplied: 0, endSkipped: 0, endUnjudged: 0, endConflict: 0, copyWrites: 0, copyFaults: 0, pushes: 0 };
  for (let seed = from; seed <= to; seed++) {
    try {
      const world = runFile(seed, steps, { profile });
      totals.edits += world.oracle.edits.size;
      totals.accepted += world.accepted;
      totals.refused += world.refused;
      totals.replaced += world.replaced;
      totals.copies += world.copies;
      totals.stored += world.oracle.stored;
      totals.unprovable += world.oracle.unprovable;
      totals.replayUnjudged += world.oracle.replays.unjudged;
      totals.replayResolved += world.oracle.replays.resolved;
      totals.replayApplied += world.oracle.replays.applied;
      totals.replayMisfit += world.oracle.replays.misfit;
      totals.endApplied += world.oracle.atEnd.applied + world.oracle.atEnd.misfit;
      totals.endSkipped += world.oracle.atEnd.saved + world.oracle.atEnd.resolved + world.oracle.atEnd.replaced;
      totals.endUnjudged += world.oracle.atEnd.unjudged;
      totals.replayConflict += world.oracle.replays.conflict;
      totals.endConflict += world.oracle.atEnd.conflict;
      totals.copyWrites += world.host.copyWrites;
      totals.copyFaults += world.host.copyFaults;
      totals.pushes += world.shown.filter((move) => move[0] === "push" && move[2] === "ok").length;
      totals.ledger = Math.max(totals.ledger, world.oracle.maxLedger);
    } catch (error) {
      caught.push({ seed, message: error.message.slice(0, 240) });
    }
  }
  usePlant("");
  return { seeds: to - from + 1, steps, plant, profile, failures: caught.length, caught: caught.slice(0, 50), totals };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
  if ("list" in args) {
    console.log(FILE_PLANTS.join("\n"));
    process.exit(0);
  }
  const [from, to] = (args.seeds ?? "1..2000").split("..").map(Number);
  const steps = Number(args.steps ?? 300);
  const profile = args.profile ?? FILE_PROFILE;
  const clean = args.plant ? { seeds: 0, failures: 0, caught: [], totals: {} } : fuzzFile({ from, to, steps, profile });
  if (!args.plant) console.log(JSON.stringify({ mode: "file-only", profile, from, to, seeds: clean.seeds, steps, failures: clean.failures, totals: clean.totals }));
  for (const one of clean.caught.slice(0, 5)) console.log(`seed ${one.seed}: ${one.message}`);
  const mutants = [];
  const count = Number(args.mutants ?? 300);
  const deep = Number(args.deep ?? 0);
  for (const plant of count ? FILE_PLANTS.filter((name) => !args.plant || name === args.plant) : []) {
    const row = { plant, about: PLANTS[plant], caught: 0, of: 0, first: "", firstSeed: null };
    for (let start = 1, size = count; start <= Math.max(count, deep) && (row.of < count || row.caught < 2); start += size, size = 10000) {
      const result = fuzzFile({ from: start, to: Math.min(Math.max(count, deep), start + size - 1), steps, plant, profile });
      row.caught += result.failures;
      row.of += result.seeds;
      row.first ||= result.caught[0]?.message ?? "";
      row.firstSeed ??= result.caught[0]?.seed ?? null;
    }
    mutants.push(row);
    console.log(`${plant}: ${row.caught}/${row.of} ${row.first}`);
  }
  const missed = mutants.filter((row) => !row.caught).map((row) => row.plant);
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify({ lab: "ordered-fable", kind: "file-only", profile, at: new Date().toISOString(), clean, mutants, missed }, null, 1)}\n`);
  }
  process.exit(clean.failures || missed.length ? 1 : 0);
}
