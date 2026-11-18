import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runAll } from "../harness/scenarios.mjs";
import { fuzz } from "../harness/fuzz.mjs";
import { fuzzFile, runFile, FILE_PLANTS } from "../harness/filefuzz.mjs";
import { run, runMoves } from "../harness/gen.mjs";
import { PLANTS, usePlant } from "../core/planted.mjs";
import { newWorld, join, userEdit, setConnected, roomLoss, restore, quiesce, toRoom, toTab, answer, step, linking } from "../harness/world.mjs";
import { checkEnd } from "../harness/oracle.mjs";
import { page, parsePage, serialize, parse } from "../core/record.mjs";
import { W } from "../core/ledger.mjs";
import { frameBytes, actionBytes, FRAME_OVERHEAD } from "../core/limits.mjs";
import { get, readRecovery } from "../harness/host.mjs";
import { replay } from "../core/recover.mjs";
import * as F from "../harness/fileworld.mjs";

const lab = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function sessionWithStoredCopies() {
  const world = newWorld();
  const a = join(world);
  join(world);
  while (world.inflight.length) answer(world, "ok");
  userEdit(world, a, { t: "set", row: "r1", col: "c2", value: "backed up" });
  while (toRoom(world, a));
  while (toTab(world, a));
  restore(world, 0);
  userEdit(world, a, { t: "set", row: "r1", col: "c3", value: "held" });
  while (toRoom(world, a));
  while (toTab(world, a));
  setConnected(world, a, false);
  for (let i = 0; i <= W; i++) {
    roomLoss(world);
    while (world.inflight.length) answer(world, "ok");
  }
  setConnected(world, a, true);
  return quiesce(world);
}

const ENV_FIELDS = new Set(["limits", "removals", "split", "port", "observer"]);

function coreProblems(files) {
  const problems = [];
  for (const [name, text] of files) {
    for (const [, spec] of text.matchAll(/^\s*(?:import|export)\b[^"'`;]*?\bfrom\s*["']([^"']+)["']/gm)) if (!/^\.\/[\w-]+\.mjs$/.test(spec)) problems.push(`${name} imports ${spec}`);
    for (const [, spec] of text.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)/g)) problems.push(`${name} imports ${spec} at run time`);
    for (const [, field] of text.matchAll(/(?<![.\w])env\.(\w+)/g)) if (!ENV_FIELDS.has(field)) problems.push(`${name} reads env.${field}`);
  }
  return problems;
}

test("core imports only core, and reads only limits, removals, split, port and observer from the env it is given", () => {
  const dir = path.join(lab, "core");
  const files = readdirSync(dir).filter((name) => name.endsWith(".mjs")).map((name) => [name, readFileSync(path.join(dir, name), "utf8")]);
  assert.ok(files.length >= 12);
  assert.deepEqual(coreProblems(files), []);
  const planted = [["tab.mjs", 'import { get } from "../harness/host.mjs";\nimport { act } from "../codec-tiny/reducer.mjs";\nexport const read = (env) => env.host;\nconst late = () => import("../harness/oracle.mjs");\n']];
  assert.deepEqual(coreProblems(planted), ["tab.mjs imports ../harness/host.mjs", "tab.mjs imports ../codec-tiny/reducer.mjs", "tab.mjs imports ../harness/oracle.mjs at run time", "tab.mjs reads env.host"]);
});

test("the end check reads every recovery copy and backup back from host storage", () => {
  const clean = sessionWithStoredCopies();
  assert.ok(clean.host.recoveries.length > 0 && clean.oracle.backups.length > 0);
  checkEnd(clean, join);
  const blanked = sessionWithStoredCopies();
  blanked.host.recoveries[0].body = page({ ...parsePage(blanked.host.recoveries[0].body).record, edits: [] }, { rows: {} });
  assert.throws(() => checkEnd(blanked, join), /R3 the stored recovery copy r1 does not hold t1:2, which a notice lists/);
  const altered = sessionWithStoredCopies();
  const { record, wb } = parsePage(altered.host.recoveries[0].body);
  record.edits[0].action = { ...record.edits[0].action, value: "not what the tab typed" };
  altered.host.recoveries[0].body = page(record, wb);
  assert.throws(() => checkEnd(altered, join), /R3 the stored recovery copy r1 holds an action for t1:2 that differs from the one its tab authored/);
  const repainted = sessionWithStoredCopies();
  const stored = parsePage(repainted.host.recoveries[0].body);
  repainted.host.recoveries[0].body = page(stored.record, { rows: {} });
  assert.throws(() => checkEnd(repainted, join), /R3 the preview of stored recovery copy r1 is not the document/);
  const dropped = sessionWithStoredCopies();
  dropped.host.recoveries.length = 0;
  assert.throws(() => checkEnd(dropped, join), /R4/);
  const backup = sessionWithStoredCopies();
  const version = backup.host.versions.find((one) => one.kind === "backup");
  version.body = backup.host.versions[0].body.replace(backup.host.versions[0].commit, version.commit);
  assert.throws(() => checkEnd(backup, join), /R1 the stored backup/);
});

