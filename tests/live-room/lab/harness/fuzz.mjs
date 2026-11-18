import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { run, runMoves, tailSession, rowOptions, PROFILE, PROFILES, TAILS } from "./gen.mjs";
import { usePlant, PLANTS } from "../core/planted.mjs";
import { account } from "./oracle.mjs";
import { failing, shrink, attempt, failureClass } from "./shrink.mjs";

const SUMS = ["edits", "saved", "refused", "copy", "version", "closed", "accepted", "hostRefused", "losses", "expired", "outside", "restores", "generations", "copiesLineage", "copiesRestore", "copiesMisfit", "copiesRetired", "renewed", "adopted", "skipped", "notices", "idle", "stored", "unprovable", "replayApplied", "replayMisfit", "replaySaved", "replayResolved", "replayReplaced", "replayUnjudged", "replayRefused", "replayConflict", "replayLate", "replayAgain", "replayBack", "endBack", "endApplied", "endMisfit", "endSkipped", "endUnjudged", "endConflict", "endLate", "endRefused", "copyWrites", "copyFaults", "marks", "markWrites", "markFaults", "lateTakes", "replayHeld", "replayOrder", "replayShown", "endHeld", "replayRow", "endRow", "endOrder", "restoreJobs", "restoreEdits", "restoreApplied", "restoreKept", "restoreMisfit", "restoreConflict", "restoreSaved", "restoreReplaced", "restoreCounted", "restoreRefused", "restoreHeld", "restoreLeft", "decideJobs", "decideTake", "decideKeep", "decideTaken", "decideKept", "decideAgain", "decideMoot", "returnedJudged", "returnedKept", "returnedSent", "returnedSessions", "keptSessions", "placesOpen", "removedLists", "removedCells", "removedNotices", "waitsEnded", "rowWaits", "rowWaitsTurned", "rowWaitsEarlier", "lulls", "lullsAway", "lullsOwing", "removalEntries", "removalSaves", "removalHeld", "removalBytes", "removalMissed", ...["take", "keep"].flatMap((how) => ["Copies", "Edits", "Auto", "Chosen", "Kept", "Released", "Misfit", "Conflict", "Held", "Left"].map((key) => `${how}${key}`))];
const MAXES = ["recordBytes", "ledger", "tail", "tailBytes", "roomBytes", "tabs"];