test("every scenario passes and every planted defect makes its scenario fail", () => {
  const result = runAll();
  assert.ok(result.rows.length >= 60);
  for (const row of result.rows) {
    assert.equal(row.passes, true, `${row.name}: ${row.message}`);
    assert.ok(row.mutations.length > 0, `${row.name} has no planted defect`);
    for (const mutation of row.mutations) assert.equal(mutation.ok, false, `${row.name} still passes with ${mutation.plant}`);
  }
  assert.deepEqual(result.unused, []);
  assert.equal(new Set(result.rows.flatMap((row) => row.mutations.map((mutation) => mutation.plant))).size, Object.keys(PLANTS).length);
});

test("the HTML table codec returns the same rows, cells and record for text that needs escaping", () => {
  const wb = { rows: { 'r<1>"': { pos: 'a"0&', cells: { "c&1": 'quote " & <script> café 🐈 </td><td data-col="c3">x &amp; &lt;', c2: "</script><script>alert(1)</script>" } }, r2: { pos: "b", cells: {} } } };
  const state = { wb, seen: { "t<1": [3, 2] }, lineage: [["1.00000001", 4]], cut: null, floor: -1 };
  const body = serialize({ v: 2, gen: "2.00000002", commit: "c<1" }, state);
  assert.equal(body.split("<script").length, 2);
  assert.equal(body.split("<td ").length, 3);
  assert.deepEqual(parse(body), { record: { v: 2, gen: "2.00000002", commit: "c<1" }, state });
  assert.deepEqual(parsePage(page({ recovery: "r1" }, wb)).wb, wb);
});

for (const mode of ["ordered", "scrambled"]) {
  test(`fuzz smoke, ${mode} delivery: 150 seeds at 400 moves hold every invariant`, () => {
    const result = fuzz({ from: 1, to: 150, steps: 400, mode });
    assert.deepEqual(result.caught, []);
    for (const key of ["edits", "saved", "losses", "expired", "outside", "restores", "adopted", "copy", "refused", "hostRefused"]) assert.ok(result.totals[key] > 0, `the sweep never exercised ${key}`);
  });
}

test("the fuzzer catches the three defects that were rare or scenario-only, in both delivery modes", () => {
  for (const plant of ["no-idle-check", "412-no-fetch", "receipt-any-gen"]) {
    for (const mode of ["ordered", "scrambled"]) {
      const result = fuzz({ from: 1, to: 120, steps: 400, mode, plant });
      assert.ok(result.failures > 0, `${plant} went unnoticed in 120 ${mode} seeds`);
    }
  }
});

test("file-only mode: 300 seeds hold every invariant and the fuzzer catches the common file-only defects", () => {
  const clean = fuzzFile({ from: 1, to: 300, steps: 300 });
  assert.deepEqual(clean.caught, []);
  assert.ok(clean.totals.accepted > 0 && clean.totals.refused > 0 && clean.totals.replaced > 0 && clean.totals.copies > 0);
  const common = ["file-save-no-rebase", "file-save-unconditional", "file-unknown-resend", "file-ack-on-send", "file-resend-saved", "file-refuse-silent", "file-no-ledger-trim"];
  assert.ok(common.every((plant) => FILE_PLANTS.includes(plant)));
  for (const plant of common) assert.ok(fuzzFile({ from: 1, to: 150, steps: 300, plant }).failures > 0, `${plant} went unnoticed in 150 seeds`);
});

test("file-only mode with pushed documents: 300 seeds hold every invariant and the fuzzer catches the push and copy defects", () => {
  const clean = fuzzFile({ from: 1, to: 300, steps: 300, profile: "v2" });
  assert.deepEqual(clean.caught, []);
  assert.ok(clean.totals.pushes > 1000 && clean.totals.copies > 0 && clean.totals.stored > 0 && clean.totals.replayUnjudged > 0);
  for (const plant of ["file-push-skips-rebase", "file-push-skips-settle", "file-copy-table-only", "file-copy-keeps-saved", "restore-skips-ledger"]) {
    assert.ok(fuzzFile({ from: 1, to: 300, steps: 300, plant, profile: "v2" }).failures > 0, `${plant} went unnoticed in 300 seeds`);
  }
});