function statsOf(world) {
  const { oracle } = world;
  const by = (reason) => [...oracle.copies.values()].filter((copy) => copy.reason === reason).length;
  return {
    edits: oracle.edits.size,
    ...account(world),
    accepted: world.accepted,
    hostRefused: world.refused,
    losses: world.losses,
    expired: world.expired,
    outside: world.patches,
    restores: world.restores,
    generations: oracle.gens.size - 1,
    copiesLineage: by("lineage"),
    copiesRestore: by("restore"),
    copiesMisfit: by("restore-misfit"),
    copiesRetired: by("retired"),
    renewed: world.tabs.reduce((n, tab) => n + tab.clients.size - 1, 0),
    adopted: oracle.adopted,
    skipped: oracle.skipped,
    notices: world.tabs.reduce((n, tab) => n + tab.notices.length, 0),
    idle: world.shown.filter((move) => move[1] === "(nothing to do)").length,
    stored: oracle.stored,
    unprovable: oracle.unprovable,
    replayApplied: oracle.replays.applied,
    replayMisfit: oracle.replays.misfit,
    replaySaved: oracle.replays.saved,
    replayResolved: oracle.replays.resolved,
    replayReplaced: oracle.replays.replaced,
    replayUnjudged: oracle.replays.unjudged,
    replayRefused: oracle.replays.refused,
    replayConflict: oracle.replays.conflict,
    replayLate: oracle.replays.late,
    replayAgain: oracle.replays.again,
    replayBack: oracle.replays.back,
    endBack: oracle.atEnd.back,
    endApplied: oracle.atEnd.applied,
    endMisfit: oracle.atEnd.misfit,
    endSkipped: oracle.atEnd.saved + oracle.atEnd.resolved + oracle.atEnd.replaced,
    endUnjudged: oracle.atEnd.unjudged,
    endConflict: oracle.atEnd.conflict,
    endLate: oracle.atEnd.late,
    endRefused: oracle.atEnd.refused,
    copyWrites: world.host.copyWrites,
    copyFaults: world.host.copyFaults,
    marks: world.host.decisions.length,
    markWrites: world.host.markWrites,
    markFaults: world.host.markFaults,
    lateTakes: oracle.takeOf.size,
    replayHeld: oracle.replays.held,
    replayOrder: oracle.replays.order,
    endOrder: oracle.atEnd.order,
    replayShown: oracle.replays.shown,
    endHeld: oracle.atEnd.held,
    replayRow: oracle.replays.row,
    endRow: oracle.atEnd.row,
    restoreJobs: oracle.restored.jobs,
    restoreEdits: oracle.restored.edits,
    restoreApplied: oracle.restored.applied,
    restoreKept: oracle.restored.kept,
    restoreMisfit: oracle.restored.misfit,
    restoreConflict: oracle.restored.conflict,
    restoreSaved: oracle.restored.saved,
    restoreReplaced: oracle.restored.replaced,
    restoreCounted: oracle.restored.counted,
    restoreRefused: oracle.restored.refused,
    restoreHeld: oracle.restored.held,
    restoreLeft: oracle.restored.left,
    decideJobs: oracle.decisions.jobs,
    decideTake: oracle.decisions.take,
    decideKeep: oracle.decisions.keep,
    decideTaken: oracle.decisions.taken,
    decideKept: oracle.decisions.kept,
    decideAgain: oracle.decisions.again,
    decideMoot: oracle.decisions.moot,
    returnedJudged: oracle.returned.judged,
    returnedKept: oracle.returned.kept,
    returnedSent: oracle.returned.sent,
    returnedSessions: oracle.returned.judged ? 1 : 0,
    keptSessions: oracle.returned.kept ? 1 : 0,
    placesOpen: oracle.placesOpen,
    removedLists: oracle.removedLists.size,
    removedCells: [...oracle.gens.values()].reduce((n, info) => n + [...info.removed.values()].reduce((sum, cells) => sum + cells.length, 0), 0),
    removedNotices: world.tabs.reduce((n, tab) => n + tab.notices.filter((notice) => notice.kind === "removed").length, 0),
    waitsEnded: oracle.stopped.size,
    rowWaits: oracle.rowWaits.all,
    rowWaitsTurned: oracle.rowWaits.turned,
    rowWaitsEarlier: oracle.rowWaits.earlier,
    lulls: world.lulls.all,
    lullsAway: world.lulls.away,
    lullsOwing: world.lulls.owing,
    removalEntries: world.host.removals.length,
    removalSaves: world.host.removalSaves,
    removalHeld: oracle.removalHeld,
    removalBytes: world.host.removals.reduce((n, entry) => n + JSON.stringify(entry).length, 0),
    removalMissed: oracle.removalMissed,
    ...Object.fromEntries(["take", "keep"].flatMap((how) => Object.entries(oracle.whatIf[how]).map(([key, value]) => [`${how}${key[0].toUpperCase()}${key.slice(1)}`, value]))),
    recordBytes: oracle.maxRecordBytes,
    ledger: oracle.maxLedger,
    tail: oracle.maxRoomTail,
    tailBytes: oracle.maxTailBytes,
    roomBytes: oracle.maxRoomBytes,
    tabs: world.tabs.length,
  };
}

const ROWS = JSON.parse(fs.readFileSync(new URL("./regressions.json", import.meta.url), "utf8"))
  .map((row, index) => ({ ...row, index }))
  .filter((row) => row.moves);

const OTHER = { ordered: "scrambled", scrambled: "ordered" };

const prefixes = new Map();

function prefixOf(row, options, plant) {
  if (!plant) return row.moves.length;
  const key = JSON.stringify([plant, row.index, options.mode, options.faults ?? null, Boolean(options.removals)]);
  if (!prefixes.has(key)) {
    let keep = row.moves.length;
    while (keep > 0 && attempt(row.moves.slice(0, keep), options)) keep--;
    prefixes.set(key, keep);
  }
  return prefixes.get(key);
}

const shortOf = (seed, row) => row.moves.length - (Math.floor(seed / ROWS.length) % (Math.ceil(row.moves.length / 2) + 1));

function tailOf(seed, opts) {
  const row = opts.row === undefined ? ROWS[seed % ROWS.length] : ROWS.find((one) => one.index === opts.row);
  const options = { ...rowOptions(row), mode: opts.flip ? OTHER[row.mode] : row.mode, faults: opts.faults ?? row.faults, removals: opts.removals || row.removals };
  const session = tailSession(seed, row, opts.steps, opts.tails, Math.min(prefixOf(row, options, opts.plant), opts.short ? shortOf(seed, row) : Infinity));
  return { ...session, options: { ...options, end: seed } };
}

function failsAlone(session, seed, opts) {
  usePlant("");
  try {
    if (session) runMoves(session.moves, session.options);
    else run(seed, opts.steps, { mode: opts.mode, without: opts.without, profile: opts.profile, faults: opts.faults, removals: opts.removals });
    return null;
  } catch (error) {
    return error.message.slice(0, 300);
  } finally {
    usePlant(opts.plant);
  }
}

function oneSeed(seed, opts) {
  const session = opts.tails ? tailOf(seed, opts) : null;
  try {
    if (session) return { seed, ok: true, row: session.row.index, cut: session.keep < session.row.moves.length, stats: statsOf(runMoves(session.moves, session.options)) };
    return { seed, ok: true, stats: statsOf(run(seed, opts.steps, { mode: opts.mode, without: opts.without, profile: opts.profile, faults: opts.faults, removals: opts.removals })) };
  } catch (error) {
    return { seed, ok: false, row: session?.row.index, cut: session ? session.keep < session.row.moves.length : undefined, message: error.message.slice(0, 300), move: error.move ?? null, alone: opts.plant ? failsAlone(session, seed, opts) : null };
  }
}

function fold(results) {
  const totals = Object.fromEntries(SUMS.map((key) => [key, 0]));
  const max = Object.fromEntries(MAXES.map((key) => [key, 0]));
  for (const result of results) {
    if (!result.ok) continue;
    for (const key of SUMS) totals[key] += result.stats[key];
    for (const key of MAXES) max[key] = Math.max(max[key], result.stats[key]);
  }
  return { totals, max };
}

const caughtIn = (results) => results.filter((result) => !result.ok).map(({ seed, row, cut, message, move, alone }) => ({ seed, ...(row === undefined ? {} : { row, cut }), message, move, ...(alone ? { alone } : {}) }));

const aloneIn = (caught) => caught.filter((one) => one.alone).map(({ seed, row, alone }) => ({ seed, row, message: alone }));

const tailCounts = (results, tails) => (tails ? { cut: results.filter((result) => result.cut).length, rows: new Set(results.map((result) => result.row)).size } : {});

export function fuzz({ from = 1, to = 200, steps = 400, plant = "", mode = "ordered", without = [], profile = PROFILE, faults, removals = false, tails = "", row, flip = false, short = false } = {}) {
  usePlant(plant);
  prefixes.clear();
  const results = [];
  for (let seed = from; seed <= to; seed++) results.push(oneSeed(seed, { steps, mode, without, profile, faults, removals, tails, row, flip, short, plant }));
  usePlant("");
  prefixes.clear();
  const caught = caughtIn(results);
  return { seeds: to - from + 1, failures: caught.length, caught, ...tailCounts(results, tails), ...fold(results) };
}

if (!isMainThread) {
  const { from, to, opts } = workerData;
  usePlant(opts.plant);
  for (let seed = from; seed <= to; seed++) {
    parentPort.postMessage({ start: seed });
    parentPort.postMessage({ done: oneSeed(seed, opts) });
  }
}