test("Astra's file-only fixture: a value shown as recovered is in stored bytes or in a notice, in all four of its cases", () => {
  for (const [ledgerCap, lost, removeRow] of [[102, true, true], [2048, true, true], [2048, false, true], [2048, true, false]]) {
    const world = F.newFileWorld({ ledgerCap });
    const author = F.open(world);
    const other = F.open(world);
    const value = "unique recovery value";
    const turn = (tab, at = 0, gone = false) => {
      F.save(world, tab);
      F.hostTake(world);
      F.deliver(world, at, gone);
      F.checkFileStep(world);
    };
    const id = F.edit(world, author, { t: "set", row: "r3", col: "c2", value });
    F.edit(world, other, removeRow ? { t: "del", row: "r3" } : { t: "set", row: "r2", col: "c1", value: "other edit" });
    turn(other);
    turn(author);
    assert.equal(author.pending.length, 1);
    turn(author, 0, lost);
    for (let guests = 0; author.client in get(world.host).state.seen; guests++) {
      assert.ok(guests < 300);
      const guest = F.open(world);
      F.edit(world, guest, { t: "set", row: "r1", col: "c1", value: `guest ${guests}` });
      turn(guest);
      F.close(world, guest);
    }
    F.refresh(world, author);
    F.finish(world);
    const inStorage = [world.host.body, ...world.host.versions.map((version) => version.body), ...world.host.recoveries.map((copy) => copy.body)].some((body) => body.includes(value));
    const inNotice = author.notices.some((notice) => notice.action?.value === value);
    const { state } = author.edits.get(id);
    if (!lost) {
      assert.equal(state, removeRow ? "dropped" : "saved");
      assert.ok(removeRow ? inNotice : inStorage);
      continue;
    }
    assert.equal(state, "recovered");
    assert.ok(inStorage, "the tab shows the value as recovered, and no stored bytes hold it");
    const notice = author.notices.find((one) => one.kind === "recovery" && one.edits.includes(id));
    const copy = readRecovery(world.host, notice.copy);
    const entry = copy.edits.find((one) => one.e === id);
    assert.deepEqual(entry.action, { t: "set", row: "r3", col: "c2", value });
    assert.deepEqual([entry.out, entry.sent[1], copy.preview.rows.r3?.cells.c2], removeRow ? ["unanswered", false, undefined] : ["unanswered", true, value]);
    assert.deepEqual(replay(get(world.host), copy).decisions, [{ e: id, how: "unjudged" }]);
  }
});

test("Astra's refusal fixture: the two disputed seeds pass, and each control on the scoped end check still fails", () => {
  const joinNow = (world) => {
    const tab = join(world);
    for (let turns = 0; turns < 8 && linking(tab); turns++) step(world, tab);
    return tab;
  };
  for (const [seed, id] of [[1009981, "t23:1"], [1351660, "t6:1"]]) {
    const world = run(seed, 400, { mode: "ordered", profile: "v3" });
    const { oracle } = world;
    const edit = oracle.edits.get(id);
    const author = world.tabs.find((tab) => tab.id === edit.by);
    assert.ok(oracle.everRefused.has(id) && !oracle.refused.has(id), "the reference refused the edit once, and a later generation applied it");
    assert.ok(author.alive && author.edits.get(id).state === "dropped");
    assert.doesNotThrow(() => checkEnd(world, joinNow));
    const notices = author.notices;
    author.notices = notices.filter((notice) => !notice.edits?.includes(id) || notice.kind !== "refused");
    assert.throws(() => checkEnd(world, joinNow), /^Error: P6 .* shows dropped with no refusal notice that holds its action/);
    author.notices = notices;
    const notice = notices.find((one) => one.kind === "refused" && one.edits.includes(id));
    const { action } = notice;
    notice.action = { t: "set", row: "r1", col: "c1", value: "wrong" };
    assert.throws(() => checkEnd(world, joinNow), /^Error: P6 .* shows dropped with no refusal notice that holds its action/);
    notice.action = action;
    const mine = author.edits.get(id);
    mine.state = "saved";
    assert.throws(() => checkEnd(world, joinNow), /^Error: P1 .* as saved, and no accepted file holds it/);
    mine.state = "dropped";
    const sticky = oracle.everRefused.get(id);
    oracle.everRefused.delete(id);
    assert.throws(() => checkEnd(world, joinNow), /^Error: P6 .* with no saved file, no recovery copy and no refusal/);
    oracle.everRefused.set(id, sticky);
    const owed = oracle.owed.get(id);
    oracle.owed.set(id, new Set([author]));
    assert.throws(() => checkEnd(world, joinNow), /^Error: P3 /);
    if (owed) oracle.owed.set(id, owed);
    else oracle.owed.delete(id);
    oracle.saved.set(id, oracle.live);
    assert.throws(() => checkEnd(world, joinNow), /^Error: P2 /);
    oracle.saved.delete(id);
    assert.doesNotThrow(() => checkEnd(world, joinNow));
  }
});