function runRange(from, to, opts, onResult) {
  return new Promise((resolve) => {
    const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { from, to, opts } });
    let current = from;
    let timer = null;
    const lost = (message) => {
      clearTimeout(timer);
      onResult({ seed: current, ok: false, message, move: null });
      worker.terminate();
      resolve(current < to ? runRange(current + 1, to, opts, onResult) : undefined);
    };
    worker.on("message", (message) => {
      clearTimeout(timer);
      if (message.start !== undefined) {
        current = message.start;
        timer = setTimeout(() => lost(`I8 stuck: seed ran over ${opts.seedMs} ms`), opts.seedMs);
      } else {
        onResult(message.done);
      }
    });
    worker.on("error", (error) => lost(`crash ${error.message}`.slice(0, 300)));
    worker.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function parallel(opts) {
  const count = opts.to - opts.from + 1;
  const size = Math.ceil(count / Math.max(1, Math.min(opts.workers, count)));
  const results = new Map();
  const ranges = [];
  for (let from = opts.from; from <= opts.to; from += size) ranges.push([from, Math.min(opts.to, from + size - 1)]);
  await Promise.all(ranges.map(([from, to]) => runRange(from, to, opts, (result) => results.has(result.seed) || results.set(result.seed, result))));
  return [...results.values()].sort((a, b) => a.seed - b.seed);
}

const SOURCE = /\.(mjs|json|sh|md|diff)$|^\.testbox$/;
const NOT_SOURCE = ["out", "test-box-out", "node_modules"];

export function sourceHashes() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const hashes = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_SOURCE.includes(entry.name)) walk(full);
      } else if (SOURCE.test(entry.name)) {
        hashes[path.relative(root, full)] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      }
    }
  };
  walk(root);
  return hashes;
}

function faultsOf(text) {
  const [rate, run = 4] = text.split(":").map(Number);
  if (!(rate >= 0 && rate <= 1) || !(run >= 1)) throw new Error(`--faults takes rate[:run], a rate from 0 to 1 and a longest run of failed writes, and got ${text}`);
  return { rate, run };
}

function parseArgs(argv) {
  const opts = { from: 1, to: 200, steps: 400, plant: "", mode: "ordered", profile: PROFILE, out: "", workers: os.availableParallelism(), seedMs: 60000, shrink: 5, without: [], mutants: 0, deep: 0, slice: [0, 1], removals: false, tails: "", flip: false, only: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--seeds") [opts.from, opts.to] = argv[++i].split("..").map(Number);
    else if (arg === "--steps") opts.steps = Number(argv[++i]);
    else if (arg === "--mode") opts.mode = argv[++i];
    else if (arg === "--plant") opts.plant = argv[++i];
    else if (arg === "--profile") opts.profile = argv[++i];
    else if (arg === "--without") opts.without = argv[++i].split(",").filter(Boolean);
    else if (arg === "--out") opts.out = argv[++i];
    else if (arg === "--workers") opts.workers = Number(argv[++i]);
    else if (arg === "--seed-ms") opts.seedMs = Number(argv[++i]);
    else if (arg === "--shrink") opts.shrink = Number(argv[++i]);
    else if (arg === "--mutants") opts.mutants = Number(argv[++i]);
    else if (arg === "--deep") opts.deep = Number(argv[++i]);
    else if (arg === "--slice") opts.slice = argv[++i].split("/").map(Number);
    else if (arg === "--faults") opts.faults = faultsOf(argv[++i]);
    else if (arg === "--removals") opts.removals = true;
    else if (arg === "--tails") opts.tails = argv[++i];
    else if (arg === "--row") opts.row = Number(argv[++i]);
    else if (arg === "--flip") opts.flip = true;
    else if (arg === "--short") opts.short = true;
    else if (arg === "--only") opts.only = argv[++i].split(",").filter(Boolean);
    else throw new Error(`unknown argument ${arg}`);
  }
  if (opts.tails && !(opts.tails in TAILS)) throw new Error(`unknown tail ${opts.tails}`);
  if (opts.row !== undefined && !ROWS.some((row) => row.index === opts.row)) throw new Error(`row ${opts.row} of regressions.json has no moves`);
  if (!["ordered", "scrambled"].includes(opts.mode)) throw new Error(`unknown mode ${opts.mode}`);
  if (opts.plant && !(opts.plant in PLANTS)) throw new Error(`unknown plant ${opts.plant}`);
  for (const name of opts.only) if (!(name in PLANTS)) throw new Error(`unknown plant ${name}`);
  if (!(opts.profile in PROFILES)) throw new Error(`unknown profile ${opts.profile}`);
  return opts;
}