test("the four seeds that were red or disputed after hardening pass, and each fails again with its old behaviour planted", () => {
  for (const seed of [1244295, 1609985, 1009981, 1351660]) run(seed, 400, { mode: "ordered", profile: "v3" });
  const planted = (seed, plant) => {
    const result = fuzz({ from: seed, to: seed, steps: 400, mode: "ordered", profile: "v3", plant });
    return result.caught[0]?.message ?? "";
  };
  assert.match(planted(1609985, "copy-keeps-saved"), /^R7 recovery copy r2 stores t7:1, and the lineage of the file it was judged against/);
  assert.match(planted(1244295, "restore-skips-ledger"), /^R3 a second replay of recovery copy r3 onto c00000000011 took t3:1 as new, and that file's history already holds it/);
  assert.match(planted(1009981, "refusal-notice-no-action"), /^P6 t23:1 of open tab t23 was refused/);
  assert.match(planted(1351660, "copy-outcome-applied"), /^R3 the stored recovery copy r3 stores t6:1 as applied at 9.00000011#3, and the room refused it there/);
});

test("the fuzzer fails when a defect is planted", () => {
  for (const plant of ["ack-on-delivery", "unconditional-save", "row-granularity", "restore-no-backup", "copy-not-adopt"]) {
    const result = fuzz({ from: 1, to: 40, steps: 400, mode: "scrambled", plant });
    assert.ok(result.failures > 0, `${plant} went unnoticed in 40 seeds`);
  }
});

test("the witness seeds from earlier findings still pass", () => {
  const seeds = JSON.parse(readFileSync(path.join(lab, "harness/regressions.json"), "utf8"));
  assert.ok(seeds.length >= 37);
  for (const { seed, mode, profile = "v1", limits, steps = 400, moves, faults, removals, end } of seeds) {
    if (mode === "file") runFile(seed, 300, { profile });
    else if (moves) runMoves(moves, { mode, profile, seed, limits, faults, removals, end });
    else run(seed, steps, { mode, profile, limits });
  }
});

const compare = (design, holder, env = {}) =>
  JSON.parse(
    execFileSync(process.execPath, [path.join(lab, "harness/shared/compare.mjs"), "--design", design, "--holder", holder, "--seeds", "1..150", "--steps", "500"], { env: { ...process.env, ...env }, encoding: "utf8" }).split("\n")[0],
  );

test("the shared oracle fails the current rules and passes union recovery and the ordered room", () => {
  const current = compare("current", "connected");
  assert.ok(current.failedStrict > 0, "the shared oracle did not catch the known loss in the current rules");
  assert.equal(current.S1, 0);
  const union = compare("union", "connected");
  assert.equal(union.failedStrict, 0);
  assert.ok(union.obligations > 1000);
  const ordered = compare("ordered", "connected");
  assert.equal(ordered.failedStrict, 0);
  assert.equal(ordered.native, 0);
  assert.equal(ordered.crashed, 0);
  assert.ok(ordered.obligations > 1000);
});

test("the value-based holder reading passes the ordered room and union recovery, and catches an old value sent again under a new id", () => {
  for (const design of ["ordered", "union"]) {
    const clean = compare(design, "connected");
    assert.equal(clean.holderFailed, 0, `${design} fails the holder reading`);
    assert.ok(clean.holderRequired > 1000);
  }
  const resent = compare("union", "connected", { PLANT: "resend-uncertain" });
  assert.equal(resent.failedStrict, 0, "the id-based reading was expected to miss this defect");
  assert.ok(resent.holderFailed > 0 && resent.H9 > 0, "the holder reading did not catch the resent value");
  assert.ok(compare("current", "connected").holderFailed > 0, "the holder reading did not catch the known loss in the current rules");
});

test("the directed witnesses: only the current rules lose a held edit, and nothing keeps an edit no tab holds", () => {
  const rows = JSON.parse(execFileSync(process.execPath, [path.join(lab, "harness/shared/witness.mjs")], { encoding: "utf8" }).split("\n")[0]);
  const kept = Object.fromEntries(rows.map((row) => [row.witness, [row.current.kept, row.union.kept, row.ordered.kept]]));
  assert.deepEqual(kept["author closes, a holder stays, the room is lost"], [false, true, true]);
  assert.deepEqual(kept["a holder that was offline at the loss comes back"], [false, true, true]);
  assert.deepEqual(kept["every tab closes, then the room is lost"], [false, false, false]);
  for (const row of rows) assert.equal(row.ordered.native, null);
});

test("fix round 2: copy writes fail at any rate, retries included, and the two defects of the old fault model are caught", () => {
  for (const [mode, profile, faults] of [["ordered", "v3", { rate: 0.5, run: 4 }], ["scrambled", "v4", { rate: 1, run: 8 }]]) {
    const result = fuzz({ from: 1, to: 120, steps: 400, mode, profile, faults });
    assert.equal(result.failures, 0, JSON.stringify(result.caught.slice(0, 2)));
    assert.ok(result.totals.copyFaults > 100 && result.totals.copyWrites > result.totals.copyFaults, "the sessions had failed copy writes and writes that went through");
  }
  const unsettled = fuzz({ from: 1, to: 400, steps: 400, mode: "ordered", profile: "v3", faults: { rate: 0.5, run: 4 }, plant: "unstored-edit-settles" });
  assert.ok(unsettled.caught.some((one) => /^P1 .* as saved, and no accepted file holds it/.test(one.message)), "Opus finding 1 went unnoticed");
  const rewritten = fuzz({ from: 1, to: 60, steps: 400, mode: "ordered", profile: "v3", plant: "copy-written-again" });
  assert.ok(rewritten.caught.some((one) => /^R4 .* again after its bytes were confirmed/.test(one.message)), "Opus finding 2 went unnoticed");
});

test("fix round 2: restores from a copy in the room hold every invariant, and each restore defect is caught", () => {
  for (const mode of ["ordered", "scrambled"]) {
    const result = fuzz({ from: 1, to: 200, steps: 400, mode, profile: "v5" });
    assert.equal(result.failures, 0, JSON.stringify(result.caught.slice(0, 2)));
    const { restoreJobs, restoreApplied, restoreConflict, restoreLeft, replayConflict, marks, endLate, copyFaults } = result.totals;
    assert.ok(restoreJobs > 50 && restoreApplied > 10 && restoreConflict > 5 && restoreLeft > 100, `the sessions ran too few room restores: ${JSON.stringify({ restoreJobs, restoreApplied, restoreConflict, restoreLeft })}`);
    assert.ok(replayConflict > 20 && marks > 20 && endLate > 20 && copyFaults > 50);
  }
  for (const [plant, message] of [
    ["room-restore-trusts-the-tab", /^R[38] the room of /],
    ["restore-notice-before-save", /^R9 .* and no accepted file holds that/],
    ["restore-job-forgets", /^R9 .* answered nothing for it|^I8 /],
    ["restore-ignores-seen", /^R8 .* a value its author did not see/],
  ]) {
    const result = fuzz({ from: 1, to: 150, steps: 400, mode: "ordered", profile: "v5", plant });
    assert.ok(result.caught.some((one) => message.test(one.message)), `${plant} went unnoticed in 150 seeds`);
  }
});

test("fix round 3: decisions, holds and notice outcomes hold every invariant, and each of their defects is caught", () => {
  for (const mode of ["ordered", "scrambled"]) {
    const result = fuzz({ from: 1, to: 200, steps: 400, mode, profile: "v7" });
    assert.equal(result.failures, 0, JSON.stringify(result.caught.slice(0, 2)));
    const { decideJobs, decideTaken, decideKept, restoreConflict, restoreSaved, restoreReplaced, restoreCounted, takeChosen, takeReleased, keepKept, keepReleased } = result.totals;
    assert.ok(decideJobs > 10 && decideTaken + decideKept > 3 && restoreConflict > 40, `the sessions ran too few decisions: ${JSON.stringify({ decideJobs, decideTaken, decideKept, restoreConflict })}`);
    assert.ok(restoreSaved > 30 && restoreReplaced > 30 && restoreCounted > 30, `the notices list too few outcomes: ${JSON.stringify({ restoreSaved, restoreReplaced, restoreCounted })}`);
    assert.ok(takeChosen > 80 && takeReleased > 10 && keepKept > 80, `the oracle decided too few conflicts on its own: ${JSON.stringify({ takeChosen, takeReleased, keepKept, keepReleased })}`);
  }
  for (const [plant, message, from = 1] of [
    ["decision-keep-not-counted", /^R3 .* with a person's decision to keep the current value for each conflict returned a ledger/],
    ["decision-applies-twice", /^R3 repeated .* took t\S+ as new, and that file's history already holds it/],
    ["decision-take-unchecked", /^R8 .* a value that neither its author saw nor the person who chose the copy's value reviewed/],
    ["notice-wrong-current-value", /^R9 .* shows the conflict of .* with cells that are not the current value/],
    ["notice-counted-as-saved", /^R9 .* as saved, and the room of \S+ answered counted for it/],
    ["ledger-before-cut", /^R9 .* the cut record is checked before the ledger/],
    ["restore-out-of-order", /^R10 .* edits of one copy that write the same cell are restored in their order/, 201],
    ["kept-edit-shown-as-saved", /^P6 \S+ was refused, and \S+ shows it as saved/, 201],
  ]) {
    const result = fuzz({ from, to: from + 199, steps: 400, mode: "ordered", profile: "v7", plant });
    assert.ok(result.caught.some((one) => message.test(one.message)), `${plant} went unnoticed in seeds ${from} to ${from + 199}`);
  }
});

test("fix round 3: the reviewers' three witnesses pass, and each fails again when a defect is planted", () => {
  const rows = JSON.parse(readFileSync(path.join(lab, "harness/regressions.json"), "utf8")).filter((row) => [35801, 6035854, 5218915].includes(row.seed) && row.found.startsWith("fix round 3"));
  assert.equal(rows.length, 3);
  const play = ({ moves, mode, profile, seed, faults }, plant = "") => {
    usePlant(plant);
    try {
      runMoves(moves, { mode, profile, seed, faults });
      return "";
    } catch (error) {
      return error.message;
    } finally {
      usePlant("");
    }
  };
  for (const row of rows) assert.equal(play(row), "");
  assert.match(play(rows[0], "later-edit-held-anyway"), /^R11 .* left t2:2 as an edit that cannot be judged, and the count of t2 stands at 1, one below it/);
  assert.match(play(rows[1], "store-forgets-a-refusal"), /^R3 t7 shows t7:1 as recovered after it saw the room of \S+ count and refuse it/);
  assert.match(play(rows[2], "skips-an-open-request"), /^R5 .* is still an open request of its tab: the tab skipped it/);
});

test("fix round 4: later edits are judged on their own, passes are recorded, and each form 15 defect is caught", () => {
  for (const mode of ["ordered", "scrambled"]) {
    const result = fuzz({ from: 1, to: 200, steps: 400, mode, profile: "v7" });
    assert.equal(result.failures, 0, JSON.stringify(result.caught.slice(0, 2)));
    const { marks, markFaults, endLate, lateTakes, restoreConflict, restoreHeld } = result.totals;
    assert.ok(marks > 150 && markFaults > 50 && endLate > 80 && lateTakes > 0 && restoreConflict > 100 && restoreHeld > 50, `the sessions passed too few conflicts: ${JSON.stringify({ marks, markFaults, endLate, lateTakes, restoreConflict, restoreHeld })}`);
  }
  for (const [plant, message] of [
    ["later-edit-held-anyway", /^R11 .* as an edit that cannot be judged, and the count of \S+ stands at \d+, one below it/],
    ["delete-ignores-a-changed-seen-cell", /^R8 .* wrote t\S+ into \S+ over .*, a value its author did not see/],
    ["pass-without-record", /^R11 .* returned a decision record that does not list exactly the edits it passed over/],
    ["restore-ignores-record", /^R11 .* by the ledger, and the decision record lists it as an edit that a restore passed over/],
    ["restored-delete-hides-removed-values", /^R9 .* removed \d+ values its author did not see, and it removed \d+/],
  ]) {
    const result = fuzz({ from: 1, to: 200, steps: 400, mode: "ordered", profile: "v7", plant });
    assert.ok(result.caught.some((one) => message.test(one.message)), `${plant} went unnoticed in 200 seeds`);
  }
});

test("fix round 5: a returned restore or take is judged again, deletes name what they removed, and each defect is caught", () => {
  for (const mode of ["ordered", "scrambled"]) {
    const result = fuzz({ from: 1, to: 300, steps: 400, mode, profile: "v8" });
    assert.equal(result.failures, 0, JSON.stringify(result.caught.slice(0, 2)));
    const { returnedJudged, returnedSessions, removedLists, lullsAway, placesOpen } = result.totals;
    assert.ok(returnedJudged > 20 && returnedSessions > 8 && removedLists > 5 && lullsAway > 200 && placesOpen > 1, `the sessions reached too few returned frames: ${JSON.stringify({ returnedJudged, returnedSessions, removedLists, lullsAway, placesOpen })}`);
    const held = fuzz({ from: 1, to: 100, steps: 400, mode, profile: "v3", plant: "save-waits-for-every-tab" });
    assert.ok(held.caught.length > 20 && held.caught.every((one) => /^I8 stuck: the connected tabs did not settle/.test(one.message)), `a save that waits for an absent tab went unnoticed: ${held.caught.length} of 100`);
  }
  for (const [plant, to, message] of [
    ["returned-frame-not-judged-again", 200, /^R8 .* a frame from a backup or a take is judged again when it returns/],
    ["oracle-skips-returned-frames", 50, /^G3 the room judged \d+ frames again that a backup or a take had brought into a lost room, and the oracle checked \d+ of them/],
    ["taken-delete-hides-removed-values", 500, /^R9 .* removed 0 values its author did not see, and it removed \d+/],
    ["place-closes-an-open-edit", 400, /^R11 a copy that lists .* by its place .* is replayed onto the final file as covered by a file position/],
  ]) {
    const result = fuzz({ from: 1, to, steps: 400, mode: "ordered", profile: "v8", plant });
    assert.ok(result.caught.some((one) => message.test(one.message)), `${plant} went unnoticed in ${to} seeds`);
  }
  const recorded = fuzz({ from: 1, to: 300, steps: 400, mode: "scrambled", profile: "v8", removals: true });
  assert.equal(recorded.failures, 0, JSON.stringify(recorded.caught.slice(0, 2)));
  assert.ok(recorded.totals.removalEntries > 5 && recorded.totals.removalHeld === recorded.totals.removalEntries && recorded.totals.removalMissed === 0, `the record of removed values does not list exactly the deletes that a save held: ${JSON.stringify({ entries: recorded.totals.removalEntries, held: recorded.totals.removalHeld, missed: recorded.totals.removalMissed })}`);
  const missed = fuzz({ from: 1, to: 600, steps: 400, mode: "ordered", profile: "v8", removals: true, plant: "record-misses-removed-values" });
  assert.ok(missed.caught.some((one) => /^R12 .* the record of removed values does not list it/.test(one.message)), "record-misses-removed-values went unnoticed in 600 seeds");
});

test("fix round 6: steered tails reach returned frames and row waits, the record goes with the save, and each defect is caught through a tail", () => {
  for (const tails of ["ret", "wait"]) {
    const result = fuzz({ from: 1, to: 500, steps: 100, tails });
    assert.equal(result.failures, 0, JSON.stringify(result.caught.slice(0, 2)));
    assert.ok(result.rows > 80 && result.totals.returnedJudged > 50, `the tails reached too little: ${JSON.stringify({ rows: result.rows, returnedJudged: result.totals.returnedJudged })}`);
  }
  const short = fuzz({ from: 1, to: 300, steps: 100, tails: "ret", short: true });
  assert.equal(short.failures, 0, JSON.stringify(short.caught.slice(0, 2)));
  assert.ok(short.cut > 100, `too few tails start from a shortened row: ${short.cut}`);
  const waits = fuzz({ from: 1, to: 400, steps: 100, tails: "wait", row: 112 });
  assert.equal(waits.failures, 0, JSON.stringify(waits.caught.slice(0, 2)));
  const earlier = fuzz({ from: 1, to: 200, steps: 100, tails: "wait", row: 163 });
  assert.equal(earlier.failures, 0, JSON.stringify(earlier.caught.slice(0, 2)));
  assert.ok(waits.totals.rowWaits > 50 && waits.totals.rowWaitsTurned > 3 && earlier.totals.rowWaitsEarlier > 50, `the tails reached too few row waits: ${JSON.stringify({ rowWaits: waits.totals.rowWaits, turned: waits.totals.rowWaitsTurned, earlier: earlier.totals.rowWaitsEarlier })}`);
  for (const [plant, tails, row, to, message] of [
    ["skipped-frame-settles-an-open-edit", "ret", 136, 300, /^R11 .* and the decision record lists it as an edit that a restore passed over and no person has decided/],
    ["place-closes-a-mark", "ret", 145, 300, /^(P6|P1|R11) /],
    ["refused-pass-without-record", "ret", 144, 100, /^R11 .* returned a decision record that does not list exactly the edits it passed over/],
    ["returned-delete-shows-no-removed-notice", "ret", 135, 300, /^R9 .* shows no notice that lists them \(rule 105\)/],
    ["ledger-turn-ends-the-row-wait", "wait", 112, 300, /^R10 .* the room that follows that lost room is still open, also after it turned its ledger/],
    ["row-wait-ends-a-room-early", "wait", 112, 100, /^R10 /],
    ["row-wait-counts-from-the-insert", "wait", 163, 100, /^R10 .* the room that follows that lost room is still open/],
    ["copy-forgets-unsaved-inserts", "wait", 112, 100, /^P6 .* was refused, and its row .* is in the final file/],
    ["row-wait-ends-at-the-ledger-floor", "ret", 136, 400, /^R10 .* counted .* as refused, and its row .* is missing/],
    ["oracle-trusts-the-ledger-floor", "wait", 165, 1000, /^R10 the room of .* adopted the insert .* after the room of .* refused/],
    ["retire-on-stale-file", "ret", 169, 300, /^R2 /],
    ["gives-up-before-it-reads-its-save", "ret", 182, 200, /^R7 .* already covers/],
    ["misfit-counted-before-it-is-listed", "ret", 177, 100, /^R11 .* counted it as refused while its row could still come back, before the decision record lists/],
    ["row-wait-ends-at-the-named-place", "wait", 178, 100, /^R10 .* counted it as refused, and its row .* is missing/],
    ["record-not-sent-with-the-final-save", "ret", 168, 600, /^R12 .* the entry goes with the save that first holds the delete \(rules 109 and 125\)/],
  ]) {
    const result = fuzz({ from: 1, to, steps: 100, tails, row, plant });
    assert.ok(result.caught.some((one) => message.test(one.message)), `${plant} went unnoticed in ${to} ${tails} tails: ${JSON.stringify(result.caught.slice(0, 2))}`);
  }
  for (const faults of [undefined, { rate: 0.5, run: 4 }]) {
    const recorded = fuzz({ from: 1, to: 300, steps: 400, mode: "ordered", profile: "v8", removals: true, faults });
    assert.equal(recorded.failures, 0, JSON.stringify(recorded.caught.slice(0, 2)));
    const { removalEntries, removalHeld, removalMissed } = recorded.totals;
    assert.ok(removalEntries > 5 && removalHeld === removalEntries && removalMissed === 0, `the record of removed values does not go with the save: ${JSON.stringify({ removalEntries, removalHeld, removalMissed })}`);
  }
  const unsent = fuzz({ from: 1, to: 300, steps: 400, mode: "ordered", profile: "v8", removals: true, plant: "record-not-sent-with-its-save" });
  assert.ok(unsent.caught.some((one) => /^R12 .* the entry goes with the save that first holds the delete \(rules 109 and 125\)/.test(one.message)), "record-not-sent-with-its-save went unnoticed in 300 seeds");
});

test("fix round 2: the end check fails a saved edit that the final history lost, also when a copy stores the edit", () => {
  const joinNow = (world) => {
    const tab = join(world);
    for (let turns = 0; turns < 8 && linking(tab); turns++) step(world, tab);
    return tab;
  };
  const world = run(4, 400, { mode: "ordered", profile: "v3" });
  const { oracle } = world;
  const final = new Set(oracle.gens.get(oracle.commits.get(oracle.live).gen).done);
  const id = [...oracle.recovered.keys()].find((one) => !final.has(one) && !oracle.saved.has(one) && !oracle.cutOut.has(one) && !oracle.backedUp.has(one) && !oracle.homeless.has(one));
  assert.ok(id, "the session has an edit that only a copy holds");
  assert.doesNotThrow(() => checkEnd(world, joinNow));
  oracle.saved.set(id, "c00000000001");
  assert.throws(() => checkEnd(world, joinNow), /^Error: P2 .* was saved in c00000000001, and the final file's history does not hold it/);
  oracle.saved.delete(id);
  assert.doesNotThrow(() => checkEnd(world, joinNow));
});

test("fix round 2: the frame byte model counts the seen values, the birth epoch, the origin and the path", () => {
  const action = { t: "set", row: "r1", col: "c2", value: "x" };
  const bare = actionBytes(action) + FRAME_OVERHEAD;
  assert.equal(frameBytes(action), bare);
  assert.equal(frameBytes(action, { saw: ["old"] }), bare + 7);
  assert.equal(frameBytes(action, { saw: ["old"], b: 3, org: ["1.00000001", 4], via: [["2.00000002", 1]] }), bare + 7 + 1 + 16 + 18);
});