function classes(caught) {
  const counts = {};
  for (const { message } of caught) {
    const key = message.split(/[ :]/)[0];
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function shrunkTails(caught, opts) {
  const out = [];
  for (const { seed } of caught.slice(0, opts.shrink)) {
    const { row, keep, moves, options } = tailOf(seed, opts);
    const error = attempt(moves, options);
    if (!error) continue;
    const small = shrink(moves, options, failureClass(error));
    const again = attempt(small.moves, options);
    out.push({ seed, row: row.index, keep, options, message: small.error.message, moves: small.moves, shown: again?.world?.shown ?? [] });
  }
  return out;
}

function shrunk(caught, opts) {
  usePlant(opts.plant);
  const options = { mode: opts.mode, without: opts.without, profile: opts.profile, faults: opts.faults, removals: opts.removals };
  const out = opts.tails ? shrunkTails(caught, opts) : [];
  for (const { seed } of opts.tails ? [] : caught.slice(0, opts.shrink)) {
    const error = failing(seed, opts.steps, options);
    if (!error) continue;
    if (!error.moves) {
      out.push({ seed, message: error.message, moves: [], shown: [] });
      continue;
    }
    const small = shrink(error.moves, { ...options, seed }, failureClass(error));
    const again = attempt(small.moves, { ...options, seed });
    out.push({ seed, message: small.error.message, moves: small.moves, shown: again?.world?.shown ?? [] });
  }
  usePlant("");
  return out;
}

async function sweep(opts) {
  const started = Date.now();
  const results = await parallel(opts);
  const caught = caughtIn(results);
  return { seeds: results.length, failures: caught.length, classes: classes(caught), caught, alone: aloneIn(caught), ...tailCounts(results, opts.tails), ...fold(results), ms: Date.now() - started };
}

const DEEP_WANT = 2;
const DEEP_CHUNK = 10000;

const modesOf = (opts) => (opts.tails ? ["tails"] : ["ordered", "scrambled"]);

const whole = (result, opts) => (opts.tails ? { whole: result.caught.filter((one) => !one.cut).length } : {});

const line = (row, modes) => modes.map((mode) => `${mode} ${row[mode].caught}/${row[mode].of}`).join(", ");

async function mutants(opts) {
  const rows = [];
  const modes = modesOf(opts);
  const [part, parts] = opts.slice;
  const wanted = (name) => (opts.only.length ? opts.only.includes(name) : !name.startsWith("file-") && !name.startsWith("wire-") && !name.startsWith("host-") && (opts.removals ? name.startsWith("record-") : !name.startsWith("record-")));
  for (const plant of Object.keys(PLANTS).filter(wanted).filter((_, at) => at % parts === part)) {
    const row = { plant, about: PLANTS[plant] };
    for (const mode of modes) {
      const result = await sweep({ ...opts, plant, mode: opts.tails ? opts.mode : mode, from: 1, to: opts.mutants });
      row[mode] = { caught: result.failures, of: result.seeds, ...whole(result, opts), classes: result.classes, first: result.caught[0]?.message ?? "", alone: result.alone };
    }
    rows.push(row);
    console.log(`${plant}: ${line(row, modes)}`);
  }
  for (const row of rows.filter((one) => modes.reduce((sum, mode) => sum + one[mode].caught, 0) < DEEP_WANT)) {
    for (const mode of modes) {
      const cell = row[mode];
      for (let from = opts.mutants + 1; from <= opts.deep && cell.caught < DEEP_WANT; from += DEEP_CHUNK) {
        const result = await sweep({ ...opts, plant: row.plant, mode: opts.tails ? opts.mode : mode, from, to: Math.min(opts.deep, from + DEEP_CHUNK - 1) });
        cell.caught += result.failures;
        cell.of += result.seeds;
        if (opts.tails) cell.whole += whole(result, opts).whole;
        cell.first ||= result.caught[0]?.message ?? "";
        cell.alone.push(...result.alone);
        for (const [key, count] of Object.entries(result.classes)) cell.classes[key] = (cell.classes[key] ?? 0) + count;
      }
    }
    console.log(`${row.plant}, more seeds: ${line(row, modes)}`);
  }
  return rows;
}

if (isMainThread && process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--manifest") {
  const sources = sourceHashes();
  const manifest = { lab: "ordered-fable", node: process.version, cpus: os.availableParallelism(), box: process.env.TESTBOX_RUN_ID ?? "", at: new Date().toISOString(), files: Object.keys(sources).length, tree: crypto.createHash("sha256").update(JSON.stringify(sources)).digest("hex"), sources };
  if (process.argv[3]) fs.writeFileSync(process.argv[3], `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`${manifest.files} files, tree ${manifest.tree}`);
  process.exit(0);
}

if (isMainThread && process.argv[1] === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const header = { lab: "ordered-fable", node: process.version, cpus: os.availableParallelism(), box: process.env.TESTBOX_RUN_ID ?? process.env.TESTBOX ?? "", at: new Date().toISOString(), tree: crypto.createHash("sha256").update(JSON.stringify(sourceHashes())).digest("hex") };
  let report;
  let bad;
  if (opts.mutants) {
    const rows = await mutants(opts);
    const modes = modesOf(opts);
    const missed = rows.filter((row) => modes.every((mode) => !row[mode].caught)).map((row) => row.plant);
    const oneMode = rows.filter((row) => modes.some((mode) => row[mode].caught) && modes.some((mode) => !row[mode].caught)).map((row) => row.plant);
    report = { ...header, kind: "mutants", seedsPerPlant: opts.mutants, deepSeeds: opts.deep, slice: opts.slice, steps: opts.steps, profile: opts.profile, tails: opts.tails, row: opts.row ?? null, flip: opts.flip, short: opts.short, only: opts.only, faults: opts.faults ?? null, removals: opts.removals, missed, oneMode, rows };
    bad = missed.length > 0;
    console.log(missed.length ? `not caught by the fuzzer: ${missed.join(", ")}` : `every plant is caught by the fuzzer`);
    if (oneMode.length) console.log(`caught in one delivery mode only: ${oneMode.join(", ")}`);
  } else {
    const result = await sweep(opts);
    report = { ...header, kind: "sweep", args: { seeds: `${opts.from}..${opts.to}`, steps: opts.steps, mode: opts.mode, profile: opts.profile, tails: opts.tails, row: opts.row ?? null, flip: opts.flip, short: opts.short, plant: opts.plant, without: opts.without, faults: opts.faults ?? null, removals: opts.removals }, ...result, caught: result.caught.slice(0, 200), shrunk: shrunk(result.caught, opts) };
    bad = result.failures > 0;
    console.log(JSON.stringify({ mode: opts.tails ? `tails ${opts.tails}` : opts.mode, seeds: result.seeds, steps: opts.steps, plant: opts.plant, without: opts.without, failures: result.failures, classes: result.classes, ...(opts.plant ? { alone: result.alone.length } : {}), ...(opts.tails ? { cut: result.cut, rows: result.rows } : {}), ms: result.ms }));
    console.log(JSON.stringify({ totals: result.totals, max: result.max }));
    for (const one of report.shrunk) console.log(`seed ${one.seed}: ${one.message}\n  ${one.shown.map((move) => move.join(" ")).join("\n  ")}`);
  }
  if (opts.out) {
    fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    fs.writeFileSync(opts.out, `${JSON.stringify(report, null, 1)}\n`);
  }
  process.exit(bad ? 1 : 0);
}
