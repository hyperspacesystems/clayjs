import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { newWorld, join, userEdit, setConnected, close, roomLoss, expire, restore, outsideWrite, restoreFromCopy, decideConflicts, quiesce, settle, drain, view, toRoom, post, waited, land, dropWire, echo, toTab, capture, answer, hostTake, deliver, read, link, rotate, checkStep, retitle } from "./world.mjs";
import { get, readRecovery, verdict } from "./host.mjs";
import { replay } from "../core/recover.mjs";
import { parse, recordBudget, ledgerBytes } from "../core/record.mjs";
import { W } from "../core/ledger.mjs";
import { tailBudget, admit } from "../core/room.mjs";
import { fileAccepted } from "../core/host.mjs";
import { REAL_LIMITS } from "../core/limits.mjs";
import { FIXTURES } from "./vendor/fixtures.mjs";
import { usePlant, PLANTS } from "../core/planted.mjs";
import * as F from "./fileworld.mjs";
import { rng, fromFixture } from "./lib.mjs";
import { run as replaySeed, runMoves as replayMoves, start as startSeed, MOVES } from "./gen.mjs";
import { runFile } from "./filefuzz.mjs";

function expect(ok, message) {
  if (!ok) throw new Error(`E ${message}`);
}

let armed = "";

function stage(count = 2, options = {}) {
  const world = newWorld({ mode: "ordered", ...options });
  world.rnd = rng(11);
  const step = (fn) => {
    const out = fn();
    checkStep(world);
    return out;
  };
  const s = {
    world,
    join: () => step(() => join(world)),
    type: (tab, row, col, value) => step(() => userEdit(world, tab, { t: "set", row, col, value })),
    paste: (tab, cells) => step(() => userEdit(world, tab, { t: "paste", cells })),
    insert: (tab, row, pos) => step(() => userEdit(world, tab, { t: "ins", row, pos, cells: {} })),
    remove: (tab, row) => step(() => userEdit(world, tab, { t: "del", row })),
    send: (tab, at) =>
      step(() => {
        if (at !== undefined) return toRoom(world, tab, at);
        while (toRoom(world, tab));
      }),
    post: (tab, count = Infinity) =>
      step(() => {
        for (let n = 0; n < count && post(world, tab); n++);
      }),
    land: (at = 0, lost = false) => step(() => land(world, at, lost)),
    drop: (at = 0) => step(() => dropWire(world, at)),
    echo: (at = 0) => step(() => echo(world, at)),
    waited: (tab) => step(() => waited(world, tab)),
    recv: (tab, count = Infinity) =>
      step(() => {
        for (let n = 0; n < count && toTab(world, tab); n++);
      }),
    flow: () => step(() => drain(world)),
    save: (tab) => step(() => capture(world, tab)),
    answer: (how = "ok", at = 0) => step(() => answer(world, how, at)),
    answerAll: () => {
      while (world.inflight.length) s.answer("ok");
      while (world.answers.length) s.deliver();
    },
    host: (at = 0, lost = false) => step(() => hostTake(world, at, lost)),
    deliver: (at = 0, lost = false) => step(() => deliver(world, at, lost)),
    read: (tab) => step(() => read(world, tab)),
    link: (tab) => step(() => link(world, tab)),
    expire: () => step(() => expire(world)),
    offline: (tab) => step(() => setConnected(world, tab, false)),
    online: (tab) => step(() => setConnected(world, tab, true)),
    close: (tab) => step(() => close(world, tab)),
    loseRoom: () => step(() => roomLoss(world)),
    restore: (at) => step(() => restore(world, at)),
    restoreCopy: (tab, copy) => step(() => restoreFromCopy(world, tab, copy)),
    decide: (tab, job, picks) => step(() => decideConflicts(world, tab, job, picks)),
    settle: () => step(() => settle(world)),
    calm: () => step(() => settle(world, false)),
    restored: (tab) => tab.notices.findLast((notice) => notice.kind === "restored"),
    outside: (kind, at, action) => step(() => outsideWrite(world, kind, at, action)),
    rotate: (tab) => step(() => rotate(world, tab)),
    title: (how) => step(() => retitle(world, how)),
    end: () => quiesce(world),
    file: () => get(world.host),
    cell: (row, col) => get(world.host).state.wb.rows[row]?.cells[col],
    status: (tab, id) => tab.edits.get(id).state,
    copyOf: (tab, id) => readRecovery(world.host, tab.edits.get(id).copy),
    stored: (tab, id) => readRecovery(world.host, tab.edits.get(id).copy)?.edits.find((entry) => entry.e === id),
    arm: () => usePlant(armed),
  };
  const tabs = [];
  for (let i = 0; i < count; i++) tabs.push(s.join());
  s.answerAll();
  if (!options.armLater) s.arm();
  return { s, world, tabs };
}

function fileStage(count = 2, options = {}) {
  const world = F.newFileWorld(options);
  const step = (fn) => {
    const out = fn();
    F.checkFileStep(world);
    return out;
  };
  const f = {
    world,
    open: () => step(() => F.open(world)),
    type: (tab, row, col, value) => step(() => F.edit(world, tab, { t: "set", row, col, value })),
    insert: (tab, row, pos) => step(() => F.edit(world, tab, { t: "ins", row, pos, cells: {} })),
    remove: (tab, row) => step(() => F.edit(world, tab, { t: "del", row })),
    save: (tab) => step(() => F.save(world, tab)),
    host: (at = 0, lost = false) => step(() => F.hostTake(world, at, lost)),
    deliver: (at = 0, lost = false) => step(() => F.deliver(world, at, lost)),
    answer: () => step(() => F.hostTake(world) && F.deliver(world)),
    refresh: (tab) => step(() => F.refresh(world, tab)),
    push: (tab, lost = false) => step(() => F.push(world, tab, lost)),
    close: (tab) => step(() => F.close(world, tab)),
    outside: (at, action, raw) => step(() => F.outside(world, at, action, raw)),
    end: () => F.finish(world),
    cell: (row, col) => get(world.host).state.wb.rows[row]?.cells[col],
    status: (tab, id) => tab.edits.get(id).state,
    copyOf: (tab, id) => readRecovery(world.host, tab.notices.find((notice) => notice.kind === "recovery" && notice.edits.includes(id))?.copy),
    guests(count) {
      for (let i = 0; i < count; i++) {
        const guest = f.open();
        f.type(guest, "r1", "c1", `guest-${i}`);
        f.save(guest);
        f.answer();
        f.close(guest);
      }
    },
  };
  const tabs = [];
  for (let i = 0; i < count; i++) tabs.push(f.open());
  usePlant(armed);
  return { f, world, tabs };
}

const FIVE = [
  ["r1", "c2", "a"],
  ["r2", "c2", "b"],
  ["r3", "c2", "c"],
  ["r4", "c2", "d"],
  ["r1", "c3", "e"],
];

const wide = (count, tag) => Array.from({ length: count }, (_, i) => [`r${(i % 4) + 1}`, `k${i}`, `${tag}${i}`]);

function churn(s, writer, count, tag) {
  for (let i = 0; i < count; i++) {
    const tab = s.join();
    s.type(tab, "r4", "c3", `${tag}-${i}`);
    for (let round = 0; round < 4; round++) {
      s.flow();
      s.save(writer);
      s.answerAll();
    }
    s.flow();
    s.close(tab);
  }
}

function lineage(losses, copy) {
  const { s, world, tabs } = stage();
  const [a, b] = tabs;
  const id = s.type(a, "r1", "c2", "held");
  s.send(a);
  s.recv(a);
  s.offline(a);
  for (let i = 0; i < losses; i++) {
    s.loseRoom();
    s.answerAll();
  }
  s.online(a);
  s.end();
  if (!copy) {
    expect(s.cell("r1", "c2") === "held", "the held edit reaches the document");
    expect(s.status(a, id) === "saved", "the tab shows it saved");
    expect(!world.host.recoveries.length, "no recovery copy is written");
    return;
  }
  expect(b.alive && s.cell("r1", "c2") === undefined, "the document does not take an edit whose lineage cannot be proven");
  expect(s.status(a, id) === "recovered", "the tab shows the edit as kept in a recovery copy");
  expect(s.stored(a, id)?.action.value === "held" && s.stored(a, id).out === "applied", "the host holds the copy, and the copy stores the edit with its action and the room's outcome");
  expect(s.copyOf(a, id).preview.rows.r1.cells.c2 === "held", "the copy's preview shows the value on the saved document");
  expect(a.notices.some((notice) => notice.kind === "recovery" && notice.edits.includes(id)), "the tab shows the notice");
}

function unstored(fault) {
  const { s, world, tabs } = stage();
  const [a] = tabs;
  const id = s.type(a, "r1", "c2", "held");
  s.send(a);
  s.recv(a);
  s.offline(a);
  for (let i = 0; i <= W; i++) {
    s.loseRoom();
    s.answerAll();
  }
  world.host.faults = [fault];
  s.online(a);
  expect(a.unstored.length === 1 && !readRecovery(world.host, "r1")?.edits.length, "the host does not hold the edit, and the tab keeps the copy to write again");
  expect(s.status(a, id) === "shared" && !a.notices.some((notice) => notice.kind === "recovery"), "the tab reports no recovery for bytes it could not read back");
  s.end();
  expect(world.host.recoveries.length === 1 && s.status(a, id) === "recovered" && s.stored(a, id)?.action.value === "held", "the second write is stored, read back and reported");
}

function fileUnstored(fault) {
  const { f, world, tabs } = fileStage(1, { ledgerCap: 102 });
  const [ana] = tabs;
  const typed = f.type(ana, "r3", "c2", "kept");
  f.save(ana);
  f.host();
  f.deliver(0, true);
  f.guests(10);
  world.host.faults = [fault];
  f.refresh(ana);
  expect(ana.unstored.length === 1 && !readRecovery(world.host, "r1")?.edits.length, "the host does not hold the edit, and the tab keeps the copy to write again");
  expect(f.status(ana, typed) === "pending" && !ana.notices.length, "the tab reports no recovery for bytes it could not read back");
  const later = f.type(ana, "r2", "c2", "typed while the copy waits");
  expect(!f.save(ana) || !world.inflight.length || ana.unstored.length === 0, "the tab stores the copy before it sends a save");
  f.end();
  const entry = f.copyOf(ana, typed)?.edits.find((one) => one.e === typed);
  expect(world.host.recoveries.length === 1 && f.status(ana, typed) === "recovered" && entry?.action.value === "kept", "the second write is stored, read back and reported");
  expect(f.status(ana, later) === "saved", "the later edit is saved");
}

export const SCENARIOS = [
  {
    name: "lost-part-is-sent-again",
    about: "Ana's five-cell paste goes up as three part frames. The network loses the second. The room stages the other two and admits nothing. Ana hears no answer, her wait runs out, and she sends the paste again. The room fills the gap and admits the paste once, whole.",
    plants: ["wire-never-resent", "paste-part-admit"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana] = tabs;
      const id = s.paste(ana, FIVE);
      s.post(ana);
      expect(world.wire.length === 3 && !ana.out.length, "the paste is on the wire as three parts");
      s.land(0);
      s.drop(0);
      s.land(0);
      expect(world.room.seq === 0, "two of three parts admit nothing");
      s.waited(ana);
      s.send(ana);
      expect(world.room.seq === 1 && world.room.log[0].action.cells.length === 5, "the paste sent again is admitted once, whole");
      s.end();
      expect(FIVE.every(([row, col, value]) => s.cell(row, col) === value) && s.status(ana, id) === "saved", "the paste is saved whole");
    },
  },
  {
    name: "duplicated-request-counts-once",
    about: "The network delivers Ana's cell write twice, and the answers to both copies are lost. The room admits the write once and judges the second copy a duplicate. Ana sends it a third time when her wait runs out, and that is a duplicate too.",
    plants: ["no-dedup"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana, ben] = tabs;
      s.type(ana, "r2", "c2", "x");
      s.post(ana);
      s.echo(0);
      s.land(0, true);
      s.land(0, true);
      expect(ana.flight.size === 1, "Ana still waits for an answer");
      expect(s.waited(ana) === true && ana.out.length === 1, "her wait runs out and she sends the write again");
      s.send(ana);
      expect(world.room.seq === 1, "the write is admitted once");
      s.type(ben, "r2", "c2", "y");
      s.send(ben);
      s.end();
      expect(s.cell("r2", "c2") === "y", "a later write by Ben is not undone by a copy of Ana's write");
    },
  },
  {
    name: "host-makes-the-receipt",
    about: "Ben's write is in the room and Ana's tab saves the file. The host makes the receipt when it accepts the write, so no tab sends one, and Ben's tab shows his edit as saved.",
    plants: ["host-receipt-not-made"],
    run() {
      const { s, world, tabs } = stage(2, { hostMade: true });
      const [ana, ben] = tabs;
      const id = s.type(ben, "r1", "c1", "ben");
      s.send(ben);
      s.recv(ana);
      s.recv(ben);
      s.save(ana);
      s.answer("ok");
      expect(!ana.out.some((frame) => frame.k === "receipt"), "Ana's tab sends no receipt");
      expect(world.room.base.through === 1, "the host's receipt tells the room the save landed");
      s.recv(ben);
      expect(s.status(ben, id) === "saved", "Ben's edit shows as saved");
      s.end();
    },
  },
  {
    name: "tab-receipt-checked-against-the-host",
    about: "Ben's write is in the room and not saved. A tab reports a receipt for a commit the host never accepted. The room answers that it has not seen that commit and keeps Ben's edit unsaved.",
    plants: ["host-receipt-trusts-the-tab"],
    run() {
      const { s, world, tabs } = stage(2, { hostMade: true });
      const [ana, ben] = tabs;
      s.type(ben, "r1", "c1", "ben");
      s.send(ben);
      const answer = admit(world, world.room, { k: "receipt", gen: world.room.gen, commit: "c99999999999", etag: "e99", through: 1 }, ana.id);
      expect(answer === "unseen", `the room refuses the receipt (answer ${answer})`);
      expect(world.room.base.through === 0, "the room still counts Ben's edit as unsaved");
      s.end();
    },
  },
  {
    name: "host-writes-the-establishing-commit",
    about: "Ana's tab asks for a new generation and sends no bytes. The host's first write is lost, and the room stays on its generation. Her tab asks again, the host writes the establishing commit, and only then opens the room on it.",
    plants: ["host-opens-before-write"],
    run() {
      const { s, world, tabs } = stage(2, { hostMade: true });
      const [ana, ben] = tabs;
      const before = world.room.gen;
      s.rotate(ana);
      expect(world.inflight.length === 1 && world.inflight[0].io.body === undefined, "Ana's tab asks for the establishing commit and sends no bytes");
      s.host(0, true);
      expect(world.room.gen === before, "a lost establishing write leaves the room on its generation");
      s.deliver();
      s.rotate(ana);
      s.answer("ok");
      expect(world.room.gen !== before && s.file().record.gen === world.room.gen && s.file().record.room === world.room.id, "the room opens on the generation the file names");
      const id = s.type(ben, "r1", "c1", "ben");
      s.end();
      expect(s.cell("r1", "c1") === "ben" && s.status(ben, id) === "saved", "Ben's edit on the new generation is saved");
    },
  },
  {
    name: "title-change-keeps-the-room",
    about: "Ben's write is in the room and not saved. A program changes only the title of the file, once on its own and once through the outside write step. The room keeps its generation and takes the new ETag, and Ben's edit is saved.",
    plants: ["host-same-drops-room", "host-equal-tables-new-gen", "host-same-etag-not-learned"],
    run() {
      const { s, world, tabs } = stage(2, { hostMade: true });
      const [ana, ben] = tabs;
      const id = s.type(ben, "r1", "c1", "ben");
      s.send(ben);
      s.recv(ana);
      const room = world.room;
      s.title("raw");
      expect(world.room === room && room.base.etag === s.file().etag, "the room stays and takes the new ETag");
      s.title("step");
      expect(world.room === room && s.file().record.gen === room.gen, "the outside write step keeps the generation");
      s.end();
      expect(s.cell("r1", "c1") === "ben" && s.status(ben, id) === "saved", "Ben's edit is saved");
    },
  },
  {
    name: "cell-changed-under-a-kept-tag-ends-the-room",
    about: "Ben's edit is saved. The host is told of a write that keeps the commit record and changes a cell, as an agent editing the file on disk would make. The host sees the tables changed and answers outside, so the room ends and no save of its state can erase the agent's cell. (The lab's oracle does not model the write itself yet: that is round L2b part 2, an overwrite found after the fact.)",
    plants: ["host-same-ignores-tables"],
    run() {
      const { s, world, tabs } = stage(2, { hostMade: true });
      const [ana, ben] = tabs;
      s.type(ben, "r1", "c1", "ben");
      s.send(ben);
      s.recv(ana);
      s.save(ana);
      s.answer("ok");
      const before = s.file();
      const after = { ...before, etag: "e-agent", state: { ...before.state, wb: structuredClone(before.state.wb) } };
      after.state.wb.rows.r2.cells.c2 = "agent";
      const answer = fileAccepted(world, after, before);
      expect(answer === "outside" && !world.room, `a write that changed a table under a kept tag ends the room (answer ${answer})`);
      s.end();
    },
  },
  {
    name: "lost-receipt-is-sent-again",
    about: "Ben's write is in the room and Ana's tab saves the file. Ana's receipt for that save is lost on the wire. When her wait runs out she sends it again, so the room learns that the save landed and Ben's tab shows his edit as saved.",
    plants: ["wire-receipt-not-resent", "wire-never-resent"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana, ben] = tabs;
      const id = s.type(ben, "r1", "c1", "ben");
      s.send(ben);
      s.recv(ana);
      s.recv(ben);
      s.save(ana);
      s.answer("ok");
      expect(ana.out.some((frame) => frame.k === "receipt"), "Ana's tab has a receipt to send");
      s.post(ana);
      s.drop(0);
      expect(world.room.base.through === 0, "the room has not heard of the save");
      s.waited(ana);
      s.send(ana);
      expect(world.room.base.through === 1, "the receipt sent again tells the room the save landed");
      s.recv(ben);
      expect(s.status(ben, id) === "saved", "Ben's edit shows as saved");
      s.end();
    },
  },
  {
    name: "restore-offer-answered-late",
    about: "A version restore cuts Ana's two edits, and her tab stores them in a recovery copy. Cal restores the copy on a slow connection: the room applies the first edit, but its answer arrives after Cal's wait ran out and Cal sent the offer again. The room gives the second offer the answer it gave the first, so Cal's tab reports the edit as restored.",
    plants: ["wire-offer-judged-again"],
    run() {
      const { s, tabs } = stage(2);
      const [ana] = tabs;
      const first = s.type(ana, "r1", "c2", "first");
      s.type(ana, "r2", "c2", "second");
      s.send(ana);
      s.recv(ana);
      s.offline(ana);
      s.loseRoom();
      s.restore(0);
      s.online(ana);
      s.answerAll();
      s.flow();
      const copy = ana.edits.get(first).copy;
      expect(copy, "Ana's edits are stored in a recovery copy");
      const cal = s.join();
      s.answerAll();
      s.flow();
      s.restoreCopy(cal, copy);
      s.post(cal);
      s.waited(cal);
      s.land(0);
      s.end();
      expect(s.cell("r1", "c2") === "first", "the restored edit is in the file");
    },
  },
  {
    name: "late-part-after-the-tab-closed",
    about: "Ana sends a paste in three parts and closes her tab while two parts are still on the wire. The room drops what it staged for her when her connection ends. The two late parts are refused, so the room holds no bytes for a paste nobody will finish.",
    plants: ["wire-late-part-staged"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana] = tabs;
      s.paste(ana, FIVE);
      s.post(ana);
      s.land(0);
      expect(world.room.staging.size === 1, "the first part is staged");
      s.close(ana);
      expect(world.room.staging.size === 0, "closing the tab drops its stage");
      s.land(0);
      s.land(0);
      expect(world.room.staging.size === 0 && world.room.bytes.staged === 0, "late parts from a closed tab are not staged");
      s.end();
    },
  },
  {
    name: "peer-edit-lands-between-parts",
    about: "Two parts of Ana's paste have landed when Ben's write to a cell of the paste lands. The room admits Ben's write first. The paste is admitted when its last part lands, so it comes after Ben's write in the one order, and every tab ends with Ana's value.",
    plants: ["paste-part-admit"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana, ben] = tabs;
      s.paste(ana, FIVE);
      s.post(ana);
      s.land(0);
      s.land(0);
      s.type(ben, "r1", "c2", "ben");
      s.send(ben);
      expect(world.room.seq === 1 && world.room.log[0].c === ben.client, "Ben's write is admitted first");
      s.recv(ana);
      expect(view(ana).rows.r1.cells.c2 === "a", "Ana still shows her own paste over Ben's write");
      s.land(0);
      expect(world.room.seq === 2 && world.room.log[1].action.cells.length === 5, "the paste is admitted after Ben's write, whole");
      s.end();
      expect(s.cell("r1", "c2") === "a" && view(ben).rows.r1.cells.c2 === "a", "the file and Ben's tab hold the paste's value");
    },
  },
  {
    name: "room-lost-between-parts",
    about: "Two parts of Ana's paste are staged when the room is lost. The third part lands on no room. Ana's tab joins the next room and sends the paste again as part of joining, and it is admitted there once, whole.",
    plants: ["paste-part-admit"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana] = tabs;
      const id = s.paste(ana, FIVE);
      s.post(ana);
      s.land(0);
      s.land(0);
      s.loseRoom();
      s.land(0);
      expect(world.wire.length === 0, "the third part is gone");
      s.end();
      expect(FIVE.every(([row, col, value]) => s.cell(row, col) === value) && s.status(ana, id) === "saved", "the paste is saved whole after the room loss");
      expect(world.oracle.gens.size >= 2, "the paste was admitted in a later room");
    },
  },
  {
    name: "different-cells",
    about: "Two tabs write different cells of one row. Both stay.",
    plants: ["row-granularity"],
    run() {
      const { s, tabs } = stage();
      const [a, b] = tabs;
      const one = s.type(a, "r1", "c2", "from-a");
      const two = s.type(b, "r1", "c3", "from-b");
      s.flow();
      s.save(a);
      s.answer();
      s.end();
      expect(s.cell("r1", "c1") === "i1" && s.cell("r1", "c2") === "from-a" && s.cell("r1", "c3") === "from-b", "the row holds all three cells");
      expect(s.status(a, one) === "saved" && s.status(b, two) === "saved", "both tabs show saved");
    },
  },
  {
    name: "same-cell-causal",
    about: "B replaces a value it has seen. A third tab receives the two frames in the wrong order and still ends on B's value.",
    plants: ["no-reorder-buffer"],
    run() {
      const { s, world, tabs } = stage(3);
      const [a, b, c] = tabs;
      s.type(a, "r1", "c1", "first");
      s.send(a);
      s.recv(b);
      s.type(b, "r1", "c1", "second");
      s.send(b);
      world.mode = "scrambled";
      world.rnd = () => 0.99;
      s.recv(c, 1);
      expect(view(c).rows.r1.cells.c1 === "i1", "the third tab shows nothing new until the earlier frame arrives");
      s.recv(c, 1);
      expect(view(c).rows.r1.cells.c1 === "second", "the third tab shows the later value");
      world.mode = "ordered";
      s.flow();
      s.save(b);
      s.answer();
      s.end();
      expect(s.cell("r1", "c1") === "second", "the file holds the later value");
    },
  },
  {
    name: "duplicate-requests",
    about: "A request arrives twice, and a reconnect sends a pending request again. Each has one effect.",
    plants: ["no-dedup"],
    run() {
      const { s, world, tabs } = stage();
      const [a, b] = tabs;
      s.type(a, "r2", "c1", "one");
      const again = { ...a.out[0] };
      s.type(a, "r2", "c1", "two");
      s.flow();
      a.out.push(again);
      s.flow();
      s.type(a, "r2", "c2", "three");
      s.send(a);
      s.offline(a);
      s.online(a);
      s.flow();
      s.save(b);
      s.answer();
      s.end();
      expect(s.cell("r2", "c1") === "two" && s.cell("r2", "c2") === "three", "the file holds each edit once, in order");
      expect(world.room.seq === 3, "the room took three actions");
    },
  },
  {
    name: "save-answer-lost-write-applied",
    about: "The host wrote the file and the answer never arrived. The tab does not show saved until it reads the commit record.",
    plants: ["unknown-never-resolved"],
    run() {
      const { s, tabs } = stage();
      const [a] = tabs;
      const id = s.type(a, "r1", "c2", "kept");
      s.flow();
      s.save(a);
      s.answer("drop-applied");
      expect(s.status(a, id) === "shared", "a save with no answer is not shown as saved");
      s.save(a);
      expect(s.status(a, id) === "saved", "reading the commit record settles it");
      s.end();
      expect(s.cell("r1", "c2") === "kept", "the file holds the edit");
    },
  },
  {
    name: "save-answer-lost-write-not-applied",
    about: "The save never reached the file and no answer arrived. The tab does not show saved, reads the file, and saves again.",
    plants: ["unknown-assumes-saved"],
    run() {
      const { s, tabs } = stage();
      const [a] = tabs;
      const id = s.type(a, "r1", "c2", "kept");
      s.flow();
      s.save(a);
      s.answer("drop-lost");
      expect(s.status(a, id) === "shared", "a save with no answer is not shown as saved");
      expect(s.file().record.through === 0, "the file is unchanged");
      s.save(a);
      s.answer();
      expect(s.status(a, id) === "saved", "the second save is accepted");
      s.end();
    },
  },
  {
    name: "establish-answer-lost",
    about: "The first tab's establishing commit lands and its answer is lost. The tab finds its commit in the file and opens the room.",
    plants: ["unknown-never-resolved"],
    run() {
      const { s, world } = stage(0);
      const a = s.join();
      s.answer("drop-applied");
      expect(!world.room.gen, "the room instance opens no generation before the handshake completes");
      const id = s.type(a, "r1", "c2", "typed");
      s.save(a);
      s.end();
      expect(s.cell("r1", "c2") === "typed" && s.status(a, id) === "saved", "the edit is saved");
    },
  },
  {
    name: "late-establish-from-a-closed-tab",
    about: "A tab starts a new generation and closes. Its establishing commit lands when the other tab has nothing left to save. The idle tab reads the file, sees the newer generation, and moves the room to it.",
    plants: ["no-idle-check"],
    run() {
      const { s, world, tabs } = stage();
      const [a, b] = tabs;
      s.rotate(b);
      s.close(b);
      s.host();
      s.deliver();
      expect(world.room.gen !== s.file().record.gen, "the closed tab's commit moved the file to a newer generation");
      s.end();
      expect(world.room.gen === s.file().record.gen && a.gen === world.room.gen, "the room and the open tab are on the file's generation");
    },
  },
  {
    name: "writer-closes-before-acceptance",
    about: "The writer sends a save and closes. The write never lands. Nobody shows saved, and the other tab saves the same work.",
    plants: ["receipt-before-accept"],
    run() {
      const { s, tabs } = stage();
      const [a, b] = tabs;
      const id = s.type(b, "r3", "c2", "ben");
      s.flow();
      s.save(a);
      s.flow();
      expect(s.status(b, id) === "shared", "a save in flight is not a saved edit");
      s.close(a);
      s.answer("refuse");
      s.save(b);
      s.answer();
      expect(s.status(b, id) === "saved", "the other tab saves it");
      s.end();
      expect(s.cell("r3", "c2") === "ben", "the file holds the edit");
    },
  },
  {
    name: "closed-writer-save-lands-late",
    about: "A closed writer's older save reaches the host after a newer save. The host refuses it.",
    plants: ["unconditional-save"],
    run() {
      const { s, tabs } = stage();
      const [a, b] = tabs;
      s.type(a, "r1", "c2", "one");
      s.flow();
      s.save(a);
      s.close(a);
      s.type(b, "r1", "c3", "two");
      s.flow();
      s.save(b);
      s.answer("ok", 1);
      s.answer("ok", 0);
      expect(s.file().record.through === 2, "the newer file stays");
      s.end();
      expect(s.cell("r1", "c2") === "one" && s.cell("r1", "c3") === "two", "the file holds both edits");
    },
  },
  {
    name: "writer-closes-after-acceptance",
    about: "The host accepts a save and the writer closes before it can tell the room. The next writer is refused, reads the file, and learns the commit.",
    plants: ["412-no-fetch"],
    run() {
      const { s, tabs } = stage();
      const [a, b] = tabs;
      const id = s.type(b, "r2", "c2", "ben");
      s.flow();
      s.save(a);
      s.close(a);
      s.answer();
      expect(s.status(b, id) === "shared", "nobody has told the other tab yet");
      const later = s.type(b, "r2", "c3", "more");
      s.flow();
      s.save(b);
      s.answer();
      expect(s.status(b, id) === "saved", "the commit record in the file settles the first edit");
      s.save(b);
      s.answer();
      expect(s.status(b, later) === "saved", "the next save is accepted");
      s.end();
    },
  },
  {
    name: "lagging-writer-refused",
    about: "A tab that is behind tries to save over a newer file. The host refuses, and the tab reads the file instead of sending its old snapshot again.",
    plants: ["412-repin"],
    run() {
      const { s, tabs } = stage();
      const [a, b] = tabs;
      s.type(a, "r1", "c2", "one");
      s.flow();
      s.type(a, "r1", "c3", "two");
      s.send(a);
      s.recv(a);
      s.save(b);
      s.save(a);
      s.answer("ok", 1);
      s.answer("ok", 0);
      while (s.world.inflight.length) s.answer();
      expect(s.file().record.through === 2, "the newer file stays");
      s.end();
      expect(s.cell("r1", "c3") === "two", "the file holds the later edit");
    },
  },
  {
    name: "old-save-then-reset",
    about: "The room is lost. A save from the old generation lands first, then a tab's establishing commit that was built on the older file arrives.",
    plants: ["establish-unconditional"],
    run() {
      const { s, world, tabs } = stage();
      const [a] = tabs;
      const id = s.type(a, "r1", "c2", "ana");
      s.flow();
      s.save(a);
      s.loseRoom();
      s.answer("ok", 0);
      expect(s.file().record.through === 1, "the old generation's save is accepted");
      s.answer("ok", 0);
      s.end();
      expect(s.cell("r1", "c2") === "ana" && s.status(a, id) === "saved", "the saved edit stays");
      expect(!world.host.recoveries.length, "no recovery copy is written");
    },
  },
  {
    name: "reset-then-old-save",
    about: "The room is lost. The establishing commit lands first, then the save from the old generation arrives and is refused.",
    plants: ["unconditional-save"],
    run() {
      const { s, world, tabs } = stage();
      const [a] = tabs;
      const id = s.type(a, "r1", "c2", "ana");
      s.flow();
      s.save(a);
      s.loseRoom();
      s.answer("ok", 1);
      const gen = world.room.gen;
      s.answer("ok", 0);
      expect(s.file().record.gen === gen, "the file stays in the new generation");
      s.end();
      expect(s.cell("r1", "c2") === "ana" && s.status(a, id) === "saved", "the edit is saved in the new generation");
      expect(!world.host.recoveries.length, "no recovery copy is written");
    },
  },
  {
    name: "restore-with-dirty-room",
    about: "A restore runs while the room holds unsaved work and a tab holds edits it has not sent.",
    plants: ["restore-no-backup", "restore-keeps-lineage", "restore-drops-misfit", "restore-replays-admitted", "backup-empty-bytes"],
    run() {
      const { s, world, tabs } = stage();
      const [a, b] = tabs;
      const saved = s.type(a, "r1", "c2", "saved-before");
      s.flow();
      s.save(a);
      s.answer();
      s.flow();
      const dirty = s.type(b, "r2", "c1", "dirty");
      s.insert(b, "n1", "25");
      s.send(b);
      s.recv(a);
      s.offline(a);
      const fit = s.type(a, "r3", "c2", "fits");
      const misfit = s.type(a, "n1", "c1", "no-home");
      s.restore(1);
      const backup = world.host.versions.find((version) => version.kind === "backup");
      expect(backup, "the room's unsaved work is kept as its own version");
      const kept = parse(backup.body).state.wb;
      expect(kept.rows.r2.cells.c1 === "dirty" && kept.rows.n1, "the backup holds the unsaved edits");
      expect(s.cell("r1", "c2") === undefined && !s.file().state.wb.rows.n1, "the live file is the restored version");
      s.online(a);
      s.end();
      expect(s.cell("r3", "c2") === "fits" && s.status(a, fit) === "saved", "an unsent edit that still fits is applied");
      expect(!s.file().state.wb.rows.n1, "no row is created for the edit that does not fit");
      expect(s.status(a, misfit) === "kept-refused", "the edit that does not fit is kept, and its tab labels it as stored refused");
      expect(s.stored(a, misfit)?.action.value === "no-home" && s.stored(a, misfit).out === "refused", "the recovery copy stores it with its action, as an edit the room refused");
      expect(!s.copyOf(a, misfit).preview.rows.n1, "the copy's preview does not invent the row");
      expect(a.notices.some((notice) => notice.kind === "recovery" && notice.edits.includes(misfit)), "its tab shows a notice");
      expect(s.status(b, dirty) === "recovered", "the other tab's shared edit is shown as kept in the backup");
      expect(b.notices.some((notice) => notice.kind === "restore" && notice.edits.includes(dirty)), "that tab shows a restore notice");
      expect(s.status(a, saved) === "saved" && s.cell("r2", "c1") === undefined, "nothing from the replaced room is applied again");
    },
  },
  {
    name: "restore-replays-nothing-the-room-had",
    about: "B's edit is in the room and A has built on it. After a restore only A's unsent edit is applied, never B's.",
    plants: ["restore-replays-admitted"],
    run() {
      const { s, world, tabs } = stage();
      const [a, b] = tabs;
      const first = s.type(b, "r2", "c3", "first");
      s.send(b);
      s.recv(a);
      s.offline(a);
      s.type(a, "r2", "c3", "second");
      s.restore(1);
      s.online(a);
      s.send(a);
      s.send(b);
      s.end();
      expect(s.cell("r2", "c3") === "second", "the file holds the later edit");
      expect(s.status(b, first) === "recovered", "the earlier edit is shown as kept in the backup");
      const backup = world.host.versions.find((version) => version.kind === "backup");
      expect(parse(backup.body).state.wb.rows.r2.cells.c3 === "first", "the backup holds it");
    },
  },
  {
    name: "orphan-row",
    about: "Ana inserts a row, Ben types into it, Ana closes, the room is lost. Ben's tab restores both.",
    plants: ["recover-own-only"],
    run() {
      const { s, world, tabs } = stage();
      const [ana, ben] = tabs;
      s.insert(ana, "n1", "25");
      s.flow();
      const keep = s.type(ben, "n1", "c1", "keep me");
      s.flow();
      s.close(ana);
      s.loseRoom();
      s.end();
      expect(s.file().state.wb.rows.n1?.cells.c1 === "keep me", "the row and the cell are in the saved file");
      expect(s.status(ben, keep) === "saved", "Ben's tab shows saved");
      expect(!world.host.recoveries.length && !ben.notices.length, "no recovery copy and no notice");
    },
  },
  {
    name: "all-tabs-close-room-loss",
    about: "The witness. The only tab types, the room takes it, the tab closes, the room is lost. The edit is gone and nobody was told it was saved.",
    plants: ["ack-on-delivery"],
    run() {
      const { s, world, tabs } = stage(1);
      const [a] = tabs;
      const id = s.type(a, "r1", "c2", "typed");
      s.flow();
      expect(s.status(a, id) === "shared", "delivery is not a save");
      s.close(a);
      s.loseRoom();
      s.join();
      s.end();
      expect(world.oracle.delivered.has(id) && !world.oracle.saved.has(id), "the delivered ledger holds it and the saved ledger does not");
      expect(world.oracle.witnessed.has(id), "the oracle recorded that no tab held it");
      expect(s.cell("r1", "c2") === undefined, "the file never held it");
    },
  },
  {
    name: "stale-generation-request",
    about: "A request that names the old generation arrives in the new room. It is refused, and the tab's new request goes in once.",
    plants: ["no-gen-fence"],
    run() {
      const { s, world, tabs } = stage();
      const [a] = tabs;
      const id = s.type(a, "r1", "c2", "one");
      s.loseRoom();
      s.answerAll();
      expect(a.out[0].gen !== world.room.gen, "the old frame is still on the wire");
      s.send(a, 0);
      expect(world.room.seq === 0, "the room refuses it");
      s.end();
      expect(s.cell("r1", "c2") === "one" && s.status(a, id) === "saved", "the edit is saved once");
    },
  },
  {
    name: "stale-generation-receipt",
    about: "A receipt from the old generation arrives in the new room. It marks nothing saved.",
    plants: ["receipt-any-gen"],
    run() {
      const { s, tabs } = stage();
      const [a, b] = tabs;
      s.type(a, "r1", "c2", "one");
      s.type(a, "r1", "c3", "two");
      s.flow();
      s.save(a);
      s.answer();
      s.loseRoom();
      s.answerAll();
      const x = s.type(b, "r2", "c1", "x");
      s.type(b, "r2", "c2", "y");
      s.send(b);
      s.recv(b);
      s.send(a, a.out.findIndex((frame) => frame.k === "receipt"));
      s.recv(b);
      expect(s.status(b, x) === "shared", "the new generation's edits are not saved by an old receipt");
      s.end();
    },
  },
  {
    name: "two-holders-shorter-prefix",
    about: "Two tabs hold the lost room's tail, one of them a shorter part. Each action enters the new room once, in order.",
    plants: ["copy-not-adopt"],
    run() {
      const { s, world, tabs } = stage(3);
      const [a, b, c] = tabs;
      s.type(a, "r1", "c2", "one");
      s.flow();
      s.save(a);
      s.answer();
      s.flow();
      s.insert(a, "n1", "25");
      s.type(a, "n1", "c1", "three");
      s.send(a);
      s.recv(b);
      s.recv(c, 1);
      s.close(a);
      s.loseRoom();
      s.answerAll();
      s.send(c);
      s.send(b);
      s.end();
      expect(s.file().state.wb.rows.n1?.cells.c1 === "three", "the row and its cell are saved");
      expect(world.oracle.gens.get(world.room.gen).applied.filter(Boolean).length === 2, "the new generation applied each action once");
      expect(!world.host.recoveries.length, "no recovery copy is written");
    },
  },
  {
    name: "adopt-offer-out-of-order",
    about: "The second half of a holder's offer arrives first. The room refuses it until the first half is in.",
    plants: ["adopt-gap"],
    run() {
      const { s, tabs } = stage();
      const [a, b] = tabs;
      s.insert(a, "n1", "25");
      s.type(a, "n1", "c1", "first");
      s.type(a, "n1", "c2", "inside");
      s.flow();
      s.close(a);
      s.loseRoom();
      s.answerAll();
      const offers = b.out.filter((frame) => frame.k === "adopt");
      expect(offers.length === 2, "the offer travels as two frames");
      s.send(b, b.out.indexOf(offers[1]));
      s.end();
      expect(s.file().state.wb.rows.n1?.cells.c2 === "inside" && s.cell("n1", "c1") === "first", "the row and its cells are saved");
    },
  },
  {
    name: "natives-wait-for-the-tail",
    about: "Ben types into a row that only his held tail contains. His own edit is not sent until the tail is in.",
    plants: ["natives-before-adopt"],
    run() {
      const { s, tabs } = stage();
      const [ana, ben] = tabs;
      s.insert(ana, "n1", "25");
      s.flow();
      s.close(ana);
      s.loseRoom();
      const typed = s.type(ben, "n1", "c1", "on the row");
      s.answerAll();
      const own = ben.out.findIndex((frame) => frame.k === "req");
      if (own >= 0) s.send(ben, own);
      s.end();
      expect(s.file().state.wb.rows.n1?.cells.c1 === "on the row" && s.status(ben, typed) === "saved", "the edit lands on its row");
    },
  },
  {
    name: "lineage-inside-window",
    about: `A tab is away while ${W} generations pass. Its held edit is still merged.`,
    plants: ["copy-not-adopt"],
    run: () => lineage(W, false),
  },
  {
    name: "lineage-beyond-window",
    about: `A tab is away while ${W + 1} generations pass. Lineage cannot be proven, so its work becomes a stored recovery copy with a notice. The copy stores the edit itself, and its table is a preview of the saved document with that edit.`,
    plants: ["recovery-no-bytes", "recovery-empty-bytes", "copy-preview-stale"],
    run: () => lineage(W + 1, true),
  },
  {
    name: "copy-write-the-host-dropped",
    about: `A tab is away while ${W + 1} generations pass and gives its held edit to a recovery copy. The host drops the first write of the copy. The tab reads the stored bytes back, finds none, and reports no recovery. It writes the copy again on its next read and reports it only then.`,
    plants: ["recovery-unconfirmed"],
    run: () => unstored("drop"),
  },
  {
    name: "copy-write-the-host-blanked",
    about: "The same session, and the host stores the first write of the copy with no edits and an empty table. The bytes the tab reads back are not the bytes it sent, so it reports no recovery until a second write is stored whole.",
    plants: ["recovery-unconfirmed"],
    run: () => unstored("blank"),
  },
  {
    name: "copy-keeps-the-order-of-the-newest-room",
    about: "Hal holds two lost generations. The older one holds Ben's value, which Ben typed over Ana's value. The newer one took Ana's value again from Cal, who had only seen the first room. A restore then cuts the history. Hal's copy lists Ana's edit first, in the place the newest room gave it, and Ben's edit after it. A replay of the copy onto the restored file ends with Ben's newer value.",
    plants: ["copy-holder-order", "replay-forgets-itself"],
    run() {
      const { s, world, tabs } = stage(4);
      const [ana, ben, cal, hal] = tabs;
      const older = s.type(ana, "r1", "c2", "older");
      s.send(ana);
      for (const tab of tabs) s.recv(tab);
      s.offline(cal);
      s.loseRoom();
      s.answerAll();
      s.flow();
      const newer = s.type(ben, "r1", "c2", "newer");
      s.send(ben);
      s.recv(hal);
      expect(view(hal).rows.r1.cells.c2 === "newer" && hal.tail.length === 2, "Hal holds both edits from the second room, Ben's after Ana's");
      s.offline(hal);
      s.close(ana);
      s.close(ben);
      s.loseRoom();
      s.online(cal);
      s.answerAll();
      s.flow();
      expect(world.room.seq === 1 && world.oracle.delivered.get(older).gen === world.room.gen, "the third room took Ana's edit from Cal, and it never saw Ben's");
      s.online(hal);
      s.offline(hal);
      expect(hal.tail.length === 1 && hal.held.length === 1 && hal.held[0].frames.length === 2, "Hal holds Ana's edit from the third room, and both edits from the second");
      s.close(cal);
      s.loseRoom();
      s.restore(0);
      s.online(hal);
      const notice = hal.notices.find((one) => one.kind === "recovery");
      const copy = readRecovery(world.host, notice?.copy);
      expect(copy?.edits.map((entry) => entry.e).join() === [older, newer].join(), "the copy lists Ana's edit first and Ben's edit second");
      expect(copy.preview.rows.r1.cells.c2 === "newer", "the preview ends with the newer value");
      expect(world.oracle.replays.applied === 2, "a replay onto the restored file takes both edits as new, through the ledger check");
      s.end();
      expect(s.cell("r1", "c2") === undefined, "the live document takes neither on its own");
    },
  },
  {
    name: "cut-request-the-room-refused",
    about: "Ben's delete of a row is in the room. Ana types into that row and the room refuses the edit. Her tab has not seen the refusal when a restore replaces the room. The cut record tells her tab only that the room had resolved the request, so her restore notice holds the action itself.",
    plants: ["cut-means-backed-up"],
    run() {
      const { s, world, tabs } = stage();
      const [ana, ben] = tabs;
      s.remove(ben, "r3");
      s.send(ben);
      const typed = s.type(ana, "r3", "c2", "into a deleted row");
      s.send(ana);
      expect(world.oracle.refused.has(typed) && s.status(ana, typed) === "pending", "the room refused the edit, and Ana's tab has not seen the outcome");
      s.offline(ana);
      s.restore(0);
      s.online(ana);
      s.end();
      const notice = ana.notices.find((one) => one.kind === "restore" && one.edits.includes(typed));
      expect(s.status(ana, typed) === "recovered" && notice?.actions[typed]?.value === "into a deleted row", "her restore notice holds the action, because her tab did not see what the room did with it");
    },
  },
  {
    name: "unsent-delete-keeps-shared-work",
    about: "Ben types into a row and the room takes it. Ben is away until the lineage is gone, deletes the row without sending the delete, and comes back. The stored copy keeps both edits in order: the value as an edit a room applied, and the delete as an edit Ben never sent.",
    plants: ["copy-draft-only", "copy-shared-only", "replay-unsent-out-of-order"],
    run() {
      const { s, world, tabs } = stage();
      const [ana, ben] = tabs;
      s.insert(ana, "n1", "25");
      s.send(ana);
      s.recv(ana);
      s.recv(ben);
      const kept = s.type(ben, "n1", "c1", "keep me");
      s.send(ben);
      s.recv(ben);
      s.offline(ben);
      for (let i = 0; i <= W; i++) {
        s.loseRoom();
        s.answerAll();
      }
      const gone = s.remove(ben, "n1");
      expect(!world.oracle.delivered.has(gone), "the delete was never admitted");
      s.online(ben);
      s.end();
      const copy = s.copyOf(ben, kept);
      const order = copy.edits.map((entry) => entry.e);
      expect(s.stored(ben, kept)?.out === "applied" && s.stored(ben, kept).action.value === "keep me", "the stored copy holds the value as an edit a room applied");
      expect(s.stored(ben, gone)?.out === "unsent" && order.indexOf(kept) < order.indexOf(gone), "it holds the tab's own delete after it, as an edit that was never sent");
      expect(!copy.preview.rows.n1, "the preview shows the document with both edits, so the row is gone");
      expect(s.status(ben, kept) === "recovered" && s.status(ben, gone) === "recovered", "the tab shows both as kept in the copy");
      expect(!s.file().state.wb.rows.n1, "the live document takes neither");
    },
  },
  {
    name: "parked-request-the-file-counted",
    about: "Ben types into a row while he is away. A restore replaces the room, so his tab parks the edit and sends it to the new room. That room applies it, and Ben's tab never gets the answer. Ana deletes the row and saves. Ben's tab then reads the file: its ledger has counted his request, and the edit does not fit the document. The tab cannot know that the room applied the edit. The copy stores it as counted by that file, not as refused, and a restore from the copy does not apply it.",
    plants: ["counted-stored-as-refused"],
    run() {
      const { s, world, tabs } = stage();
      const [ana, ben] = tabs;
      s.insert(ana, "n1", "25");
      s.flow();
      s.save(ana);
      s.answerAll();
      s.flow();
      s.offline(ben);
      const typed = s.type(ben, "n1", "c1", "parked");
      s.restore("live");
      s.online(ben);
      expect(ben.limbo.some((limbo) => limbo.requests.has(typed)), "the tab parks the edit when it crosses the restore");
      s.send(ben);
      expect(world.oracle.delivered.has(typed) && world.room.state.wb.rows.n1.cells.c1 === "parked", "the new room applies it");
      s.offline(ben);
      s.remove(ana, "n1");
      s.send(ana);
      s.recv(ana);
      s.save(ana);
      s.answerAll();
      const counted = s.file().record.commit;
      expect(!s.file().state.wb.rows.n1 && s.file().state.seen[ben.client]?.[0] === 1, "the saved file has counted the request, and the row is gone");
      s.online(ben);
      s.end();
      const entry = s.stored(ben, typed);
      expect(s.status(ben, typed) === "kept-refused", "the tab keeps the edit in a copy, labelled as stored refused");
      expect(entry?.out === "counted" && entry.file === counted && entry.src === null, "the copy stores it as counted by the file the tab read, with no room place");
      expect(entry.action.value === "parked" && !s.copyOf(ben, typed).preview.rows.n1, "it holds the action, and the preview does not invent the row");
      expect(world.oracle.atEnd.resolved === 1 && !world.oracle.atEnd.applied, "a restore from the copy skips it, because the ledger counts it");
    },
  },
  {
    name: "unsent-edit-with-no-row-left",
    about: "Ben types into a row offline. Ana deletes the row and the room takes the delete, which Ben's tab also holds. The lineage is lost. No table can show Ben's value, because its row is gone. The stored copy still holds the edit with its whole action.",
    plants: ["copy-shared-only"],
    run() {
      const { s, world, tabs } = stage();
      const [ana, ben] = tabs;
      s.remove(ana, "r2");
      s.send(ana);
      s.recv(ana);
      const typed = s.type(ben, "r2", "c2", "typed offline");
      s.recv(ben);
      s.offline(ben);
      for (let i = 0; i <= W; i++) {
        s.loseRoom();
        s.answerAll();
      }
      s.online(ben);
      s.end();
      expect(s.status(ben, typed) === "recovered", "the tab shows the edit as kept in a recovery copy");
      expect(s.stored(ben, typed)?.action.value === "typed offline" && s.stored(ben, typed).out === "unanswered", "the stored copy holds the edit with its value, as an edit that no room answered");
      expect(!s.copyOf(ben, typed).preview.rows.r2 && !world.oracle.homeless.size, "the preview has no row for it, and the tab did not drop it");
    },
  },
  {
    name: "thousand-clients-over-time",
    about: "One room stays open while 1,000 tabs join, type, save and close. Rotations that the ledger size triggers trim the request ledger, and the commit record stays under its byte budget.",
    plants: ["no-ledger-trim", "no-ledger-cap"],
    run() {
      const { s, world, tabs } = stage(1);
      const [stay] = tabs;
      const mine = [];
      for (let i = 0; i < 1000; i++) {
        const tab = s.join();
        const id = s.type(tab, `r${(i % 4) + 1}`, "c2", `guest-${i}`);
        if (i % 100 === 50) mine.push(s.type(stay, "r1", "c3", `host-${i}`));
        settle(world);
        checkStep(world);
        expect(s.status(tab, id) === "saved", `guest ${i} is saved`);
        s.close(tab);
      }
      s.end();
      const budget = recordBudget(world.limits.ledgerCap, W);
      expect(world.oracle.maxRecordBytes <= budget, `the largest commit record (${world.oracle.maxRecordBytes} bytes) is within the budget (${budget})`);
      expect(Object.keys(s.file().state.seen).length < 20, "the ledger holds a few recent clients, not a thousand");
      expect(s.cell("r4", "c2") === "guest-999" && s.cell("r1", "c3") === "host-950", "the last edits are in the file");
      expect(mine.every((id) => s.status(stay, id) === "saved") && stay.clients.size > 1, "the tab that stayed was retired while idle, took a new client id, and its later edits are saved");
      expect(!world.host.recoveries.length, "no recovery copy is written");
      expect(world.oracle.gens.size < 250, `rotations stay below one per four clients (${world.oracle.gens.size - 1} generations)`);
    },
  },
  {
    name: "known-client-at-the-ledger-cap",
    about: "The room's ledger is exactly at its cap. A known client's tenth request would make its entry one digit longer. The room turns it away until a rotation has trimmed the ledger, and no saved file carries a ledger over the cap.",
    plants: ["ledger-cap-new-clients-only"],
    run() {
      const { s, world, tabs } = stage(4, { ledgerCap: 102 });
      const [ana, ...others] = tabs;
      others.forEach((tab, i) => s.type(tab, `r${i + 2}`, "c2", `guest-${i}`));
      s.flow();
      for (let i = 0; i < 9; i++) s.type(ana, "r1", "c2", `ana-${i}`);
      s.flow();
      expect(ledgerBytes(world.room.state.seen) === world.limits.ledgerCap, "the room's ledger is exactly at its cap");
      const tenth = s.type(ana, "r1", "c3", "tenth");
      s.end();
      expect(world.oracle.maxLedgerBytes === world.limits.ledgerCap, `the largest saved ledger is exactly the cap (${world.oracle.maxLedgerBytes} bytes)`);
      expect(s.status(ana, tenth) === "saved" && s.cell("r1", "c3") === "tenth", "the tenth edit is saved after the rotation");
      expect(!world.host.recoveries.length, "no recovery copy is written");
    },
  },
  {
    name: "retired-client-returns",
    about: "Ana's request is in the room and in the saved file, and her tab never saw it. Other clients pass through until a rotation trims her ledger entry. When she returns, her tab cannot know the outcome, so it keeps the edit in a recovery copy and sends nothing again. A restore from that copy goes through the ledger check, which cannot judge her retired client, so it does not put her older value over the newer saved one.",
    plants: ["retired-as-new", "restore-skips-ledger"],
    run() {
      const { s, world, tabs } = stage(2, { ledgerCap: 160 });
      const [ana, ben] = tabs;
      const typed = s.type(ana, "r1", "c2", "from-ana");
      s.send(ana);
      s.offline(ana);
      s.recv(ben);
      s.save(ben);
      s.answerAll();
      s.flow();
      churn(s, ben, 8, "guest");
      expect(!("t1" in s.file().state.seen) && s.file().state.floor >= ana.born, "a rotation trimmed her entry and raised the floor past her client");
      s.type(ben, "r1", "c2", "later");
      s.flow();
      s.save(ben);
      s.answerAll();
      s.flow();
      s.online(ana);
      s.end();
      expect(s.cell("r1", "c2") === "later", "the later value stays");
      expect(s.status(ana, typed) === "recovered", "her tab shows the edit as kept in a recovery copy");
      const copy = s.copyOf(ana, typed);
      expect(copy?.reason === "retired" && s.stored(ana, typed).out === "unanswered" && s.stored(ana, typed).action.value === "from-ana", "the copy stores her edit as one that was sent and never answered");
      expect(world.oracle.unprovable === 1 && world.oracle.replays.unjudged === 1 && !world.oracle.replays.applied, "the file holds the edit and cannot prove it, so a restore from the copy does not apply it again");
      expect(ana.clients.size === 2, "she continues under a new client id");
    },
  },
  {
    name: "holder-offers-a-retired-clients-action",
    about: "Ben holds Ana's action from a lost room. Ana sends it again herself and it is saved. A rotation trims her entry. When Ben returns and offers the action, the room cannot tell that it is a duplicate, so it refuses the offer and Ben keeps it in a recovery copy. A restore from that copy does not apply it a second time.",
    plants: ["retired-as-new", "restore-skips-ledger"],
    run() {
      const { s, world, tabs } = stage(3, { ledgerCap: 160 });
      const [ana, ben, cal] = tabs;
      const typed = s.type(ana, "r2", "c2", "from-ana");
      s.send(ana);
      s.recv(ben);
      s.offline(ana);
      s.offline(ben);
      s.loseRoom();
      s.answerAll();
      s.online(ana);
      s.flow();
      s.save(cal);
      s.answerAll();
      s.flow();
      expect(s.cell("r2", "c2") === "from-ana" && s.status(ana, typed) === "saved", "her own resend is saved");
      s.close(ana);
      churn(s, cal, 8, "guest");
      expect(!("t1" in s.file().state.seen), "a rotation trimmed her entry");
      s.type(cal, "r2", "c2", "later");
      s.flow();
      s.save(cal);
      s.answerAll();
      s.flow();
      s.online(ben);
      s.end();
      expect(s.cell("r2", "c2") === "later", "the later value stays");
      expect(world.oracle.adoptRefused.size === 1, "the room refused the offer");
      const copy = [...world.oracle.copies.values()].find((one) => one.by === ben.id);
      expect(copy?.reason === "retired" && copy.edits.includes(typed), "the holder keeps the refused tail in a recovery copy");
      expect(world.oracle.unprovable === 1 && world.oracle.replays.unjudged === 1 && !world.oracle.replays.applied, "the file holds the action and cannot prove it, so a restore from the copy does not apply it again");
    },
  },
  {
    name: "complete-prefix-capture",
    about: "A save is captured at one point of the order. Later actions and the tab's unsent edit are not in it.",
    plants: ["capture-live", "capture-overlay"],
    run() {
      const { s, tabs } = stage();
      const [a, b] = tabs;
      s.type(a, "r1", "c2", "one");
      s.flow();
      s.type(a, "r1", "c3", "not-yet");
      s.save(a);
      s.flow();
      s.type(b, "r2", "c1", "later");
      s.flow();
      s.answer();
      expect(s.file().record.through === 1 && s.cell("r1", "c3") === undefined && s.cell("r2", "c1") === undefined, "the file is exactly the first action");
      s.end();
    },
  },
  {
    name: "rotation-carries-the-tail",
    about: "A new generation starts while the room is open. Shared and pending edits carry over.",
    plants: ["copy-not-adopt"],
    run() {
      const { s, world, tabs } = stage();
      const [a, b] = tabs;
      const first = world.room.gen;
      s.type(a, "r1", "c2", "one");
      s.flow();
      s.type(b, "r2", "c2", "two");
      s.rotate(a);
      s.answer();
      expect(world.room.gen !== first, "a new generation is open");
      s.end();
      expect(s.cell("r1", "c2") === "one" && s.cell("r2", "c2") === "two", "both edits are saved");
      expect(!world.host.recoveries.length, "no recovery copy is written");
    },
  },
  {
    name: "a-tab-that-shows-a-value-holds-it",
    about: "Ben shows Ana's second edit when a receipt for the first one arrives. Ana closes and the room is lost. Ben still shows the value, so the oracle counts him as its holder, whatever his own records say. He offers it to the next room and it is saved.",
    plants: ["receipt-trims-all"],
    run() {
      const { s, tabs } = stage(2);
      const [ana, ben] = tabs;
      s.type(ana, "r1", "c2", "first");
      s.send(ana);
      s.recv(ben);
      s.save(ben);
      s.type(ana, "r2", "c2", "second");
      s.send(ana);
      s.recv(ben);
      s.answer();
      expect(view(ben).rows.r2.cells.c2 === "second", "Ben shows the unsaved value");
      s.close(ana);
      s.loseRoom();
      s.end();
      expect(s.cell("r2", "c2") === "second", "the value Ben showed is saved");
    },
  },
  {
    name: "held-paste-with-a-deleted-row",
    about: "Cal holds Ana's shared paste over three rows when the room is lost. Ben's delete of one of those rows is saved first, and then a restore cuts the history before Cal's offer goes in. No table can show the paste whole. Cal's recovery copy stores the paste itself, with all three cells.",
    plants: ["copy-trims-paste"],
    run() {
      const { s, world, tabs } = stage(3);
      const [ana, ben, cal] = tabs;
      s.offline(ben);
      s.remove(ben, "r3");
      const cells = [
        ["r1", "c2", "a"],
        ["r2", "c2", "b"],
        ["r3", "c2", "c"],
      ];
      const pasted = s.paste(ana, cells);
      s.send(ana);
      s.recv(cal);
      s.close(ana);
      s.offline(cal);
      s.loseRoom();
      s.online(ben);
      s.answerAll();
      s.flow();
      s.save(ben);
      s.answerAll();
      expect(s.file().state.wb.rows.r3 === undefined, "Ben's delete is saved");
      s.online(cal);
      expect(cal.held.length === 1 && view(cal).rows.r1.cells.c2 === undefined, "Cal holds the paste and cannot show it, because row r3 is gone");
      s.restore(0);
      s.end();
      const notice = cal.notices.find((one) => one.kind === "recovery" && one.edits.includes(pasted));
      const entry = readRecovery(world.host, notice?.copy)?.edits.find((one) => one.e === pasted);
      expect(entry?.action.cells.length === 3 && entry.out === "applied", "Cal's recovery copy stores the paste with its three cells, as an edit a room applied");
      expect(!world.oracle.homeless.size, "her tab did not turn the paste away");
    },
  },
  {
    name: "held-action-already-refused",
    about: "Ana's paste is carried through two lost rooms by Cal. The third generation refuses it, because Ben's delete of one of its rows went in first. Ana still holds her own copy of the paste from the first generation. A restore then cuts the history. Ana does not list the paste as kept, because her generation already refused it and told her so.",
    plants: ["lost-though-decided"],
    run() {
      const { s, world, tabs } = stage(3);
      const [ana, ben, cal] = tabs;
      s.offline(ben);
      s.remove(ben, "r4");
      const pasted = s.paste(ana, [
        ["r1", "c2", "a"],
        ["r2", "c2", "b"],
        ["r4", "c2", "d"],
      ]);
      s.send(ana);
      s.recv(ana);
      s.recv(cal);
      s.offline(ana);
      s.loseRoom();
      s.answerAll();
      s.send(cal);
      s.recv(cal);
      expect(world.room.seq === 1 && view(cal).rows.r1.cells.c2 === "a", "Cal carried the paste into the second generation");
      s.loseRoom();
      s.online(ben);
      s.answerAll();
      s.send(ben);
      s.send(cal);
      s.flow();
      s.save(cal);
      s.answerAll();
      expect(s.file().record.through === 2 && s.cell("r1", "c2") === undefined, "the third generation took Ben's delete and then refused the paste");
      s.online(ana);
      expect(s.status(ana, pasted) === "dropped" && ana.held.length === 1, "Ana is told, and she still holds the frame from the first generation");
      s.restore(0);
      s.end();
      expect(![...world.oracle.copies.values()].some((copy) => copy.edits.includes(pasted)), "no recovery copy lists the paste as kept");
      expect(ana.notices.some((notice) => notice.kind === "refused" && notice.edits.includes(pasted)), "Ana has the refusal notice with the paste");
    },
  },
  {
    name: "stale-file-at-attach",
    about: "Cal reads the file, and then a save moves the room's base past what she read. When she attaches, her file is older than the room's base, so she reads the file again before she attaches.",
    plants: ["attach-stale-file"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana, ben] = tabs;
      world.split = true;
      const cal = s.join();
      s.type(ana, "r1", "c2", "one");
      s.type(ana, "r2", "c2", "two");
      s.flow();
      s.save(ben);
      s.answerAll();
      s.link(ben);
      s.flow();
      expect(world.room.base.through === 2 && cal.fetched.file.record.through === 0, "the room's base is past the file Cal read");
      s.link(cal);
      expect(!cal.room && cal.fetched.file.record.through === 2, "Cal reads the file again instead of attaching");
      s.link(cal);
      s.type(ana, "r3", "c2", "three");
      s.flow();
      expect(view(cal).rows.r1.cells.c2 === "one" && view(cal).rows.r3.cells.c2 === "three", "Cal shows the saved and the new edits");
      world.split = false;
      s.end();
    },
  },
  {
    name: "last-tab-closes-and-the-room-stays",
    about: "The only tab closes with an edit in the room that is not saved. The host keeps the room. The next tab attaches, takes the room's unsaved tail and saves it.",
    plants: ["attach-no-tail", "expire-dirty-room"],
    run() {
      const { s, world, tabs } = stage(1, { retain: true });
      const [ana] = tabs;
      s.type(ana, "r1", "c2", "typed");
      s.send(ana);
      s.close(ana);
      expect(!s.expire() && world.room.seq === 1, "the host keeps the empty room while it holds unsaved work");
      const cal = s.join();
      expect(view(cal).rows.r1.cells.c2 === "typed", "the next tab shows the unsaved edit");
      s.end();
      expect(s.cell("r1", "c2") === "typed" && world.oracle.gens.size === 2, "the edit is saved in the same generation");
    },
  },
  {
    name: "empty-room-expires",
    about: "Every tab is away and the room has nothing unsaved, so the host drops it. The next tab gets a new room instance. The file names the old instance, so the tab starts a new generation before it edits.",
    plants: ["open-unnamed"],
    run() {
      const { s, world, tabs } = stage(2, { retain: true });
      const [ana, ben] = tabs;
      const first = s.type(ana, "r1", "c2", "saved");
      s.end();
      const before = world.room;
      s.offline(ana);
      s.offline(ben);
      expect(s.expire() && !world.room, "the host drops the clean empty room");
      s.online(ben);
      s.answerAll();
      expect(world.room.id !== before.id && world.room.gen !== before.gen, "a new instance serves a new generation");
      const second = s.type(ben, "r2", "c2", "after");
      s.online(ana);
      s.end();
      expect(s.status(ana, first) === "saved" && s.status(ben, second) === "saved" && s.cell("r2", "c2") === "after", "both edits are saved");
      expect(!world.host.recoveries.length, "no recovery copy is written");
    },
  },
  {
    name: "restart-with-unsaved-work",
    about: "The server restarts while the room holds an edit that Ben also has. The new instance cannot continue the old generation, because the file names the old instance. Ben starts a new generation and offers the edit, and it is saved.",
    plants: ["open-unnamed"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana, ben] = tabs;
      s.type(ana, "r1", "c2", "held");
      s.send(ana);
      s.recv(ben);
      s.close(ana);
      const before = world.room;
      s.loseRoom();
      expect(world.room.id !== before.id && !world.room.gen, "the new instance has opened no generation");
      s.answerAll();
      s.type(ben, "r2", "c2", "next");
      s.end();
      expect(s.cell("r1", "c2") === "held" && s.cell("r2", "c2") === "next", "the held edit and the new edit are saved");
    },
  },
  {
    name: "stale-open-is-refused",
    about: "Ben read the file when it named a generation that the room has since left. He asks the room to open that generation. The room checks the host file, refuses, and Ben reads again.",
    plants: ["stale-open"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana, ben] = tabs;
      world.split = true;
      s.rotate(ana);
      s.host();
      s.read(ben);
      s.deliver();
      s.link(ana);
      const second = world.room.gen;
      s.type(ana, "r1", "c2", "in-second");
      s.flow();
      s.rotate(ana);
      s.host();
      s.deliver();
      s.link(ana);
      expect(ben.fetched.file.record.gen === second && world.room.gen !== second, "Ben holds a file from a generation the room has left");
      s.link(ben);
      expect(world.room.gen !== second && ben.fetched.file.record.gen === world.room.gen, "the room refuses, and Ben reads the file again");
      world.split = false;
      s.type(ben, "r2", "c2", "from-ben");
      s.end();
      expect(s.cell("r1", "c2") === "in-second" && s.cell("r2", "c2") === "from-ben", "both edits are saved");
    },
  },
  {
    name: "agent-write-through-the-host",
    about: "An agent writes a cell through the host while the room holds an unsaved edit. The host backs up the room's work as a version, starts a new generation and resets the room. The agent's value stays, Ana gets a notice, and a later edit on top is saved.",
    plants: ["outside-no-reset", "restore-no-backup"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana, ben] = tabs;
      const draft = s.type(ana, "r1", "c2", "draft");
      s.flow();
      const before = world.room.gen;
      s.outside("agent", "live", { t: "set", row: "r2", col: "c2", value: "from-agent" });
      expect(world.room.gen !== before && s.cell("r2", "c2") === "from-agent" && s.cell("r1", "c2") === undefined, "the file holds the agent's value in a new generation, without the unsaved edit");
      const backup = world.host.versions.find((version) => version.kind === "backup");
      expect(parse(backup.body).state.wb.rows.r1.cells.c2 === "draft", "the room's unsaved edit is in a backup version");
      const next = s.type(ben, "r2", "c2", "on-top");
      s.end();
      expect(s.cell("r2", "c2") === "on-top" && s.status(ben, next) === "saved", "an edit on top of the agent's value is saved");
      expect(ana.notices.some((notice) => notice.edits.includes(draft)), "Ana has a notice for the edit that went to the backup");
    },
  },
  {
    name: "refused-write-then-an-outside-write",
    about: "Ben deletes a row. Ana has not heard of it and types into that row, so the room refuses her edit. An agent write replaces the file before Ana hears anything. The backup version does not hold her text. Her tab cannot tell, so its notice keeps the text.",
    plants: ["cut-means-backed-up"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana, ben] = tabs;
      s.remove(ben, "r2");
      s.send(ben);
      const typed = s.type(ana, "r2", "c1", "ana-text");
      s.send(ana);
      expect(world.oracle.refused.has(typed), "the room refused Ana's edit, because the row was gone");
      s.outside("agent", "live", { t: "set", row: "r3", col: "c1", value: "from-agent" });
      const backup = world.host.versions.find((version) => version.kind === "backup");
      expect(backup && parse(backup.body).state.wb.rows.r2 === undefined, "the backup version has no row for her text");
      s.end();
      const notice = ana.notices.find((one) => one.edits.includes(typed));
      expect((notice?.action ?? notice?.actions?.[typed])?.value === "ana-text", "Ana's notice holds her text");
      expect(s.status(ana, typed) !== "saved", "her tab does not show the edit as saved");
    },
  },
  {
    name: "upload-drops-the-room",
    about: "Hyperclay Local uploads an older copy with one change made offline. This host drops the room on an outside write instead of reopening it. The tabs get a new instance, start a generation on the uploaded file, and an edit that was never sent is saved on top.",
    plants: ["outside-no-reset", "restore-keeps-lineage"],
    run() {
      const { s, world, tabs } = stage(2, { outside: "drop" });
      const [ana, ben] = tabs;
      const kept = s.type(ana, "r1", "c2", "later-work");
      s.end();
      s.offline(ben);
      const unsent = s.type(ben, "r3", "c2", "unsent");
      s.type(ana, "r1", "c3", "in-room");
      s.flow();
      const before = world.room;
      s.outside("upload", 0, { t: "set", row: "r2", col: "c2", value: "offline" });
      expect(world.room.id !== before.id && !world.room.gen && s.file().record.room === null, "the host dropped the room, the file names no instance, and the new instance has opened nothing");
      s.online(ben);
      s.end();
      expect(s.cell("r2", "c2") === "offline" && s.cell("r1", "c2") === undefined && s.cell("r1", "c3") === undefined, "the file is the uploaded copy");
      expect(s.cell("r3", "c2") === "unsent" && s.status(ben, unsent) === "saved", "the edit that was never sent is saved on top");
      expect(ana.notices.some((notice) => notice.edits.includes(kept)) || s.status(ana, kept) === "saved", "the replaced work is in versions, and the tab that made it is told or shows it saved");
    },
  },
  {
    name: "file-mode-two-tabs-save",
    about: "A host with no room. Two tabs edit different cells and save whole files. The second save is refused by the ETag, the tab reads the file, puts its edit on top and saves again. Both edits are in the file.",
    plants: ["file-save-no-rebase", "file-save-unconditional"],
    run() {
      const { f, tabs } = fileStage(2);
      const [ana, ben] = tabs;
      const one = f.type(ana, "r1", "c2", "ana");
      const two = f.type(ben, "r2", "c2", "ben");
      f.save(ana);
      f.save(ben);
      f.answer();
      f.answer();
      expect(f.status(ana, one) === "saved" && f.status(ben, two) === "pending", "the first save lands, and the second is refused");
      f.end();
      expect(f.cell("r1", "c2") === "ana" && f.cell("r2", "c2") === "ben", "both edits are in the file");
      expect(f.status(ben, two) === "saved", "the second tab shows saved after its second write");
    },
  },
  {
    name: "file-mode-lost-answer",
    about: "A host with no room. A save lands and its answer is lost. Another tab then writes the same cell. The first tab reads the file, finds its request number in the ledger, and does not send the edit again.",
    plants: ["file-unknown-resend", "file-ack-on-send", "file-copy-keeps-saved"],
    run() {
      const { f, world, tabs } = fileStage(2);
      const [ana, ben] = tabs;
      const never = f.type(ben, "r3", "c2", "never-lands");
      f.save(ben);
      f.host(0, true);
      expect(f.status(ben, never) === "pending", "a save that never reached the host shows nothing as saved");
      f.deliver();
      const first = f.type(ana, "r1", "c2", "older");
      f.save(ana);
      f.host();
      f.deliver(0, true);
      expect(f.status(ana, first) === "pending" && f.cell("r1", "c2") === "older", "the save landed and the tab does not know");
      f.refresh(ben);
      f.type(ben, "r1", "c2", "newer");
      f.end();
      expect(f.cell("r1", "c2") === "newer" && f.cell("r3", "c2") === "never-lands", "the later value stays, and the lost save was sent again");
      expect(f.status(ana, first) === "saved" && world.accepted === 2, "the first tab learned from the ledger that its save had landed");
    },
  },
  {
    name: "file-mode-outside-write",
    about: "A host with no room. A save lands with no answer, and then a restore through the host replaces the file. The restore keeps the request ledger, so the tab does not put its replaced edit back on top of the restored file.",
    plants: ["file-outside-forgets-ledger"],
    run() {
      const { f, tabs } = fileStage(1);
      const [ana] = tabs;
      const typed = f.type(ana, "r1", "c2", "before-restore");
      f.save(ana);
      f.host();
      f.deliver(0, true);
      f.outside(0, null);
      const later = f.type(ana, "r2", "c2", "after-restore");
      f.end();
      expect(f.cell("r1", "c2") === undefined && f.cell("r2", "c2") === "after-restore", "the file is the restored version plus the edit made after it");
      expect(f.status(ana, typed) === "saved" && f.status(ana, later) === "saved", "the replaced edit was saved once, in a version the restore replaced");
    },
  },
  {
    name: "file-mode-raw-replace",
    about: "A host with no room. Another program replaces the file with an older copy plus its own change, and knows nothing of the protocol. The open tab's next save is refused, the tab reads the file and puts only its unsaved edit on top. The other program's change stays.",
    plants: ["file-save-no-rebase", "file-resend-saved"],
    run() {
      const { f, tabs } = fileStage(1);
      const [ana] = tabs;
      const saved = f.type(ana, "r1", "c2", "saved-earlier");
      f.save(ana);
      f.answer();
      const pending = f.type(ana, "r2", "c2", "unsaved");
      f.outside(0, { t: "set", row: "r3", col: "c2", value: "other-program" }, true);
      f.end();
      expect(f.cell("r3", "c2") === "other-program" && f.cell("r2", "c2") === "unsaved", "the other program's change and the unsaved edit are both in the file");
      expect(f.cell("r1", "c2") === undefined && f.status(ana, saved) === "saved" && f.status(ana, pending) === "saved", "the earlier edit went with the file the other program replaced");
    },
  },
  {
    name: "file-mode-ledger-returns",
    about: "A host with no room. Ana's save lands and its answer is lost. Another program puts back an older copy, so the file's ledger forgets her save. Then the host restores the version that holds it. Her tab checks the ledger on every read, so it does not send the edit a second time.",
    plants: ["file-settle-once"],
    run() {
      const { f, world, tabs } = fileStage(1);
      const [ana] = tabs;
      const id = f.type(ana, "r1", "c2", "once");
      f.save(ana);
      f.host();
      f.deliver(0, true);
      const held = world.host.versions.length - 1;
      f.outside(0, null, true);
      f.refresh(ana);
      expect(f.status(ana, id) !== "saved" && f.cell("r1", "c2") === undefined, "after the older copy, the file does not hold the edit and the tab does not show it saved");
      f.outside(held, null, false);
      f.end();
      expect(f.cell("r1", "c2") === "once" && f.status(ana, id) === "saved", "the restored version holds the edit and the tab shows it saved");
      expect(world.accepted === 1, `the tab saved the edit once (${world.accepted} accepted saves)`);
    },
  },
  {
    name: "file-mode-old-version-after-a-trim",
    about: "A host with no room. Ana's second save lands and its answer is lost. Other tabs save until a trim drops her ledger entry. Then the host restores a version from before her second save, whose ledger still names her. The restore does not bring her entry back, so her tab cannot take the old count for the truth: it keeps the edit in a recovery copy and does not save it again.",
    plants: ["file-fold-revives-retired"],
    run() {
      const { f, world, tabs } = fileStage(1, { ledgerCap: 102 });
      const [ana] = tabs;
      f.type(ana, "r1", "c2", "first");
      f.save(ana);
      f.answer();
      const old = world.host.versions.length - 1;
      const second = f.type(ana, "r1", "c3", "second");
      f.save(ana);
      f.host();
      f.deliver(0, true);
      for (let i = 0; i < 2; i++) {
        const tab = f.open();
        f.type(tab, "r2", "c2", `guest-${i}`);
        f.save(tab);
        f.answer();
        f.close(tab);
      }
      expect(!(ana.client in get(world.host).state.seen), "a trim dropped Ana's ledger entry");
      f.outside(old, null, false);
      f.end();
      expect(f.status(ana, second) === "recovered" && f.cell("r1", "c3") === undefined, "the edit is in a recovery copy and not in the file a second time");
      expect(world.host.recoveries.length === 1 && ana.clients.size === 2, "one recovery copy, and the tab works on under a new client id");
    },
  },
  {
    name: "file-mode-trimmed-version-returns",
    about: "A host with no room. Ana's save lands and its answer is lost. Other tabs save until a trim drops her ledger entry. Another program puts back the first file, so her tab reads a ledger that never saw her. Then the host restores the trimmed version, which holds her edit and no entry for her. Her tab cannot prove the edit is absent, so it keeps it in a recovery copy and does not save it a second time.",
    plants: ["file-retired-resends"],
    run() {
      const { f, world, tabs } = fileStage(1, { ledgerCap: 102 });
      const [ana] = tabs;
      const id = f.type(ana, "r1", "c2", "first");
      f.save(ana);
      f.host();
      f.deliver(0, true);
      for (let i = 0; i < 2; i++) {
        const tab = f.open();
        f.type(tab, "r2", "c2", `guest-${i}`);
        f.save(tab);
        f.answer();
        f.close(tab);
      }
      const trimmed = world.host.versions.length - 1;
      expect(!(ana.client in get(world.host).state.seen) && f.cell("r1", "c2") === "first", "the trimmed file holds her edit and no ledger entry for her");
      f.outside(0, null, true);
      f.refresh(ana);
      expect(f.status(ana, id) === "pending", "after the first file came back, the tab holds the edit as unsaved");
      f.outside(trimmed, null, false);
      f.end();
      expect(f.status(ana, id) === "recovered" && f.cell("r1", "c2") === "first", "the edit is in the file once and the tab keeps its own copy");
      expect(world.host.recoveries.length === 1 && world.accepted === 3, `one recovery copy, and no second save of the edit (${world.accepted} accepted saves)`);
    },
  },
  {
    name: "file-mode-old-entry-under-a-trimmed-version",
    about: "A host with no room. Ana's second save lands and its answer is lost. Other tabs save until a trim drops her ledger entry. Another program puts back the file from after her first save, whose ledger names her with one request. Then the host restores the trimmed version, which holds both of her edits. The old entry says less than those tables hold, so the restore does not keep it. Her tab keeps the second edit in a recovery copy and does not save it again.",
    plants: ["file-fold-keeps-stale"],
    run() {
      const { f, world, tabs } = fileStage(1, { ledgerCap: 102 });
      const [ana] = tabs;
      f.type(ana, "r1", "c2", "first");
      f.save(ana);
      f.answer();
      const old = world.host.versions.length - 1;
      const second = f.type(ana, "r1", "c3", "second");
      f.save(ana);
      f.host();
      f.deliver(0, true);
      for (let i = 0; i < 2; i++) {
        const tab = f.open();
        f.type(tab, "r2", "c2", `guest-${i}`);
        f.save(tab);
        f.answer();
        f.close(tab);
      }
      const trimmed = world.host.versions.length - 1;
      expect(!(ana.client in get(world.host).state.seen) && f.cell("r1", "c3") === "second", "the trimmed file holds her second edit and no ledger entry for her");
      f.outside(old, null, true);
      expect(get(world.host).state.seen[ana.client]?.[0] === 1, "the file that came back names her with one request");
      f.outside(trimmed, null, false);
      f.end();
      expect(f.status(ana, second) === "recovered" && f.cell("r1", "c3") === "second", "the edit is in the file once and the tab keeps its own copy");
      expect(world.host.recoveries.length === 1 && world.accepted === 4, `one recovery copy, and no second save of the edit (${world.accepted} accepted saves)`);
    },
  },
  {
    name: "file-mode-save-on-an-older-file-starts-a-new-epoch",
    about: "A host with no room. Ana saves in epoch 1. Another program puts back a file from epoch 0. Ana saves a third edit on it and the answer is lost. Her tab has seen epoch 1, so this save starts epoch 2 and does not run the count a second time. Other tabs save until a trim drops her entry. Then the host restores the version from epoch 1, which names her. The stamp in that version is below the floor of the trim, so the restore does not bring her entry back, and her third edit goes to a recovery copy.",
    plants: ["file-save-reuses-epoch"],
    run() {
      const { f, world, tabs } = fileStage(1, { ledgerCap: 102 });
      const [ana] = tabs;
      f.type(ana, "r1", "c2", "first");
      f.save(ana);
      f.answer();
      const old = world.host.versions.length - 1;
      f.outside("live", null, false);
      f.refresh(ana);
      f.type(ana, "r1", "c3", "second");
      f.save(ana);
      f.answer();
      const later = world.host.versions.length - 1;
      expect(get(world.host).state.seen[ana.client]?.[1] === 1, "her entry carries the stamp of epoch 1");
      f.outside(old, null, true);
      f.refresh(ana);
      const third = f.type(ana, "r2", "c2", "third");
      f.save(ana);
      f.host();
      f.deliver(0, true);
      for (let i = 0; i < 2; i++) {
        const tab = f.open();
        f.type(tab, "r3", "c2", `guest-${i}`);
        f.save(tab);
        f.answer();
        f.close(tab);
      }
      expect(!(ana.client in get(world.host).state.seen) && f.cell("r2", "c2") === "third", "a trim dropped her entry, and the file holds her third edit");
      f.outside(later, null, false);
      f.end();
      expect(f.status(ana, third) === "recovered" && f.cell("r2", "c2") === undefined, "the third edit is in a recovery copy and did not come back into the restored file");
    },
  },
  {
    name: "file-mode-row-gone",
    about: "A host with no room. One tab writes into a row that another tab deletes and saves first. The write is refused with a notice that holds the value.",
    plants: ["file-refuse-silent"],
    run() {
      const { f, tabs } = fileStage(2);
      const [ana, ben] = tabs;
      const typed = f.type(ana, "r3", "c2", "typed");
      f.remove(ben, "r3");
      f.save(ben);
      f.answer();
      f.end();
      expect(f.status(ana, typed) === "dropped", "the write is refused");
      expect(ana.notices.some((notice) => notice.kind === "refused" && notice.action.value === "typed"), "the notice holds the value");
    },
  },
  {
    name: "file-mode-many-clients",
    about: "A host with no room. Three hundred tabs open, save one edit and close, one after another. The request ledger stays under its byte cap, and a tab that the ledger dropped keeps working under a new client id.",
    plants: ["file-no-ledger-trim"],
    run() {
      const { f, world, tabs } = fileStage(1);
      const [stay] = tabs;
      const mine = [f.type(stay, "r1", "c2", "first")];
      f.save(stay);
      f.answer();
      for (let i = 0; i < 300; i++) {
        const tab = f.open();
        f.type(tab, "r2", "c3", `w${i}`);
        f.save(tab);
        f.answer();
        f.close(tab);
      }
      mine.push(f.type(stay, "r1", "c3", "last"));
      f.end();
      expect(world.oracle.maxLedger <= world.limits.ledgerCap, "the ledger stayed under its cap");
      expect(mine.every((id) => f.status(stay, id) === "saved") && stay.clients.size > 1, "the tab that stayed was dropped from the ledger, took a new client id, and its later edit is saved");
      expect(f.cell("r1", "c3") === "last" && f.cell("r2", "c3") === "w299", "the file holds the last edits");
    },
  },
  {
    name: "file-mode-refused-edit-with-a-lost-answer",
    about: "A host with no room. Ana types into a row that Ben's saved delete has removed. Her save lands, the file counts the request and drops the edit, and the answer is lost. Other tabs save until a trim drops her ledger entry. Her tab cannot learn what the file did, so it keeps the edit in a recovery copy. The copy stores the edit itself with its text. The copy's table is the file with the stored edits on it, so it does not show the row, and the tab does not say that it does.",
    plants: ["file-copy-table-only"],
    run() {
      const { f, world, tabs } = fileStage(2, { ledgerCap: 102 });
      const [ana, ben] = tabs;
      const text = "retained value after a lost refusal reply";
      const typed = f.type(ana, "r3", "c2", text);
      f.remove(ben, "r3");
      f.save(ben);
      f.answer();
      f.save(ana);
      f.answer();
      expect(ana.pending.length === 1 && ana.base.state.wb.rows.r3 === undefined, "Ana's first save was refused by the ETag, and her tab now sees that the row is gone");
      f.save(ana);
      f.host();
      f.deliver(0, true);
      f.guests(10);
      expect(!(ana.client in get(world.host).state.seen), "a trim dropped Ana's ledger entry");
      f.refresh(ana);
      f.end();
      const copy = f.copyOf(ana, typed);
      const entry = copy?.edits.find((one) => one.e === typed);
      expect(f.status(ana, typed) === "recovered" && entry?.action.value === text && entry.out === "unanswered" && entry.sent[1] === false, "the stored copy holds the edit with its text, as an edit with no answer that the tab had judged not to fit");
      expect(copy.preview.rows.r3 === undefined && world.host.recoveries[0].body.includes(text), "the copy's table has no such row, and the stored bytes hold the text");
      expect(world.oracle.unprovable === 1 && world.oracle.replays.unjudged === 1 && !world.oracle.replays.applied, "the file had counted the request, and a replay cannot judge the edit, because the ledger dropped its client, so it takes nothing");
    },
  },
  {
    name: "file-mode-saved-edit-with-a-lost-answer",
    about: "A host with no room. Ana's save lands and the answer is lost. Other tabs save until a trim drops her ledger entry. The file holds her edit, and nothing in the file can prove it to her tab. The tab keeps the edit in a recovery copy. A restore from that copy goes through the ledger check, which cannot judge the edit and so does not write it a second time.",
    plants: ["restore-skips-ledger"],
    run() {
      const { f, world, tabs } = fileStage(1, { ledgerCap: 102 });
      const [ana] = tabs;
      const typed = f.type(ana, "r3", "c2", "saved and not confirmed");
      f.save(ana);
      f.host();
      f.deliver(0, true);
      f.guests(10);
      expect(!(ana.client in get(world.host).state.seen) && f.cell("r3", "c2") === "saved and not confirmed", "the file holds the edit, and a trim dropped Ana's ledger entry");
      f.end();
      const entry = f.copyOf(ana, typed)?.edits.find((one) => one.e === typed);
      expect(f.status(ana, typed) === "recovered" && entry?.out === "unanswered" && entry.sent[1] === true, "the copy stores the edit as one with no answer");
      expect(world.oracle.unprovable === 1 && world.oracle.replays.unjudged === 1 && !world.oracle.replays.applied, "the oracle counts one stored edit that the file holds, and a replay does not apply it");
      expect(world.accepted === 11, `the tab did not save the edit a second time (${world.accepted} accepted saves)`);
    },
  },
  {
    name: "file-mode-copy-write-the-host-dropped",
    about: "The same session, and the host drops the first write of the recovery copy. The tab reads the stored bytes back, finds none, and reports no recovery. It sends nothing until the copy is stored, writes it again on its next read, and reports it then.",
    plants: ["file-copy-unconfirmed"],
    run: () => fileUnstored("drop"),
  },
  {
    name: "file-mode-copy-write-the-host-blanked",
    about: "The same session, and the host stores the first write of the recovery copy with no edits and an empty table. The bytes the tab reads back are not the bytes it sent, so it reports no recovery until a second write is stored whole.",
    plants: ["file-copy-unconfirmed"],
    run: () => fileUnstored("blank"),
  },
  {
    name: "file-mode-push-while-editing",
    about: "HTML Clay pushes every saved document, with its ETag, to the other open tabs. Ana saves, and the host pushes her file to Ben, who has an unsaved edit. Ben's tab takes the pushed document through the same path as a read: it puts his edit on top of her file. His save passes the ETag check the first time and both edits are in the file.",
    plants: ["file-push-skips-rebase"],
    run() {
      const { f, world, tabs } = fileStage(2, { pushing: true });
      const [ana, ben] = tabs;
      const one = f.type(ana, "r1", "c2", "ana");
      f.save(ana);
      f.answer();
      const two = f.type(ben, "r2", "c2", "ben");
      expect(world.pushes.length === 1 && world.pushes[0].tab === ben, "the host pushed Ana's file to Ben and not back to Ana");
      f.push(ben);
      expect(ben.base.etag === world.host.etag, "Ben's tab holds the ETag of the pushed document");
      f.save(ben);
      f.answer();
      expect(world.refused === 0 && f.status(ben, two) === "saved" && f.status(ana, one) === "saved", "his save passed the ETag check the first time");
      expect(F.view(ben).rows.r1.cells.c2 === "ana" && F.view(ben).rows.r2.cells.c2 === "ben", "Ben's tab shows her saved value and his own");
      f.end();
      expect(f.cell("r1", "c2") === "ana" && f.cell("r2", "c2") === "ben", "both edits are in the file");
    },
  },
  {
    name: "file-mode-push-after-a-lost-answer",
    about: "Ana's save lands and the answer is lost. Ben then saves, and the host pushes his file to Ana. Her tab reads the ledger in the pushed document, as it would after a read, finds her request there and shows the edit as saved. It does not send the edit again.",
    plants: ["file-push-skips-settle"],
    run() {
      const { f, world, tabs } = fileStage(2, { pushing: true });
      const [ana, ben] = tabs;
      const one = f.type(ana, "r1", "c2", "ana");
      f.save(ana);
      f.host();
      f.deliver(0, true);
      f.push(ben);
      f.type(ben, "r2", "c2", "ben");
      f.save(ben);
      f.answer();
      expect(f.status(ana, one) === "pending" && world.pushes.length === 1, "Ana's tab does not know that her save landed, and Ben's file is on its way to her");
      f.push(ana);
      expect(f.status(ana, one) === "saved" && !ana.pending.length && !ana.unknown, "the ledger in the pushed document settled her edit");
      f.end();
      expect(world.accepted === 2 && f.cell("r1", "c2") === "ana" && f.cell("r2", "c2") === "ben", `each edit was saved once (${world.accepted} accepted saves)`);
    },
  },
  {
    name: "file-mode-old-push-after-a-raw-replace",
    about: `A pushed document can be older than the file. Guests save until a trim raises the ledger's floor, and those files wait in Ana's push stream. Another program then puts back the first copy of the file. Ana reads it and saves an edit, and the answer is lost. Then the old push arrives. Its ledger has no entry for her and its floor has passed her client, which on a read would mean that the file dropped her. Her tab does not conclude that from a push. It reads the file, finds her request in the ledger, and shows the edit as saved.`,
    plants: ["file-push-retires"],
    run() {
      const { f, world, tabs } = fileStage(1, { ledgerCap: 102, pushing: true });
      const [ana] = tabs;
      f.guests(10);
      const floors = world.pushes.map((one) => parse(one.body).state.floor);
      expect(floors.some((floor) => floor >= ana.born), "one of the files in Ana's push stream has a floor that passed her client");
      f.outside(0, null, true);
      f.refresh(ana);
      const typed = f.type(ana, "r3", "c2", "after the old copy came back");
      f.save(ana);
      f.host();
      f.deliver(0, true);
      expect(f.cell("r3", "c2") === "after the old copy came back" && ana.unknown, "the save landed, and Ana's tab does not know");
      while (world.pushes.length && parse(world.pushes[0].body).state.floor < ana.born) f.push(ana, true);
      f.push(ana);
      expect(f.status(ana, typed) === "saved" && !world.host.recoveries.length && ana.clients.size === 1, "her tab read the file, found her request in its ledger, and made no recovery copy");
      f.end();
      expect(world.accepted === 11, `the edit was saved once (${world.accepted} accepted saves)`);
    },
  },
  {
    name: "cell-text-is-escaped",
    about: "Cell text with quotes, tags, entities and non-ASCII characters is escaped in the HTML table. The oracle reads the stored file with its own reader and finds the same text.",
    plants: ["no-escape"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana, ben] = tabs;
      const text = 'quote " & <script> café 🐈 </td><td data-col="c3">x &amp; &lt;';
      s.type(ana, "r1", "c2", text);
      s.type(ben, "r2", "c2", "</tr></table></script>");
      s.end();
      expect(s.cell("r1", "c2") === text && s.cell("r2", "c2") === "</tr></table></script>", "the file returns the same text");
      expect(s.cell("r1", "c3") === undefined, "no cell appears out of the text");
      expect(world.host.body.startsWith("<!doctype html><table><tr data-id=") && world.host.body.includes("&lt;script&gt; café 🐈"), "the file body is an HTML table with escaped text");
    },
  },
  {
    name: "room-store-cap",
    about: "The room store has a byte cap. The room refuses actions that would pass it until a save is confirmed, then takes them.",
    plants: ["no-tail-cap"],
    run() {
      const { s, world, tabs } = stage();
      const [a, b] = tabs;
      for (let i = 0; i < 30; i++) s.type(a, "r1", "c2", `v${i}`);
      s.send(a);
      expect(world.room.seq < 30 && world.room.bytes.tail <= tailBudget(world.limits), "the room stops at its byte cap");
      expect(world.room.seq >= 16, `the cap leaves room for a working tail (${world.room.seq} actions)`);
      s.flow();
      s.save(b);
      s.answer();
      s.end();
      expect(s.cell("r1", "c2") === "v29", "every edit is saved after the room has space again");
    },
  },
  {
    name: "paste-travels-in-parts",
    about: "A paste of five cells is larger than one frame. It goes up as three part frames. The room admits nothing until the last part is there, then admits one action. Another tab applies it only when it has every part.",
    plants: ["paste-part-admit", "apply-partial-paste", "oversize-frame"],
    run() {
      const { s, world, tabs } = stage(2);
      const [ana, ben] = tabs;
      const id = s.paste(ana, FIVE);
      let frames = 0;
      while (ana.out.length) {
        s.send(ana, 0);
        if (++frames < 3) expect(world.room.seq === 0, `part ${frames} of 3 admits nothing`);
      }
      expect(frames === 3 && world.room.seq === 1 && world.room.log[0].action.cells.length === 5, "the third part admits the whole paste as one action");
      s.recv(ben, 2);
      expect(view(ben).rows.r1.cells.c2 === undefined, "a tab with two of three parts shows none of the paste");
      s.recv(ben);
      expect(view(ben).rows.r1.cells.c3 === "e", "the tab applies the paste when the last part arrives");
      s.end();
      expect(FIVE.every(([row, col, value]) => s.cell(row, col) === value) && s.status(ana, id) === "saved", "the paste is saved whole");
    },
  },
  {
    name: "held-paste-is-recovered-whole",
    about: "Ben holds a five-cell paste when the room is lost. Cal has only two of its three parts, so Cal holds none of it. Ben offers it to the next room in parts, and it is adopted as one action.",
    plants: ["paste-part-admit"],
    run() {
      const { s, world, tabs } = stage(3, { armLater: true });
      const [ana, ben, cal] = tabs;
      s.paste(ana, FIVE);
      s.send(ana);
      s.recv(ben);
      s.recv(cal, 2);
      s.close(ana);
      s.offline(ben);
      s.loseRoom();
      s.answerAll();
      s.arm();
      expect(!cal.held.length && s.cell("r1", "c2") === undefined, "Cal holds no part of the paste, and the file has none of it");
      s.online(ben);
      expect(ben.out.filter((frame) => frame.k === "part" && frame.of === "adopt").length === 3, "Ben offers the paste in three parts");
      s.end();
      expect(FIVE.every(([row, col, value]) => s.cell(row, col) === value), "the paste is in the file whole");
      expect(world.oracle.adopted === 1 && !world.host.recoveries.length, "it was adopted as one action, with no recovery copy");
    },
  },
  {
    name: "action-over-the-cap",
    about: "A paste larger than the action cap is refused in the tab with a notice. Nothing is sent, so the room never holds an action that it could not fit.",
    plants: ["no-action-cap"],
    run() {
      const { s, tabs } = stage(2);
      const [ana] = tabs;
      const id = s.paste(ana, wide(70, "big"));
      s.send(ana);
      expect(id === null && ana.notices.some((notice) => notice.kind === "too-large"), "the tab refuses it with a notice");
      s.end();
      expect(s.cell("r1", "k0") === undefined, "none of it is in the file");
    },
  },
  {
    name: "staging-counts-against-the-room-cap",
    about: "The unsaved tail is close to the store cap. Three tabs each start a large paste. The room reserves space for two and refuses the third until a save frees space. All three are saved.",
    plants: ["no-stage-cap"],
    run() {
      const { s, world, tabs } = stage(4);
      const [ana, ...others] = tabs;
      for (let i = 0; i < 19; i++) s.type(ana, "r1", "c2", `fill-${i}`);
      s.send(ana);
      const ids = others.map((tab, i) => s.paste(tab, wide(40, `p${i}-`)));
      for (const tab of others) s.send(tab, 0);
      expect(world.room.staging.size === 2 && others[2].throttled, "the room stages two pastes and refuses the third");
      s.end();
      expect(ids.every((id, i) => id && s.status(others[i], id) === "saved"), "all three pastes are saved after the tail is saved");
    },
  },
  {
    name: "twenty-thousand-cell-paste",
    about: "On the standard sheet with the real ClayJS caps (128 operations per frame, 4 MiB store, 6 MiB room), a paste of all 20,000 cells goes up as 157 part frames. The room admits it as one action, and the other tab applies it when its last part arrives. Five more pastes fill the store, because each paste frame also carries the 20,000 values its author saw (about 784 KB a paste). The next one waits for a save, and all are saved.",
    plants: ["no-tail-cap"],
    run() {
      const { wb, cells } = fromFixture(FIXTURES.standard());
      const { s, world, tabs } = stage(2, { workbook: wb, limits: REAL_LIMITS });
      const [ana, ben] = tabs;
      const last = cells.length - 1;
      const paste = (tag) => s.paste(ana, cells.map(([row, col], i) => [row, col, `${tag}-${i}`]));
      const first = paste("p0");
      expect(cells.length === 20000 && ana.out.length === 157 && ana.out.every((frame) => frame.k === "part" && frame.cells.length <= 128), "the paste leaves as 157 part frames of at most 128 operations");
      for (let i = 0; i < 156; i++) toRoom(world, ana);
      expect(world.room.seq === 0 && world.room.staging.size === 1, "156 parts admit nothing");
      s.send(ana);
      expect(world.room.seq === 1 && world.room.bytes.tail > 500000, "the last part admits one action of about 530 KB");
      s.recv(ben, 156);
      expect(ben.a === 0, "the other tab applies nothing while a part is missing");
      s.recv(ben);
      expect(ben.a === 1 && view(ben).rows[cells[last][0]].cells[cells[last][1]] === `p0-${last}`, "it applies the paste when the last part arrives");
      s.save(ben);
      s.answerAll();
      s.flow();
      expect(s.status(ana, first) === "saved", "the paste is saved");
      const more = [];
      for (let k = 1; k <= 8; k++) more.push(paste(`p${k}`));
      s.send(ana);
      expect(world.room.seq === 6 && ana.throttled, "the store takes five more pastes and refuses the sixth, because a paste frame also carries the 20,000 values its author saw");
      expect(world.room.bytes.tail <= tailBudget(world.limits), "the unsaved tail is within the store cap");
      s.end();
      expect(more.every((id) => s.status(ana, id) === "saved"), "every paste is saved after a save frees the store");
      expect(s.cell(cells[last][0], cells[last][1]) === `p8-${last}`, "the file holds the last paste");
    },
  },
  {
    name: "room-restore-applies-and-saves",
    about: "Ana's two shared edits end in a recovery copy after a version restore. Cal restores from the copy in the room. The room judges each stored edit against its own ledger, applies both, and Cal's tab reports them as restored only after a save holds them. Ana's tab then shows her edits as saved.",
    plants: ["restore-notice-before-save", "restore-reports-applied"],
    run() {
      const { s, world, ana, cal, copy, first, second } = copied();
      s.restoreCopy(cal, copy);
      s.send(cal);
      expect(world.room.seq === 2 && world.room.state.wb.rows.r1.cells.c2 === "first" && world.room.state.wb.rows.r2.cells.c2 === "second", "the room applies both stored edits");
      expect(world.room.log.filter((frame) => frame.copy).map((frame) => frame.e).join() === [first, second].join(), "each enters the room as an action that names the copy");
      expect(!s.restored(cal) && cal.job, "Cal's tab reports nothing while no save holds the edits");
      s.end();
      const notice = s.restored(cal);
      expect(notice?.applied.join() === [first, second].join() && !notice.conflicts.length && !notice.left.length, "after the save the notice lists both edits as restored");
      expect(s.cell("r1", "c2") === "first" && s.cell("r2", "c2") === "second", "the file holds both");
      expect(s.status(ana, first) === "saved" && s.status(ana, second) === "saved", "Ana's tab shows her edits as saved");
    },
  },
  {
    name: "room-restore-after-a-coworker-edit",
    about: "Race with a normal edit, coworker first. Ben types into the cell of Ana's first stored edit, and the room admits Ben's edit before Cal's restore reaches it. The room leaves Ana's edit for a person as a conflict that shows Ben's value next to hers, and writes nothing over Ben's value. Her second stored edit is judged on its own: its cell holds what she saw, so it lands. The decision record lists the first edit as open before the room counts the second.",
    plants: ["restore-ignores-seen", "room-restore-trusts-the-tab", "notice-wrong-current-value", "later-edit-held-anyway", "pass-without-record"],
    run() {
      const { s, world, ben, cal, copy, first, second } = copied();
      s.restoreCopy(cal, copy);
      const theirs = s.type(ben, "r1", "c2", "coworker");
      s.send(ben);
      s.send(cal);
      s.end();
      const notice = s.restored(cal);
      expect(JSON.stringify(notice?.conflicts) === JSON.stringify([{ e: first, cells: [["r1", "c2", "coworker", "first"]] }]), "the notice shows the current value next to the copy's value");
      expect(notice.applied.join() === second && !notice.left.length && !notice.held.length, "the second edit of that author lands");
      expect(world.host.decisions.some((mark) => mark.copy === copy && mark.e === first && mark.kind === "open"), "the decision record lists the first edit as open");
      expect(s.cell("r1", "c2") === "coworker" && s.cell("r2", "c2") === "second" && s.status(ben, theirs) === "saved", "the file keeps the coworker's value and holds the second edit");
    },
  },
  {
    name: "room-restore-refuses-a-stored-edit",
    about: "Ben deletes the row of Ana's first stored edit before Cal restores from the copy. The room counts that edit and refuses it, as it does for a normal request, and applies her second. Ana's tab saw the room refuse the first, so it no longer shows it as recovered: no restore will apply it.",
    plants: ["restored-refusal-stays-recovered"],
    run() {
      const { s, ana, ben, cal, copy, first, second } = copied();
      s.remove(ben, "r1");
      s.send(ben);
      s.restoreCopy(cal, copy);
      s.send(cal);
      s.end();
      const notice = s.restored(cal);
      expect(notice?.misfit.join() === first && notice.applied.join() === second && !notice.conflicts.length, "the notice lists the first edit as refused by the room and the second as restored");
      expect(s.status(ana, first) === "kept-refused" && s.status(ana, second) === "saved", "Ana's tab shows the first as kept and refused, and the second as saved");
      expect(s.cell("r2", "c2") === "second", "the file holds the second edit");
    },
  },
  {
    name: "room-restore-before-a-coworker-edit",
    about: "Race with a normal edit, restore first. The room takes Ana's stored edits from Cal's restore, and Ben's edit in the same cell arrives after them. Ben's tab had not seen the restored value. The room applies his edit as the later write, as it does for any two normal edits.",
    plants: ["restore-skips-ledger"],
    run() {
      const { s, ben, cal, copy, first, second } = copied();
      s.restoreCopy(cal, copy);
      const theirs = s.type(ben, "r1", "c2", "coworker");
      s.send(cal);
      s.send(ben);
      s.end();
      expect(s.restored(cal)?.applied.join() === [first, second].join(), "the restore applied both stored edits");
      expect(s.cell("r1", "c2") === "coworker" && s.cell("r2", "c2") === "second" && s.status(ben, theirs) === "saved", "the coworker's later edit stands, and the other restored cell is kept");
    },
  },
  {
    name: "two-tabs-restore-the-same-copy",
    about: "Race with another restore. Cal and Ben restore from the same copy at the same time, and their offers reach the room in turn. The room applies each stored edit once. The second tab gets the answer that the ledger already counts the edit and that the sheet holds its value, and reports it as saved.",
    plants: ["restore-skips-ledger", "room-restore-trusts-the-tab"],
    run() {
      const { s, world, ben, cal, copy, first, second } = copied();
      s.restoreCopy(cal, copy);
      s.restoreCopy(ben, copy);
      s.send(cal, 0);
      s.send(ben, 0);
      s.send(ben, 0);
      s.send(cal, 0);
      expect(world.room.seq === 2, "the room holds two actions, one for each stored edit");
      s.end();
      const mine = s.restored(cal);
      const theirs = s.restored(ben);
      expect(mine?.applied.join() === first && mine.saved.join() === second && !mine.counted.length, "Cal's notice: the first edit restored by her, the second already saved");
      expect(theirs?.applied.join() === second && theirs.saved.join() === first && !theirs.counted.length, "Ben's notice: the reverse");
      expect(s.cell("r1", "c2") === "first" && s.cell("r2", "c2") === "second", "the file holds each edit once");
    },
  },
  {
    name: "room-restore-with-a-lost-save-answer",
    about: "Race with a lost save answer. The room takes the stored edits, Cal's tab saves, and the host's answer is lost. Cal's tab does not report the edits as restored. It reads the file, finds the save, and reports then.",
    plants: ["restore-notice-before-save"],
    run() {
      const { s, world, cal, copy, first, second } = copied();
      s.restoreCopy(cal, copy);
      s.send(cal);
      s.recv(cal);
      s.save(cal);
      s.host();
      s.deliver(0, true);
      expect(world.accepted > 0 && s.cell("r1", "c2") === "first" && !s.restored(cal), "the host holds the save, and the tab that got no answer reports nothing");
      s.end();
      expect(s.restored(cal)?.applied.join() === [first, second].join(), "after the tab reads the file, the notice lists both edits as restored");
    },
  },
  {
    name: "room-restore-across-a-room-loss",
    about: "Race with a room loss. The room takes the first stored edit from Cal's restore and is lost before a save. In the next room Cal's tab first offers the action it holds, then offers the copy again from its first edit. The new room answers that the ledger already counts the first edit and that the sheet holds its value, and applies the second. The file holds each edit once.",
    plants: ["restore-job-forgets", "restore-skips-ledger"],
    run() {
      const { s, world, ben, cal, copy, first, second } = copied();
      s.close(ben);
      s.restoreCopy(cal, copy);
      s.send(cal, 0);
      s.recv(cal);
      expect(world.room.seq === 1 && cal.job.at === 1, "the room took the first stored edit");
      s.loseRoom();
      s.answerAll();
      s.flow();
      s.end();
      const notice = s.restored(cal);
      expect(notice?.saved.join() === first && notice.applied.join() === second, "the notice comes from the new room: the first edit already saved, the second restored");
      expect(s.cell("r1", "c2") === "first" && s.cell("r2", "c2") === "second", "the file holds each edit once");
      expect(world.oracle.gens.get(world.room.gen).ids.filter((id) => id === first).length === 1, "the new room's history holds the first edit once");
    },
  },
  {
    name: "restore-judges-a-paste-as-a-whole",
    about: "The conflict rule on the pure restore. Ana's copy holds a paste into two cells and a later single edit. A coworker's saved value is in one cell of the paste. A restore leaves the whole paste for a person and writes neither cell. Her later edit is judged on its own and lands.",
    plants: ["conflict-per-cell", "restore-ignores-seen"],
    run() {
      const { s, world, ben, copy } = copied(true);
      const theirs = s.type(ben, "r1", "c2", "coworker");
      s.end();
      const file = s.file();
      const stored = readRecovery(world.host, copy);
      const { decisions, file: after, marks } = replay(file, stored);
      expect(decisions.map((one) => one.how).join() === "conflict,applied", "the paste is a conflict, and the later edit lands");
      expect(JSON.stringify(decisions[0].cells) === JSON.stringify([["r1", "c2", "coworker", "first"]]), "the conflict names the one cell that changed, with both values");
      expect(after.state.wb.rows.r2.cells.c2 === undefined && after.state.wb.rows.r1.cells.c2 === "coworker" && after.state.wb.rows.r3.cells.c2 === "second", "neither cell of the paste is written, and the later edit is");
      expect(marks.get(stored.edits[0].e) === "open" && marks.size === 1, "the restore returns a decision record that lists the paste as open");
      expect(s.status(ben, theirs) === "saved" && world.oracle.atEnd.conflict === 1 && world.oracle.atEnd.applied === 1, "the oracle counts one conflict and one applied edit");
    },
  },
  {
    name: "restore-holds-an-edit-behind-a-waiting-insert",
    about: "The dependency hold on the pure restore. Ana's copy holds an edit of her own, Ben's cell edit, Ben's row insert, and Cal's edit in Ben's new row. This scenario changes the stored copy by hand: it marks the insert as an edit that only a file's ledger counted, which a restore cannot judge, so the insert is left for a person. Cal's edit needs the row that the waiting insert creates. The restore holds it, and the ledger does not count it. Before this rule the restore counted it as refused, and it was lost when the row came back. Form 15 removed the common way into this state, a conflict of the insert's author earlier in the copy. The rule stays for every insert that still cannot be judged.",
    plants: ["restore-counts-a-waiting-row"],
    run() {
      const { s, world, copy, added } = mixed();
      const stored = readRecovery(world.host, copy);
      const edits = stored.edits.map((entry) => (entry.e === added ? { ...entry, out: "counted" } : entry));
      const { decisions, file: after } = replay(s.file(), { ...stored, edits });
      expect(decisions.map((one) => one.how).join() === "applied,conflict,unjudged,held", "Ana's edit applies, Ben's edit is a conflict, his insert cannot be judged, and Cal's edit is held");
      expect(decisions[3].behind === added, "the decision names the insert that Cal's edit waits for");
      expect(!after.state.wb.rows.n1 && !(stored.edits[3].c in after.state.seen), "the row is not there, and the ledger does not count Cal's request");
      s.end();
    },
  },
  {
    name: "decision-keep-is-counted",
    about: "A person's decision to keep the current value for a conflict that the ledger does not count yet. Ben's cell edit is his last edit in the copy, so no later edit moved the ledger past it. Dan decides to keep the coworker's value. The room counts Ben's request with a frame that writes nothing, so Ben's own tab cannot send the edit again later.",
    plants: ["decision-keep-not-counted"],
    run() {
      const { s, world, dan, copy, mine, typed, added, inside } = mixed(true);
      s.restoreCopy(dan, copy);
      s.settle();
      const before = s.restored(dan);
      expect(before?.applied.join() === [mine, added, inside].join() && before.conflicts.map((one) => one.e).join() === typed, "the notice: three edits restored, Ben's cell edit a conflict");
      s.decide(dan, before.job, [[typed, "keep"]]);
      s.end();
      const after = s.restored(dan);
      const info = world.oracle.gens.get(world.room.gen);
      expect(after.kept.join() === typed && info.declined[info.ids.indexOf(typed)] === true && verdict(world.host, typed)?.kind === "kept", "the room counts Ben's edit with a frame that writes nothing, and the decision record closes it as kept");
      expect(s.cell("r1", "c2") === "coworker" && (s.file().state.seen[readRecovery(world.host, copy).edits[2].c]?.[0] ?? 0) === 2, "the file keeps the coworker's value, and the ledger counts both of Ben's requests");
    },
  },
  {
    name: "room-restore-passes-a-conflict-and-a-keep-closes-it",
    about: "A conflict does not hold its author's later edits. Dan restores Ana's copy. The room applies Ana's edit, leaves Ben's cell edit as a conflict, and judges Ben's insert on its own: it lands, and Cal's edit lands in the new row. The ledger now counts Ben's conflicting edit, though nothing wrote it, and the decision record lists it as open. Dan then decides to keep the coworker's value. The room writes nothing and sends no frame, and Dan's tab closes the edit in the decision record. A later restore lists it as counted and not in the sheet.",
    plants: ["later-edit-held-anyway", "restore-ignores-record"],
    run() {
      const { s, world, ana, dan, copy, mine, typed, added, inside } = mixed();
      s.restoreCopy(dan, copy);
      s.settle();
      const before = s.restored(dan);
      expect(before?.applied.join() === [mine, added, inside].join() && JSON.stringify(before.conflicts) === JSON.stringify([{ e: typed, cells: [["r1", "c2", "coworker", "ben"]] }]) && !before.left.length && !before.held.length, "the notice: Ana's edit, Ben's insert and Cal's edit restored, Ben's cell edit a conflict");
      expect(s.cell("n1", "c2") === "cal" && verdict(world.host, typed)?.kind === "open", "the file holds Cal's value in the new row, and the decision record lists Ben's edit as open");
      const frames = world.room.seq;
      s.decide(dan, before.job, [[typed, "keep"]]);
      s.settle();
      const after = s.restored(dan);
      expect(after.job !== before.job && after.kept.join() === typed && after.saved.join() === [mine, added, inside].join() && world.room.seq === frames, "the second notice: Ben's edit kept by the decision, the others saved, and no new frame in the room");
      expect(verdict(world.host, typed)?.kind === "kept", "the decision record closes Ben's edit as kept");
      s.restoreCopy(ana, copy);
      s.end();
      expect(s.restored(ana).counted.join() === typed && !s.restored(ana).conflicts.length, "a later restore lists Ben's edit as counted and not in the sheet");
      expect(s.cell("r1", "c2") === "coworker", "the file keeps the coworker's value");
    },
  },
  {
    name: "restore-keeps-the-order-of-edits-on-one-cell",
    about: "The dependency hold for a cell. Ana's copy holds Ben's paste into two cells and Cal's later edit of the second cell. Cal typed before her tab showed the paste, so she saw the second cell empty. A coworker's saved value in the first cell makes the paste a conflict. Cal's edit writes a cell that the waiting paste writes, so it waits behind the paste. Dan takes the copy's value for the paste. The paste lands, and Cal's edit is then a conflict of its own, because the cell holds Ben's value, which she never saw. Dan takes it too, and the second cell ends with Cal's value, as in the room. Without this rule Cal's edit would land first, because the cell is empty as she saw it, and Ben's paste would land on top of it after the decision.",
    plants: ["restore-out-of-order"],
    run() {
      const { s, world, tabs } = stage(3);
      const [ana, ben, cal] = tabs;
      const mine = s.type(ana, "r3", "c2", "ana");
      s.send(ana);
      const pasted = s.paste(ben, PAIR);
      s.send(ben);
      const typed = s.type(cal, "r2", "c2", "cal");
      s.send(cal);
      s.flow();
      s.close(ben);
      s.close(cal);
      s.offline(ana);
      s.loseRoom();
      s.restore(0);
      s.online(ana);
      s.answerAll();
      s.flow();
      const copy = ana.edits.get(mine).copy;
      expect(readRecovery(world.host, copy)?.edits.map((entry) => entry.e).join() === [mine, pasted, typed].join(), "Ana's tab stores the three edits in the room's order");
      const dan = s.join();
      s.answerAll();
      s.type(dan, "r1", "c2", "coworker");
      s.settle();
      const { decisions } = replay(s.file(), readRecovery(world.host, copy));
      expect(decisions.map((one) => one.how).join() === "applied,conflict,held" && decisions[2].behind === pasted, "the pure restore: Ana's edit applies, Ben's paste is a conflict, and Cal's edit is held behind it");
      s.restoreCopy(dan, copy);
      s.settle();
      const before = s.restored(dan);
      expect(JSON.stringify(before?.held) === JSON.stringify([{ e: typed, behind: pasted }]) && before.conflicts.length === 1 && !before.left.length, "Dan's notice: one conflict, and Cal's edit held behind it");
      s.decide(dan, before.job, [[pasted, "take"]]);
      s.settle();
      const between = s.restored(dan);
      expect(between.applied.join() === pasted && JSON.stringify(between.conflicts) === JSON.stringify([{ e: typed, cells: [["r2", "c2", "also", "cal"]] }]), "after the decision the paste is restored, and Cal's edit is a conflict that shows Ben's value");
      s.decide(dan, between.job, [[typed, "take"]]);
      s.end();
      expect(s.restored(dan).applied.join() === typed, "after the second decision Cal's edit is restored");
      expect(s.cell("r1", "c2") === "first" && s.cell("r2", "c2") === "cal", "the file holds Ben's first value and Cal's value in the second cell, as in the room");
    },
  },
  {
    name: "room-restore-answers-a-resent-offer-once",
    about: "A restore and a dropped connection. Cal's connection drops while the offer for Ana's first stored edit waits to be sent, and her tab queues the offer again when it is back. Both offers reach the room. The room judges the edit once, as a conflict, and answers the second offer with the same answer, so its memory of the job moves once. Her second edit lands.",
    plants: ["restore-judges-a-resent-offer-again"],
    run() {
      const { s, world, ben, cal, copy, first, second } = copied();
      s.type(ben, "r1", "c2", "coworker");
      s.settle();
      s.restoreCopy(cal, copy);
      s.offline(cal);
      s.online(cal);
      expect(cal.out.filter((frame) => frame.k === "copy" && frame.i === 0).length === 2, "the offer for the first stored edit is queued twice");
      s.end();
      const notice = s.restored(cal);
      expect(JSON.stringify(notice?.conflicts) === JSON.stringify([{ e: first, cells: [["r1", "c2", "coworker", "first"]] }]) && !notice.held.length && notice.applied.join() === second, "Cal's notice shows the conflict, with nothing held, and the second edit restored");
      expect(world.oracle.roomJudged.conflict === 1, "the room judged the first stored edit once and answered the second offer from its memory");
    },
  },
  {
    name: "an-answered-offer-leaves-nothing-staged",
    about: "A large stored paste and a dropped connection. Ana's copy holds a paste that travels in two parts. Cal's connection drops while the offer waits, so her tab queues both parts again. The parts arrive out of order: the room has the first part, takes its duplicate, and answers when the second part arrives. The answer is a conflict, so the ledger does not move. Cal's tab stops sending the rest of that offer. A tab that sent it would leave half of a second copy of the offer in the room, which the room keeps as the next request of its author and never frees.",
    plants: ["restore-sends-an-answered-offer"],
    run() {
      const { s, world, ben, cal, copy, first } = copied(wide(4, "w"));
      s.type(ben, "r1", "k0", "coworker");
      s.settle();
      s.restoreCopy(cal, copy);
      s.offline(cal);
      s.online(cal);
      const parts = () => cal.out.filter((frame) => frame.k === "part" && frame.of === "copy").map((frame) => frame.i);
      expect(parts().join() === "0,1,0,1", "both parts of the offer are queued twice");
      s.send(cal, 0);
      s.send(cal, 1);
      expect(world.room.staging.size === 1 && parts().join() === "1,1", "the room stages the first part and takes its duplicate");
      s.send(cal, 0);
      expect(world.oracle.roomJudged.conflict === 1, "the second part completes the offer, and the room answers with a conflict");
      s.send(cal);
      expect(world.room.staging.size === 0 && world.room.bytes.staged === 0, "the room holds no part of the answered offer");
      s.end();
      expect(s.restored(cal)?.conflicts[0]?.e === first && s.cell("r1", "k0") === "coworker", "Cal's notice shows the conflict, and the file keeps the coworker's value");
    },
  },
  {
    name: "second-restore-reports-saved-and-counted",
    about: "Notice outcomes. Ben deletes the row of Ana's first stored edit. Cal restores the copy: the room counts the first edit and refuses it, and applies the second. Ben then restores the same copy. The ledger counts both edits. His notice lists the second as saved, because the sheet holds its value, and the first as counted and not in the sheet.",
    plants: ["notice-counted-as-saved"],
    run() {
      const { s, ben, cal, copy, first, second } = copied();
      s.remove(ben, "r1");
      s.send(ben);
      s.restoreCopy(cal, copy);
      s.settle();
      expect(s.restored(cal)?.misfit.join() === first && s.restored(cal).applied.join() === second, "Cal's restore: the first edit refused by the room, the second restored");
      s.restoreCopy(ben, copy);
      s.end();
      const notice = s.restored(ben);
      expect(notice?.saved.join() === second && notice.counted.join() === first && !notice.applied.length && !notice.replaced.length, "Ben's notice: the second edit saved, the first counted and not in the sheet");
    },
  },
  {
    name: "restore-after-a-version-restore-reports-removed",
    about: "Notice outcomes. Cal restores Ana's copy, and both edits are saved. A version restore then puts back the version from before Cal's restore. The new ledger still counts both requests. Ben restores the same copy, and his notice lists both edits as removed by a version restore: the room checks the cut record before the ledger.",
    plants: ["ledger-before-cut"],
    run() {
      const { s, world, ben, cal, copy, first, second } = copied();
      const before = world.host.versions.length - 1;
      s.restoreCopy(cal, copy);
      s.settle();
      expect(s.cell("r1", "c2") === "first" && s.cell("r2", "c2") === "second", "the file holds both restored edits");
      s.restore(before);
      s.answerAll();
      s.flow();
      expect(s.cell("r1", "c2") === undefined, "the version restore removed them");
      s.restoreCopy(ben, copy);
      s.end();
      const notice = s.restored(ben);
      expect(notice?.replaced.join() === [first, second].join() && !notice.counted.length && !notice.saved.length, "Ben's notice lists both as removed by a version restore");
    },
  },
  {
    name: "decision-take-writes-the-copy-value",
    about: "A person's decision to take the copy's value. Cal's notice shows Ana's second edit as a conflict with the coworker's value. Cal decides to take the copy's value. The cell still holds the value Cal reviewed, so the room writes Ana's value and counts her request. The notice comes after the save.",
    plants: ["restore-notice-before-save"],
    run() {
      const { s, ana, cal, job, first, second, clash, other } = conflicted();
      s.decide(cal, job, [[clash, "take"]]);
      s.send(cal);
      expect(s.restored(cal).job === job, "Cal's tab reports nothing while no save holds the decision");
      s.end();
      const notice = s.restored(cal);
      expect(notice.job !== job && notice.applied.join() === clash && notice.saved.join() === other && JSON.stringify(notice.decided) === JSON.stringify([[clash, "take"]]), "the notice lists the edit as restored, the other as saved, and names the decision");
      expect(s.cell("r1", "c2") === "first" && s.cell("r2", "c2") === "second", "the file holds Ana's values");
      expect(s.status(ana, first) === "saved" && s.status(ana, second) === "saved", "Ana's tab shows both as saved");
    },
  },
  {
    name: "decision-take-races-a-live-edit",
    about: "A decision races a live edit. Cal reviewed the coworker's value and decides to take the copy's value. Before the decision reaches the room, Ben types a newer value into the cell. The room finds a value that Cal did not review, writes nothing, and answers with a new conflict that shows the newer value.",
    plants: ["decision-take-unchecked"],
    run() {
      const { s, ben, cal, job, clash, other, row, value } = conflicted();
      s.decide(cal, job, [[clash, "take"]]);
      const newest = s.type(ben, row, "c2", "newest");
      s.send(ben);
      s.send(cal);
      s.end();
      const notice = s.restored(cal);
      expect(JSON.stringify(notice.conflicts) === JSON.stringify([{ e: clash, cells: [[row, "c2", "newest", value]] }]) && notice.saved.join() === other && !notice.applied.length, "the second notice shows a new conflict with the newer value");
      expect(s.cell(row, "c2") === "newest" && s.status(ben, newest) === "saved", "the file keeps the newer value");
    },
  },
  {
    name: "two-tabs-decide-on-the-same-conflict",
    about: "A duplicate decision. Cal and Ben both restored the copy and both see the conflict. Cal decides to keep the current value, and Ben decides to take the copy's value. Cal's decision reaches the room first and is counted. The room's own history now holds the edit, so the room answers Ben's decision by the ledger, though the decision record still lists the edit as open. Ben's decision changes nothing, and his notice lists the edit as counted and not in the sheet.",
    plants: ["decision-applies-twice", "kept-edit-shown-as-saved"],
    run() {
      const { s, world, ana, ben, cal, copy, job, clash, other, row } = conflicted();
      s.restoreCopy(ben, copy);
      s.settle();
      const seen = s.restored(ben);
      expect(seen?.conflicts.length === 1, "Ben's notice shows the same conflict");
      s.decide(cal, job, [[clash, "keep"]]);
      s.decide(ben, seen.job, [[clash, "take"]]);
      s.send(cal, 0);
      s.send(ben, 0);
      s.send(cal, 0);
      s.send(ben, 0);
      s.end();
      expect(s.restored(cal).kept.join() === clash && s.restored(cal).saved.join() === other, "Cal's notice: the edit counted with the current value kept, the other saved");
      expect(s.restored(ben).counted.join() === clash && s.restored(ben).saved.join() === other && !s.restored(ben).applied.length, "Ben's notice: the edit already counted and not in the sheet, the other saved");
      expect(s.cell(row, "c2") === "coworker", "the file keeps the coworker's value");
      expect(world.oracle.gens.get(world.room.gen).ids.filter((id) => id === clash).length === 1 && !world.oracle.takeOf.size, "the room's history holds the edit once, and no tab wrote it as an edit of its own");
      expect(s.status(ana, clash) === "kept-refused" && verdict(world.host, clash)?.kind === "kept", "Ana's tab saw the decision and shows her edit as kept and refused, and the decision record closes it as kept");
    },
  },
  {
    name: "decision-with-a-lost-save-answer",
    about: "A decision and a lost save answer. Cal decides to keep the current value. The room counts the edit, Cal's tab saves, and the host's answer is lost. Cal's tab does not report the decision. It reads the file, finds the save, and reports then. The copy stays on the host the whole time.",
    plants: ["restore-notice-before-save"],
    run() {
      const { s, world, cal, copy, job, clash, other, row } = conflicted();
      s.decide(cal, job, [[clash, "keep"]]);
      s.send(cal);
      s.recv(cal);
      s.save(cal);
      s.host();
      s.deliver(0, true);
      expect(s.restored(cal).job === job && cal.job, "the host holds the save, and the tab that got no answer reports nothing");
      s.end();
      expect(s.restored(cal).kept.join() === clash && s.restored(cal).saved.join() === other, "after the tab reads the file, the notice lists the decision");
      expect(readRecovery(world.host, copy)?.edits.length === 2 && s.cell(row, "c2") === "coworker", "the host still holds the copy, and the file keeps the coworker's value");
    },
  },
  {
    name: "decision-across-a-room-loss",
    about: "A decision and a room loss. Cal decides to keep the current value. The room counts the edit and is lost before a save. In the next room Cal's tab first offers the frame it holds, with the mark that it writes nothing, then offers the copy again. The new room counts the edit once and writes nothing for it. Its history holds the edit, so it answers by the ledger, and Cal's tab closes the edit in the decision record as kept.",
    plants: ["adopt-drops-keep"],
    run() {
      const { s, world, ana, cal, job, clash, other, row } = conflicted();
      s.decide(cal, job, [[clash, "keep"]]);
      s.send(cal, 0);
      s.send(cal, 0);
      s.recv(cal);
      expect(world.room.log.at(-1).keep === true && world.room.state.wb.rows[row].cells.c2 === "coworker", "the room counted the edit and wrote nothing");
      s.loseRoom();
      s.answerAll();
      s.flow();
      s.end();
      const notice = s.restored(cal);
      expect(notice.counted.join() === clash && notice.saved.join() === other, "the notice comes from the new room: the edit already counted, the other saved");
      expect(s.cell(row, "c2") === "coworker" && verdict(world.host, clash)?.kind === "kept", "the file keeps the coworker's value, and the decision record closes the edit as kept");
      expect(world.oracle.gens.get(world.room.gen).ids.filter((id) => id === clash).length === 1 && s.status(ana, clash) === "kept-refused", "the new room's history holds the edit once, and Ana's tab shows it as kept and refused");
    },
  },
  {
    name: "room-restore-passes-a-conflict-across-a-room-loss",
    about: "A conflict, a later edit of its author, and a room loss. Cal restores Ana's copy. The room leaves her first edit as a conflict and applies her second, and the room is lost before a save. Cal's tab offers the frame it holds to the next room, then offers the copy again. The ledger of the new room counts both requests. The decision record lists the first edit as open, so the new room shows it as a conflict again, and the second edit is in the sheet.",
    plants: ["restore-ignores-record"],
    run() {
      const { s, world, ana, ben, cal, copy, first, second } = copied();
      s.type(ben, "r1", "c2", "coworker");
      s.settle();
      s.restoreCopy(cal, copy);
      s.send(cal);
      s.recv(cal);
      expect(world.room.state.wb.rows.r2.cells.c2 === "second" && s.cell("r2", "c2") === undefined, "the room holds the second edit, and no file does yet");
      s.loseRoom();
      s.answerAll();
      s.flow();
      s.end();
      const notice = s.restored(cal);
      expect(JSON.stringify(notice.conflicts) === JSON.stringify([{ e: first, cells: [["r1", "c2", "coworker", "first"]] }]) && notice.saved.join() === second && !notice.counted.length, "the notice from the new room: the first edit still a conflict, the second in the sheet");
      expect(s.cell("r1", "c2") === "coworker" && s.cell("r2", "c2") === "second", "the file keeps the coworker's value and holds the second edit");
      expect(s.status(ana, first) === "recovered", "Ana's tab shows the first edit as stored in a recovery copy");
    },
  },
  {
    name: "passed-conflict-stays-open-after-its-restorer-leaves",
    about: "The decision record. Sam typed two edits and went offline, and the room was lost. Dana's tab held his edits and stored them. Tom then changed the cell of Sam's first edit. Dana restores the copy: the first edit is a conflict, and the second lands, so the ledger counts both of Sam's requests. Dana closes her tab without deciding. The decision record still lists the first edit as open. Tom restores the copy, and his notice shows the conflict again, not a counted edit. Sam's tab comes back and shows the first edit as stored in a recovery copy, with a notice, and the second as saved.",
    plants: ["pass-without-record", "restore-ignores-record", "label-ignores-record"],
    run() {
      const { s, world, sam, dana, tom, copy, first, second } = away();
      s.restoreCopy(dana, copy);
      s.calm();
      const notice = s.restored(dana);
      const line = [{ e: first, cells: [["r1", "c2", "coworker", "first"]] }];
      expect(JSON.stringify(notice?.conflicts) === JSON.stringify(line) && notice.applied.join() === second, "Dana's notice: Sam's first edit is a conflict, and his second edit is restored");
      expect(verdict(world.host, first)?.kind === "open" && s.file().state.seen[sam.client]?.[0] === 2, "the ledger counts both requests, and the decision record lists the first edit as open");
      s.close(dana);
      s.restoreCopy(tom, copy);
      s.calm();
      const again = s.restored(tom);
      expect(JSON.stringify(again?.conflicts) === JSON.stringify(line) && again.saved.join() === second && !again.counted.length, "Tom's restore shows the first edit as a conflict to decide, and the second as saved");
      s.online(sam);
      s.end();
      expect(s.status(sam, first) === "recovered" && s.status(sam, second) === "saved", "Sam's tab shows the first edit as stored in a recovery copy and the second as saved");
      expect(sam.notices.some((one) => one.kind === "passed" && one.copy === copy && one.edits.join() === first && one.decided === "open"), "Sam's tab tells him that the first edit waits for a decision");
      expect(s.cell("r1", "c2") === "coworker" && s.cell("r2", "c2") === "second", "the file keeps Tom's value and holds Sam's second edit");
    },
  },
  {
    name: "late-take-is-an-edit-of-the-deciding-tab",
    about: "A person's decision to take the copy's value for an edit that a restore passed over. The ledger already counts Sam's first edit, so a frame with his request would be a duplicate. Dana's tab makes the edit as a request of its own, with the values Dana reviewed, and the room checks those values again when it orders the request. Tom types a newer value before the request arrives: the room counts the request and writes nothing, and Dana's notice shows the conflict again with the newer value. Dana decides again, and this time the value lands. The decision record closes the edit as taken, and Sam's tab shows it as saved.",
    plants: ["late-take-unchecked"],
    run() {
      const { s, world, sam, dana, tom, copy, first, second } = away();
      s.restoreCopy(dana, copy);
      s.calm();
      const before = s.restored(dana);
      s.decide(dana, before.job, [[first, "take"]]);
      s.send(dana, 0);
      expect(dana.pending.some((request) => request.take?.[2] === first), "the room answers that Dana's tab may take the edit, and the tab queues a request of its own");
      const newest = s.type(tom, "r1", "c2", "newest");
      s.send(tom);
      s.calm();
      const between = s.restored(dana);
      expect(JSON.stringify(between.conflicts) === JSON.stringify([{ e: first, cells: [["r1", "c2", "newest", "first"]] }]) && s.cell("r1", "c2") === "newest", "the room wrote nothing over the newer value, and the notice shows the conflict again");
      s.decide(dana, between.job, [[first, "take"]]);
      s.calm();
      const after = s.restored(dana);
      expect(after.applied.join() === first && after.saved.join() === second && s.cell("r1", "c2") === "first", "after the second decision the value is in the sheet");
      expect(verdict(world.host, first)?.kind === "taken" && s.file().state.seen[sam.client]?.[0] === 2, "the decision record closes the edit as taken, and the ledger count of Sam's client did not move");
      s.online(sam);
      s.end();
      expect(s.status(sam, first) === "saved" && s.status(tom, newest) === "saved", "Sam's tab shows the edit as saved");
    },
  },
  {
    name: "late-keep-closes-the-edit-for-everyone",
    about: "A person's decision to keep the current value for an edit that a restore passed over. Dana decides to keep Tom's value. No frame is needed, because the ledger already counts Sam's request: Dana's tab closes the edit in the decision record. Tom then decides to take the copy's value from the notice he still has. The decision record lists the edit as closed, so his decision changes nothing. Sam's tab comes back and shows the edit as kept and refused, with a notice that holds it.",
    plants: ["label-ignores-record"],
    run() {
      const { s, world, sam, dana, tom, copy, first, second } = away();
      s.restoreCopy(dana, copy);
      s.calm();
      s.restoreCopy(tom, copy);
      s.calm();
      const mine = s.restored(dana);
      const theirs = s.restored(tom);
      expect(mine?.conflicts.length === 1 && theirs?.conflicts.length === 1, "both notices show the conflict");
      s.decide(dana, mine.job, [[first, "keep"]]);
      s.calm();
      expect(s.restored(dana).kept.join() === first && verdict(world.host, first)?.kind === "kept", "Dana's notice lists the edit as kept, and the decision record closes it");
      s.decide(tom, theirs.job, [[first, "take"]]);
      s.calm();
      expect(s.restored(tom).counted.join() === first && !s.restored(tom).applied.length && s.cell("r1", "c2") === "coworker", "Tom's later decision changes nothing, and the file keeps his value");
      s.online(sam);
      s.end();
      expect(s.status(sam, first) === "kept-refused" && s.status(sam, second) === "saved", "Sam's tab shows the first edit as kept and refused");
      expect(sam.notices.some((one) => one.kind === "passed" && one.edits.join() === first && one.decided === "kept" && one.actions[first]), "Sam's tab tells him that a person kept the current value, and the notice holds his edit");
    },
  },
  {
    name: "two-tabs-take-the-same-passed-edit",
    about: "A duplicate decision on an edit that a restore passed over. Dana and Tom both decide to take the copy's value, and the room answers both before either tab's request arrives. Dana's request lands. The room then finds a value in the cell that Tom did not review, so it counts his request and writes nothing. His tab offers the edit again: the sheet holds its value now, so his notice lists it as saved. The value is written once.",
    plants: ["late-take-unchecked"],
    run() {
      const { s, world, dana, tom, copy, first, second } = away();
      s.restoreCopy(dana, copy);
      s.calm();
      s.restoreCopy(tom, copy);
      s.calm();
      s.decide(dana, s.restored(dana).job, [[first, "take"]]);
      s.decide(tom, s.restored(tom).job, [[first, "take"]]);
      s.send(dana, 0);
      s.send(tom, 0);
      expect(dana.pending.length === 1 && tom.pending.length === 1, "both tabs queue a request of their own");
      s.send(dana);
      s.end();
      expect(s.restored(dana).applied.join() === first && s.restored(tom).saved.join() === [first, second].join() && !s.restored(tom).applied.length, "Dana's notice lists the edit as restored, and Tom's lists it as saved");
      const info = world.oracle.gens.get(world.room.gen);
      const takes = [...world.oracle.takeOf].filter(([, took]) => took.e === first).map(([id]) => id);
      expect(takes.length === 2 && takes.filter((id) => info.result.get(id) === true).length === 1 && s.cell("r1", "c2") === "first", "two requests were made, and one of them wrote the value");
    },
  },
  {
    name: "keep-after-a-take-changes-nothing",
    about: "A decision to keep after another person's decision to take. Dana takes the copy's value for an edit that a restore passed over, and it lands. Tom then decides to keep the value he saw, from the notice he still has. The sheet holds the edit's value, so the room answers that it is saved, and nothing is undone.",
    plants: ["decision-applies-twice", "restore-ignores-record"],
    run() {
      const { s, world, dana, tom, copy, first, second } = away();
      s.restoreCopy(dana, copy);
      s.calm();
      s.restoreCopy(tom, copy);
      s.calm();
      const theirs = s.restored(tom);
      s.decide(dana, s.restored(dana).job, [[first, "take"]]);
      s.calm();
      expect(s.cell("r1", "c2") === "first" && verdict(world.host, first)?.kind === "taken", "Dana's decision put the value in the sheet");
      s.decide(tom, theirs.job, [[first, "keep"]]);
      s.end();
      expect(s.restored(tom).saved.join() === [first, second].join() && !s.restored(tom).kept.length && s.cell("r1", "c2") === "first", "Tom's notice lists the edit as saved, and the value stays");
    },
  },
  {
    name: "restored-edit-waits-for-its-row",
    about: "The rule for a missing row that may come back. A replay of 48 moves shrunk from fuzz seed 5378006 (gate r4a), then a check of what each person sees. Tom (t3) added row n5, and Sam (t5) typed into it while his tab was away from the room; the room was lost before a save, so the file has no row n5, and Sam's tab stored his edit in recovery copy r1. Dana (t1) restores the copy before Tom's insert is back. The row is missing, and Sam saw room frames that the file does not hold, so the restore does not refuse the edit: it waits for its row. It waits quietly, as David decided (rule 106): Dana's notice lists it with the edits that stay in the copy, with no row and no waiting entry, the decision record lists it as open, and Sam's tab shows no notice about a wait. Tom's insert then lands, and the row is back, empty. Dana restores the copy again, Sam's value lands in the row, and his tab shows it saved.",
    plants: ["restore-refuses-a-row-that-may-return", "waiting-edit-shown", "copy-forgets-unsaved-inserts"],
    run() {
      usePlant(armed);
      const { seed, mode, profile, moves } = WITNESSES.find((one) => one.seed === 5378006);
      const world = replayMoves(moves, { mode, profile, seed });
      const [dana, sam] = ["t1", "t5"].map((id) => world.tabs.find((tab) => tab.id === id));
      const id = "t5.1:1";
      const notice = dana.notices.findLast((one) => one.kind === "restored" && one.copy === "r1");
      expect(notice?.left.includes(id) && !notice.held.length && !notice.refused.length && !notice.misfit.length, "Dana's notice lists Sam's edit with the edits that stay in the copy, with no waiting entry, and not as refused");
      expect(JSON.stringify(verdict(world.host, id)) === JSON.stringify({ copy: "r1", e: id, kind: "open" }), "the decision record lists the edit as open, with no row");
      const row = get(world.host).state.wb.rows.n5;
      expect(row && row.cells.c1 === undefined, "Tom's insert is back, and the row is empty");
      read(world, sam);
      quiesce(world);
      expect(sam.edits.get(id).state === "recovered" && !sam.notices.some((one) => one.kind === "waiting" || one.row), "Sam's tab shows the edit as stored in the copy, and no notice about a wait");
      restoreFromCopy(world, dana, "r1");
      quiesce(world);
      expect(dana.notices.findLast((one) => one.kind === "restored")?.applied.includes(id) && get(world.host).state.wb.rows.n5.cells.c1 === "v4" && sam.edits.get(id).state === "saved", "a later restore applies the edit to its row, and Sam's tab shows it saved");
    },
  },
  {
    name: "waiting-edit-becomes-late-when-its-authors-later-edit-lands",
    about: "The rule for a missing row, when the author's later edit lands (rule 84). The moves of witness 5378006 with one more: right after Sam (t5) types into Tom's new row n5, he types into row r4 too. Both edits go into recovery copy r1. Dana (t1) restores the copy before Tom's insert is back: Sam's first edit waits for its row, and his second lands, so the file's ledger counts both of his requests. Tom's insert then lands, and the row is back, empty. Dana restores the copy again. The first edit is open in the record and counted by the ledger, so it is late: the restore shows it as a conflict line, the empty cell next to Sam's value, and does not write it, because the ledger cannot tell a passed edit from one that Sam's own tab wrote in between. Dana takes it, and Sam's value lands.",
    plants: ["late-edit-written-by-itself"],
    run() {
      usePlant(armed);
      const { seed, mode, profile, moves } = WITNESSES.find((one) => one.seed === 5378006);
      const world = replayMoves([...moves.slice(0, 45), ["value", 2027808452], ...moves.slice(45)], { mode, profile, seed });
      const [dana, sam] = ["t1", "t5"].map((id) => world.tabs.find((tab) => tab.id === id));
      const [waiting, later] = ["t5.1:1", "t5.1:2"];
      const first = dana.notices.findLast((one) => one.kind === "restored" && one.copy === "r1");
      expect(first?.left.includes(waiting) && !first.held.length && first.applied.includes(later), "Dana's first restore: Sam's edit waits quietly for row n5, and his later edit lands");
      expect(get(world.host).state.seen["t5.1"]?.[0] === 2 && verdict(world.host, waiting)?.kind === "open", "the ledger counts both of Sam's requests, and the record lists the waiting edit as open");
      const row = get(world.host).state.wb.rows.n5;
      expect(row && row.cells.c1 === undefined && get(world.host).state.wb.rows.r4.cells.c3 === "v5", "Tom's row is back and empty, and Sam's later value is saved");
      restoreFromCopy(world, dana, "r1");
      quiesce(world);
      const again = dana.notices.findLast((one) => one.kind === "restored");
      expect(JSON.stringify(again.conflicts) === JSON.stringify([{ e: waiting, cells: [["n5", "c1", "", "v4"]] }]) && !again.applied.length, "the second restore shows the late edit as a conflict line next to the empty cell");
      expect(get(world.host).state.wb.rows.n5.cells.c1 === undefined && sam.edits.get(waiting).state === "recovered", "no restore writes it by itself, and Sam's tab still shows it stored in the copy");
      decideConflicts(world, dana, again.job, [[waiting, "take"]]);
      quiesce(world);
      expect(get(world.host).state.wb.rows.n5.cells.c1 === "v4" && sam.edits.get(waiting).state === "saved", "Dana takes it, Sam's value lands in the row, and his tab shows it saved");
    },
  },
  {
    name: "restored-delete-removes-a-value-filled-later",
    about: "Form 15's rule for a row delete. Ana deleted a row whose one filled cell she saw. After her delete was stored, Ben filled another cell of that row. The delete does not conflict, because every cell Ana saw is unchanged. The restore applies it, and Ben's value goes with the row. The notice of the restore names the delete and the value it removed, and Ben's own tab gets a notice too, so the person who filled the cell can see that a restored delete removed it.",
    plants: ["restored-delete-hides-removed-values"],
    run() {
      const { s, world, ben, cal, copy, gone, second } = deleted();
      const late = s.type(ben, "r1", "c2", "late");
      s.settle();
      const { decisions } = replay(s.file(), readRecovery(world.host, copy));
      expect(decisions.map((one) => one.how).join() === "applied,applied" && JSON.stringify(decisions[0].removed) === JSON.stringify([["r1", "c2", "late"]]), "the pure restore applies the delete and lists the value it removes");
      s.restoreCopy(cal, copy);
      s.end();
      const notice = s.restored(cal);
      expect(notice.applied.join() === [gone, second].join() && JSON.stringify(notice.removed) === JSON.stringify([{ e: gone, cells: [["r1", "c2", "late"]] }]), "the notice lists the delete as restored and names the value it removed");
      expect(ben.notices.some((one) => one.kind === "removed" && one.copy === copy && one.by === gone && JSON.stringify(one.cells) === JSON.stringify([["r1", "c2", "late"]])), "Ben's tab tells him that a restored delete removed his value");
      expect(!s.file().state.wb.rows.r1 && s.status(ben, late) === "saved", "the row is gone, and Ben's edit stays a saved edit that a later delete removed");
    },
  },
  {
    name: "restored-delete-conflicts-when-a-seen-cell-changed",
    about: "Form 15's rule for a row delete. Ana deleted a row whose one filled cell she saw. Ben then changed that cell. The delete is a conflict that shows Ben's value, and the row stays. Ana's later edit of another row lands.",
    plants: ["delete-ignores-a-changed-seen-cell"],
    run() {
      const { s, world, ben, cal, copy, gone, second } = deleted();
      s.type(ben, "r1", "c1", "changed");
      s.settle();
      const line = [["r1", "c1", "changed", ""]];
      const { decisions } = replay(s.file(), readRecovery(world.host, copy));
      expect(decisions.map((one) => one.how).join() === "conflict,applied" && JSON.stringify(decisions[0].cells) === JSON.stringify(line), "the pure restore leaves the delete as a conflict that shows the changed cell");
      s.restoreCopy(cal, copy);
      s.end();
      const notice = s.restored(cal);
      expect(JSON.stringify(notice.conflicts) === JSON.stringify([{ e: gone, cells: line }]) && notice.applied.join() === second && !notice.removed.length, "the notice shows the delete as a conflict, and the later edit restored");
      expect(s.cell("r1", "c1") === "changed", "the row stays, with Ben's value");
    },
  },
  {
    name: "second-replay-is-checked-like-the-first",
    about: "The oracle folds a second restore of the same copy on its own, as it does the first. Ana's copy holds her own edit, Ben's insert, Ben's conflicting cell edit and Cal's edit. The first restore applies three of them. A second restore finds those counted, and must still leave Ben's cell edit as a conflict.",
    plants: ["again-ignores-seen"],
    run() {
      const { s, world } = mixed(true);
      s.end();
      expect(world.oracle.atEnd.applied === 3 && world.oracle.atEnd.conflict === 1 && world.oracle.atEnd.again === 0, "the end check applies three edits, finds one conflict, and a second restore takes nothing");
      expect(s.cell("r1", "c2") === "coworker", "the file keeps the coworker's value");
    },
  },
  {
    name: "requests-leave-in-order",
    about: "A tab that typed two edits while offline sends them in order. The ledger passes over a request only when a room refused it.",
    plants: ["skips-an-open-request"],
    run() {
      const { s, tabs } = stage();
      const [ana] = tabs;
      s.offline(ana);
      const one = s.type(ana, "r1", "c2", "one");
      const two = s.type(ana, "r2", "c2", "two");
      s.online(ana);
      s.end();
      expect(s.status(ana, one) === "saved" && s.status(ana, two) === "saved" && s.cell("r1", "c2") === "one" && s.cell("r2", "c2") === "two", "both edits are saved");
    },
  },
  {
    name: "waiting-edit-stops-waiting-after-the-next-room",
    about: "David's rule for the row wait (rule 106): it never waits forever. The moves of witness 5378006, steered by hand after them. Tom (t3) added row n5 and Sam (t5) typed into it while away; the room was lost before a save, and Sam's edit is in recovery copy r1. Dana (t1) restores the copy in the room that follows the lost room, while every other tab is away: Sam's edit waits quietly. That room is lost too, and Dana's tab opens and saves the next one. Tom's tab is still away, so the row is not back. Dana restores the copy again: the room that could bring the row back has closed and a save came after it, so the wait is over. The restore answers that the edit does not fit, the decision record closes it, and it stays in the copy. When Tom's tab returns, his row comes back empty, and no restore writes Sam's value into it by itself.",
    plants: ["edit-waits-for-its-row-forever", "row-wait-ends-a-room-early"],
    run() {
      usePlant(armed);
      const { seed, mode, profile, moves } = WITNESSES.find((one) => one.seed === 5378006);
      const world = startSeed({ mode, profile, seed });
      for (const [name, sub] of moves) {
        world.rnd = rng(sub);
        MOVES[name](world, world.rnd);
        checkStep(world);
      }
      const [dana, sam] = ["t1", "t5"].map((id) => world.tabs.find((tab) => tab.id === id));
      const id = "t5.1:1";
      for (const tab of world.tabs) if (tab.alive && tab.connected && tab !== dana) setConnected(world, tab, false);
      settle(world, false);
      checkStep(world);
      const first = dana.notices.findLast((one) => one.kind === "restored" && one.copy === "r1");
      expect(first?.left.includes(id) && !first.misfit.length && verdict(world.host, id)?.kind === "open", "in the room that follows the lost room, Sam's edit waits quietly, and the record lists it as open");
      roomLoss(world);
      settle(world, false);
      checkStep(world);
      restoreFromCopy(world, dana, "r1");
      settle(world, false);
      checkStep(world);
      const second = dana.notices.findLast((one) => one.kind === "restored");
      expect(second !== first && second.misfit.includes(id) && !second.left.includes(id) && verdict(world.host, id)?.kind === "misfit", "after that room closed and a save came, the next restore stops the wait: the edit does not fit, and the record closes it");
      quiesce(world);
      const row = get(world.host).state.wb.rows.n5;
      expect(row && row.cells.c1 === undefined && sam.edits.get(id).state === "kept-refused" && readRecovery(world.host, "r1").edits.some((entry) => entry.e === id), "Tom's row comes back empty, Sam's value stays in the copy, and his tab shows it as kept in the copy");
    },
  },
  {
    name: "waiting-edit-keeps-waiting-through-a-ledger-turn",
    about: "Rule 124 (form 18: the value waits while a room that could bring the row back is open). The moves of witness 5378006, steered by hand after them. Tom (t3) added row n5 and Sam (t5) typed into it while away; the room was lost before a save, and Sam's edit is in recovery copy r1. Dana (t1) restores the copy in the room that follows the lost room, while every other tab is away: Sam's edit waits quietly. That room then turns its ledger, which starts a new generation in the same open room. Dana restores the copy again: the edit still waits, and the record still lists it as open. Tom comes back and his row returns empty. Dana restores once more, and Sam's value lands in the row. Before round 6 the ledger turn ended the wait: the second restore closed the edit as not fitting, and no later restore wrote the value.",
    plants: ["ledger-turn-ends-the-row-wait"],
    run() {
      usePlant(armed);
      const { seed, mode, profile, moves } = WITNESSES.find((one) => one.seed === 5378006);
      const world = startSeed({ mode, profile, seed });
      for (const [name, sub] of moves) {
        world.rnd = rng(sub);
        MOVES[name](world, world.rnd);
        checkStep(world);
      }
      const [dana, sam] = ["t1", "t5"].map((id) => world.tabs.find((tab) => tab.id === id));
      const id = "t5.1:1";
      for (const tab of world.tabs) if (tab.alive && tab.connected && tab !== dana) setConnected(world, tab, false);
      settle(world, false);
      checkStep(world);
      const first = dana.notices.findLast((one) => one.kind === "restored" && one.copy === "r1");
      expect(first?.left.includes(id) && !first.misfit.length && verdict(world.host, id)?.kind === "open", "in the room that follows the lost room, Sam's edit waits quietly, and the record lists it as open");
      const before = { room: world.room.id, epoch: get(world.host).record.epoch };
      expect(rotate(world, dana), "Dana's tab turns the ledger of the open room");
      settle(world, false);
      checkStep(world);
      expect(world.room.id === before.room && get(world.host).record.epoch === before.epoch + 1, "the ledger turn starts a new generation in the same room");
      restoreFromCopy(world, dana, "r1");
      settle(world, false);
      checkStep(world);
      const second = dana.notices.findLast((one) => one.kind === "restored");
      expect(second !== first && second.left.includes(id) && !second.misfit.includes(id) && verdict(world.host, id)?.kind === "open", "after the ledger turn the edit still waits quietly, and the record still lists it as open");
      quiesce(world);
      const row = get(world.host).state.wb.rows.n5;
      expect(row && row.cells.c1 === undefined && sam.edits.get(id).state === "recovered", "Tom's row comes back empty, and Sam's value is still in the copy for a restore");
      restoreFromCopy(world, dana, "r1");
      quiesce(world);
      const third = dana.notices.findLast((one) => one.kind === "restored");
      expect(third !== second && third.applied.includes(id) && get(world.host).state.wb.rows.n5.cells.c1 === "v4" && sam.edits.get(id).state === "saved" && verdict(world.host, id)?.kind === "saved", "the next restore writes Sam's value into Tom's row, his tab shows it as saved, and the record closes it as saved");
    },
  },
  {
    name: "waiting-edit-keeps-waiting-when-its-own-room-turned-first",
    about: "Rule 124, the other side of the ledger turn. The moves of witness 5378006 up to the backup, steered by hand after them. Tom (t3) added row n5 and Sam (t5) typed into it; Sam's edit is in recovery copy r1. Tom and Sam go away before a save. Dana (t1), whose tab has not received Tom's row yet, turns the ledger of the room, which starts a new generation in the same room, and then that room is lost. Dana opens the next room alone and restores the copy. The row was last seen two generations back, but in the room right before this one, and Tom's tab can still bring it back here: Sam's edit waits quietly and the record lists it as open. Tom comes back, his row returns empty, and the next restore writes Sam's value into it. A wait that is counted in generations from the insert, and not in rooms, refuses the value in the second room.",
    plants: ["row-wait-counts-from-the-insert"],
    run() {
      usePlant(armed);
      const { seed, mode, profile, moves } = WITNESSES.find((one) => one.seed === 5378006 && one.plant === "restore-refuses-a-row-that-may-return");
      const world = startSeed({ mode, profile, seed });
      for (const [name, sub] of moves.slice(0, 46)) {
        world.rnd = rng(sub);
        MOVES[name](world, world.rnd);
        checkStep(world);
      }
      const [dana, sam] = ["t1", "t5"].map((id) => world.tabs.find((tab) => tab.id === id));
      const id = "t5.1:1";
      expect(readRecovery(world.host, "r1")?.made?.n5 && !dana.tail.some((frame) => frame.action?.row === "n5"), "Sam's backup names Tom's row, and Dana's tab has not received that row");
      for (const tab of world.tabs) if (tab.alive && tab.connected && tab !== dana) setConnected(world, tab, false);
      const before = { room: world.room.id, epoch: get(world.host).record.epoch };
      expect(rotate(world, dana), "Dana's tab turns the ledger of the room in which Tom added the row");
      settle(world, false);
      checkStep(world);
      expect(world.room.id === before.room && get(world.host).record.epoch === before.epoch + 1 && !get(world.host).state.wb.rows.n5, "the turn starts a new generation in the same room, and the row is not in it");
      roomLoss(world);
      settle(world, false);
      checkStep(world);
      expect(world.room.id !== before.room && get(world.host).record.epoch === before.epoch + 2, "that room is lost, and Dana's tab opens the next one two generations after the insert");
      restoreFromCopy(world, dana, "r1");
      settle(world, false);
      checkStep(world);
      const first = dana.notices.findLast((one) => one.kind === "restored" && one.copy === "r1");
      expect(first?.left.includes(id) && !first.misfit.includes(id) && verdict(world.host, id)?.kind === "open", "in the room that follows the lost room, Sam's edit waits quietly, and the record lists it as open");
      quiesce(world);
      const row = get(world.host).state.wb.rows.n5;
      expect(row && row.cells.c1 === undefined && sam.edits.get(id).state === "recovered", "Tom's row comes back empty, and Sam's value is still in the copy for a restore");
      restoreFromCopy(world, dana, "r1");
      quiesce(world);
      const second = dana.notices.findLast((one) => one.kind === "restored");
      expect(second !== first && second.applied.includes(id) && get(world.host).state.wb.rows.n5.cells.c1 === "v4" && sam.edits.get(id).state === "saved" && verdict(world.host, id)?.kind === "saved", "the next restore writes Sam's value into Tom's row, his tab shows it as saved, and the record closes it as saved");
    },
  },
  {
    name: "returned-restore-meets-a-newer-value",
    about: "Rule 104: a restored edit that comes back from a lost room is judged again. Sam typed two values and went away; his room was lost and a version restore replaced it, so Dana's tab stored his edits in a recovery copy. Dana restores the copy while Tom is away. The room writes Sam's values, and it is lost before a save. Tom comes back first, opens the next room from the file, which holds neither value, and types a newer value into one of the cells. Dana's tab then returns and offers the frames of the lost room. The room judges Sam's edit again against the value Sam saw. The cell changed, so the room does not write it: it sends the offer back, Dana's tab lists the edit as open in the decision record, and only then does the room count the edit without writing it. Tom's value stays. Sam's other value, whose cell did not change, is written. Dana's next restore shows Sam's edit as a conflict beside Tom's value.",
    plants: ["returned-frame-not-judged-again", "returned-frame-loses-its-origin", "returned-frame-kept-before-its-mark", "oracle-skips-returned-frames"],
    run() {
      const { s, world, sam, dana, tom, copy, second } = restoredThenLost();
      const newer = s.type(tom, "r2", "c2", "newer");
      s.send(tom);
      s.recv(tom);
      s.calm();
      expect(s.cell("r2", "c2") === "newer", "Tom's newer value is saved in the next room");
      s.online(dana);
      s.answerAll();
      s.flow();
      const back = world.room.log.filter((frame) => frame?.k === "adopt" && frame.origin);
      expect(back.length === 2 && back.every((frame) => frame.origin[0] === copy) && !back[0].keep && back[1].keep && back[1].open, "both frames return with their origin; the room writes the first and counts the second without writing it, marked as open");
      expect(world.room.state.wb.rows.r2.cells.c2 === "newer" && world.room.state.wb.rows.r1.cells.c2 === "first" && verdict(world.host, second)?.kind === "open", "Tom's value stays, Sam's other value is written, and the record lists the kept edit as open");
      s.end();
      const notice = s.restored(dana);
      expect(JSON.stringify(notice.conflicts) === JSON.stringify([{ e: second, cells: [["r2", "c2", "newer", "second"]] }]), "Dana's restore shows Sam's edit as a conflict beside Tom's value");
      expect(s.cell("r2", "c2") === "newer" && s.status(tom, newer) === "saved" && s.status(sam, second) === "recovered", "the file keeps Tom's value, and Sam's tab shows the kept edit as stored in the copy");
    },
  },
  {
    name: "returned-restore-stays-open-in-a-holders-copy",
    about: "Rule 111: an edit that the record lists as open is never closed by its place in a lost room. The story of returned-restore-meets-a-newer-value to its end: the room kept Tom's newer value, counted Sam's returned edit without writing it and marked it open, and the saved file's history now covers the place that Sam's restored edit had in the lost room. A copy of a tab that held the lost room's frames lists Sam's edit by that place. A replay of that copy onto the file does not read the covered place as saved: it shows Sam's edit as a conflict beside Tom's value, and the record still lists it as open. Sam's other edit, which the room wrote, is saved by its place.",
    plants: ["place-closes-an-open-edit"],
    run() {
      const { s, world, dana, tom, second } = restoredThenLost();
      s.type(tom, "r2", "c2", "newer");
      s.send(tom);
      s.recv(tom);
      s.calm();
      s.online(dana);
      s.answerAll();
      s.flow();
      const back = world.room.log.filter((frame) => frame?.k === "adopt" && frame.origin);
      s.end();
      const file = get(world.host);
      expect(back.length === 2 && back.every((frame) => file.state.lineage.some(([gen, through]) => gen === frame.from[0] && through >= frame.from[1])), "the file's history covers the places of both returned frames in the lost room");
      const edits = back.map((frame) => ({ e: frame.e, c: frame.c, n: frame.n, b: null, src: frame.from, org: frame.from, via: [], out: "applied", action: frame.action, saw: frame.saw }));
      const marks = new Map(world.host.decisions.map((mark) => [mark.e, mark.kind]));
      const result = replay(file, { edits }, null, marks);
      expect(result.decisions[0].how === "saved" && result.decisions[0].shown, "the edit that the room wrote is saved by its place, with its value in the sheet");
      expect(JSON.stringify(result.decisions[1]) === JSON.stringify({ e: second, how: "conflict", cells: [["r2", "c2", "newer", "second"]], late: true }), "the edit that the room kept is a conflict beside Tom's value, not saved by its place");
      expect(result.marks.get(second) === "open" && s.cell("r2", "c2") === "newer", "the record still lists it as open, and the file keeps Tom's value");
    },
  },
  {
    name: "returned-restore-is-not-shown-as-dropped",
    about: "Rule 104, the author's own tab. The story of returned-restore-meets-a-newer-value, with Sam's tab in the room when Dana restored his copy: it saw the room write his edit and waits for a save. The room is lost, Tom types a newer value, and Dana's tab returns first. When Sam's tab comes back and sees the room count his returned edit without writing it, it does not show the edit as dropped: the copy still holds it and the record lists it as open, so his tab shows it as stored in the copy.",
    plants: ["returned-edit-shown-as-dropped"],
    run() {
      const { s, world, sam, dana, tom, second } = restoredThenLost(true);
      s.type(tom, "r2", "c2", "newer");
      s.send(tom);
      s.recv(tom);
      s.calm();
      s.online(dana);
      s.answerAll();
      s.flow();
      expect(world.room.state.wb.rows.r2.cells.c2 === "newer" && verdict(world.host, second)?.kind === "open", "the room kept Tom's value, and the record lists Sam's edit as open");
      s.online(sam);
      s.answerAll();
      s.flow();
      expect(s.status(sam, second) === "recovered" && !sam.notices.some((one) => one.kind === "refused" && one.edits.includes(second)), "Sam's tab shows the edit as stored in the copy, not as dropped");
      s.end();
    },
  },
  {
    name: "returned-frame-does-not-wait-for-an-absent-holder",
    about: "Rules 104 and 110. The story of returned-restore-is-not-shown-as-dropped, where Sam's tab and Dana's tab both hold the frames of the lost room, and Sam also typed a value in that room after the restore. Dana's tab returns first and is told to write the mark for Sam's returned edit; its writes fail, and it goes away before the host has the mark. Sam's tab returns: the room gives it the same answer, it writes the mark, the room counts the returned edit without writing it, and the lost room's later frame, Sam's own value, is brought in and saved, all while Dana's tab is still away. Nobody waits for her.",
    plants: ["returned-frame-waits-for-its-first-holder"],
    run() {
      const { s, world, sam, dana, tom, second, later } = restoredThenLost(true, true);
      s.type(tom, "r2", "c2", "newer");
      s.send(tom);
      s.recv(tom);
      s.calm();
      world.host.faults = new Array(40).fill("drop");
      s.online(dana);
      s.flow();
      expect(dana.marks.some((mark) => mark.e === second && mark.kind === "open") && !verdict(world.host, second), "Dana's tab was told to write the mark, and its write did not reach the host");
      s.offline(dana);
      world.host.faults = [];
      s.online(sam);
      s.calm();
      expect(verdict(world.host, second)?.kind === "open" && s.cell("r2", "c2") === "newer", "Sam's tab wrote the mark, and Tom's value stays");
      expect(s.cell("r3", "c2") === "later" && s.status(sam, later) === "saved", "the later frame of the lost room is saved while Dana's tab is away");
      s.end();
    },
  },
  {
    name: "one-absent-tab-holds-nobody-back",
    about: "Rule 110, David's story: four people work together, and one of them must not hold the other three back. Sam types a value that the room takes and a value that never leaves his laptop, and his tab goes away. The room is lost before a save. Tom, Dana and Ana come back: their tabs bring the lost room's frames into the next room, Sam's sent value among them, they type on, and a save holds all of it while Sam's tab is still away. When he returns, his unsent value lands too.",
    plants: ["save-waits-for-every-tab"],
    run() {
      const { s, tabs } = stage(4);
      const [sam, tom, dana, ana] = tabs;
      const sent = s.type(sam, "r1", "c1", "sam-sent");
      s.send(sam);
      s.flow();
      s.offline(sam);
      const unsent = s.type(sam, "r1", "c2", "sam-unsent");
      const before = s.type(tom, "r2", "c1", "tom-before");
      s.send(tom);
      s.flow();
      for (const tab of [tom, dana, ana]) s.offline(tab);
      s.loseRoom();
      for (const tab of [tom, dana, ana]) s.online(tab);
      s.answerAll();
      s.flow();
      const after = [s.type(tom, "r2", "c2", "tom-after"), s.type(dana, "r3", "c1", "dana-after"), s.type(ana, "r3", "c2", "ana-after")];
      s.calm();
      expect(s.cell("r1", "c1") === "sam-sent" && s.cell("r2", "c1") === "tom-before", "the lost room's values are saved, Sam's sent value among them, while his tab is away");
      expect(s.cell("r2", "c2") === "tom-after" && s.cell("r3", "c1") === "dana-after" && s.cell("r3", "c2") === "ana-after", "the three who are there typed on, and a save holds their values");
      expect(s.status(tom, before) === "saved" && [tom, dana, ana].every((tab, at) => s.status(tab, after[at]) === "saved") && s.cell("r1", "c2") === undefined, "their tabs show saved; only Sam's unsent value is not in the file");
      s.end();
      expect(s.cell("r1", "c2") === "sam-unsent" && s.status(sam, unsent) === "saved" && s.status(sam, sent) === "saved", "when Sam returns, his unsent value lands, and his sent value shows as saved");
    },
  },
  {
    name: "returned-take-meets-a-newer-value",
    about: "Rule 104 for a person's take. Dana restored Sam's copy, saw his value next to Tom's, and took Sam's value. The room wrote her take, and it was lost before a save. Tom comes back first and types a newer value into the cell. Dana's tab returns and offers the frame of the lost room. Her take was judged against the value she reviewed, and the cell no longer holds it, so the room counts the take without writing it. Tom's value stays, and the edit stays open in the record for a person's next decision.",
    plants: ["returned-frame-not-judged-again", "returned-frame-loses-its-origin"],
    run() {
      const { s, world, dana, tom, copy, first } = away();
      s.restoreCopy(dana, copy);
      s.calm();
      const before = s.restored(dana);
      expect(JSON.stringify(before.conflicts[0]) === JSON.stringify({ e: first, cells: [["r1", "c2", "coworker", "first"]] }), "Dana's restore shows Sam's edit as a conflict beside the coworker's value");
      s.offline(tom);
      s.decide(dana, before.job, [[first, "take"]]);
      for (let i = 0; i < 6; i++) {
        s.send(dana);
        s.recv(dana);
      }
      expect(world.room.state.wb.rows.r1.cells.c2 === "first" && s.cell("r1", "c2") === "coworker", "the room wrote Dana's take, and no file holds it yet");
      s.offline(dana);
      s.loseRoom();
      s.online(tom);
      s.answerAll();
      s.flow();
      const newer = s.type(tom, "r1", "c2", "newer");
      s.send(tom);
      s.recv(tom);
      s.calm();
      s.online(dana);
      s.answerAll();
      s.flow();
      const back = world.room.log.findLast((frame) => frame?.k === "adopt" && frame.origin);
      expect(back?.keep && !back.open && back.origin[0] === copy && back.origin[1] === first, "the take returns with its origin, and the room counts it without writing it");
      expect(world.room.state.wb.rows.r1.cells.c2 === "newer", "Tom's newer value stays");
      s.end();
      expect(s.cell("r1", "c2") === "newer" && s.status(tom, newer) === "saved" && verdict(world.host, first)?.kind === "open", "the file keeps Tom's value, and Sam's edit stays open in the record");
    },
  },
  {
    name: "taken-delete-names-the-values-it-removed",
    about: "Rule 105: a person's take of a row delete tells what it removed. Ana deleted a row; her delete went into a recovery copy. Ben then changed the cell she saw and filled another cell of the row. Cal restores the copy: the delete is a conflict, because the cell Ana saw changed. Cal sees Ben's changed value and takes the delete. The row goes, and with it the value Ben filled in the other cell, which neither Ana nor Cal saw. Cal's notice names that value, and every open tab gets a notice of it, Ben's too.",
    plants: ["taken-delete-hides-removed-values"],
    run() {
      const { s, world, ana, ben, cal, copy, gone } = deleted();
      s.type(ben, "r1", "c1", "changed");
      s.type(ben, "r1", "c2", "late");
      s.settle();
      s.restoreCopy(cal, copy);
      s.calm();
      const first = s.restored(cal);
      expect(JSON.stringify(first.conflicts) === JSON.stringify([{ e: gone, cells: [["r1", "c1", "changed", ""]] }]), "Cal's restore shows the delete as a conflict with the one cell Ana saw");
      s.decide(cal, first.job, [[gone, "take"]]);
      s.calm();
      const after = s.restored(cal);
      const cells = [["r1", "c2", "late"]];
      expect(!s.file().state.wb.rows.r1 && JSON.stringify(after.removed) === JSON.stringify([{ e: gone, cells }]), "the row is gone, and Cal's notice names the value that went with it");
      for (const tab of [ana, ben, cal]) expect(tab.notices.some((one) => one.kind === "removed" && one.copy === copy && JSON.stringify(one.cells) === JSON.stringify(cells)), `${tab.id} has a notice of the value the take removed`);
      s.end();
    },
  },
  {
    name: "taken-delete-that-removed-its-row-shows-as-saved",
    about: "Rule 132: a take of a row delete is labelled by whether the row is gone. Ana deleted a row; her delete went into a recovery copy, and Ben then changed the cell she saw. Tia restores the copy, sees Ben's value on the conflict card and takes the delete. Her tab sends the take and goes away before the room answers. The room removes the row and saves, and the room ends. Tia's tab comes back and learns from the file that its take was counted. The row is gone, so the tab shows the take as saved, with no refusal notice. A delete writes no cells, so a tab that asked whether the sheet holds the take's cells would say that the take was refused.",
    plants: ["taken-delete-labelled-by-its-cells"],
    run() {
      const { s, world, ana, ben, cal: tia, copy, gone } = deleted();
      s.type(ben, "r1", "c1", "changed");
      s.settle();
      s.restoreCopy(tia, copy);
      s.calm();
      s.decide(tia, s.restored(tia).job, [[gone, "take"]]);
      s.send(tia, 0);
      const take = tia.pending.find((request) => request.take?.[2] === gone)?.id;
      expect(take, "the room answers that Tia's tab may take the delete, and the tab queues a request of its own");
      s.send(tia);
      s.offline(tia);
      s.calm();
      expect(!s.file().state.wb.rows.r1 && s.status(tia, take) !== "saved", "the row is gone from the saved file, and Tia's tab, which is away, has not heard");
      for (const tab of [ana, ben]) s.offline(tab);
      expect(s.expire(), "the room ends with nobody in it");
      s.online(tia);
      s.end();
      expect(s.status(tia, take) === "saved" && !tia.notices.some((one) => one.kind === "refused" && one.edits.includes(take)), "Tia's tab shows her take as saved, and no notice says that it was refused");
      expect(!s.file().state.wb.rows.r1 && world.oracle.takeOf.get(take)?.e === gone, "the row is gone from the final file, and the request that removed it is Tia's take of Ana's delete");
    },
  },
  {
    name: "taken-delete-that-left-its-row-shows-as-refused",
    about: "Rule 132, the other direction. Tia takes Ana's stored row delete from a conflict card. Before her take reaches the room, Ben types a newer value into the cell she reviewed, so the room counts the take and removes nothing. Tia's tab is away and learns of it from the file after the room ends. The row is in the sheet, so the tab shows the take as dropped, with a refused notice that holds it. A tab that showed a counted take of a delete as saved without a look at the row would tell Tia that the row is gone.",
    plants: ["taken-delete-saved-while-its-row-stands"],
    run() {
      const { s, world, ana, ben, cal: tia, copy, gone } = deleted();
      s.type(ben, "r1", "c1", "changed");
      s.settle();
      s.restoreCopy(tia, copy);
      s.calm();
      s.decide(tia, s.restored(tia).job, [[gone, "take"]]);
      s.send(tia, 0);
      const take = tia.pending.find((request) => request.take?.[2] === gone)?.id;
      expect(take, "the room answers that Tia's tab may take the delete, and the tab queues a request of its own");
      s.type(ben, "r1", "c1", "newest");
      s.send(ben);
      s.send(tia);
      s.offline(tia);
      s.calm();
      expect(s.cell("r1", "c1") === "newest", "the room removed nothing, and the saved file holds Ben's newest value");
      for (const tab of [ana, ben]) s.offline(tab);
      expect(s.expire(), "the room ends with nobody in it");
      s.online(tia);
      s.end();
      expect(s.status(tia, take) === "dropped" && tia.notices.some((one) => one.kind === "refused" && one.edits.includes(take)), "Tia's tab shows her take as dropped, with a refused notice");
      expect(verdict(world.host, gone)?.kind === "open" && s.cell("r1", "c1") === "newest", "the row is in the sheet, and the record still lists Ana's delete as open");
    },
  },
  {
    name: "returned-delete-names-the-values-it-removed",
    about: "Rule 105 for a restored delete that comes back from a lost room. Cal restores Ana's row delete, and the room is lost before a save. Eve joins, opens the next room from the file, which still has the row, and fills a cell of it that Ana did not see. Cal's and Ben's tabs return and offer the delete again. Every cell Ana saw is unchanged, so the room writes the delete. Eve's value goes with the row, and Eve, Ben and Cal each get a notice that names it.",
    plants: ["restored-delete-hides-removed-values"],
    run() {
      const { s, world, ben, cal, copy, gone } = deleted();
      s.restoreCopy(cal, copy);
      for (let i = 0; i < 8; i++) {
        s.send(cal);
        s.recv(cal);
      }
      expect(!world.room.state.wb.rows.r1 && s.file().state.wb.rows.r1, "the room applied the delete, and the file still has the row");
      s.offline(cal);
      s.offline(ben);
      s.loseRoom();
      const eve = s.join();
      s.answerAll();
      s.flow();
      const late = s.type(eve, "r1", "c2", "late");
      s.send(eve);
      s.recv(eve);
      s.online(cal);
      s.online(ben);
      s.answerAll();
      s.flow();
      s.end();
      const cells = [["r1", "c2", "late"]];
      expect(!s.file().state.wb.rows.r1 && s.status(eve, late) === "saved", "the row is gone, and Eve's edit stays a saved edit that a later delete removed");
      for (const tab of [eve, ben, cal]) expect(tab.notices.some((one) => one.kind === "removed" && one.by === gone && JSON.stringify(one.cells) === JSON.stringify(cells)), `${tab.id} has a notice of the value the returned delete removed`);
    },
  },
  {
    name: "record-of-removed-values-tells-a-tab-that-was-away",
    about: "The record of removed values, which is off unless the lab is asked for it (rule 109, David decides). Ben filled a cell of a row that Ana had deleted in a recovery copy, and his tab went away. Cal restores the copy: the delete removes Ben's value. Ben's tab was not in the room, so no frame tells it. With the record on, the save that first holds the delete carries the removed value, and the host keeps it when it accepts that save, never before (rule 125). Ben's tab reads the record when it comes back and shows a notice that names his value. A tab that joins later shows it too.",
    plants: ["record-misses-removed-values", "record-entry-not-shown", "record-written-before-its-save"],
    run() {
      const { s, world, ben, cal, copy, gone } = deleted({ removals: true });
      const late = s.type(ben, "r1", "c2", "late");
      s.settle();
      s.offline(ben);
      s.restoreCopy(cal, copy);
      for (let i = 0; i < 8; i++) {
        s.send(cal);
        s.recv(cal);
      }
      s.read(cal);
      expect(!world.room.state.wb.rows.r1 && !world.host.removals.length, "the room applied the delete, no save holds it yet, and the record is empty");
      s.calm();
      const cells = [["r1", "c2", "late"]];
      expect(JSON.stringify(world.host.removals.map((one) => [one.copy, one.by, one.cells])) === JSON.stringify([[copy, gone, cells]]), "after the save, the record names the delete and the value it removed");
      expect(!ben.notices.some((one) => one.kind === "removed"), "Ben's tab is away and has no notice yet");
      s.online(ben);
      s.end();
      expect(ben.notices.some((one) => one.kind === "removed" && one.by === gone && JSON.stringify(one.cells) === JSON.stringify(cells)) && s.status(ben, late) === "saved", "Ben's tab reads the record and shows that the restored delete removed his value");
      const dan = s.join();
      s.answerAll();
      expect(dan.notices.some((one) => one.kind === "removed" && one.by === gone), "a tab that joins later shows it too");
    },
  },
  {
    name: "record-of-removed-values-goes-with-the-save",
    about: "The gap in round 5's record of removed values (Opus's review of round 5, finding 1; rule 125). Ben filled a cell of a row that Ana had deleted in a recovery copy, and closed his tab; Ana closed hers. Cal restores the copy: the delete removes Ben's value, and Cal's tab is the only one that applied it. Cal's save reaches the host, and she closes her tab before the answer arrives. The entry goes with the save, so the record names Ben's value though no tab that applied the delete ever saw that save. Ben opens the sheet again and is told. In round 5 a tab wrote the entry only after it saw the save, so here nothing was written and Ben was never told.",
    plants: ["record-not-sent-with-its-save"],
    run() {
      const { s, world, ana, ben, cal, copy, gone } = deleted({ removals: true });
      s.type(ben, "r1", "c2", "late");
      s.settle();
      s.close(ben);
      s.close(ana);
      s.restoreCopy(cal, copy);
      for (let i = 0; i < 12; i++) {
        s.send(cal);
        s.recv(cal);
      }
      expect(!world.room.state.wb.rows.r1 && !world.host.removals.length, "the room applied the delete, no save holds it yet, and the record is empty");
      s.save(cal);
      expect(world.inflight.length === 1, "Cal's save is on its way to the host");
      s.host();
      s.close(cal);
      const cells = [["r1", "c2", "late"]];
      expect(!s.file().state.wb.rows.r1 && JSON.stringify(world.host.removals.map((one) => [one.copy, one.by, one.cells])) === JSON.stringify([[copy, gone, cells]]), "the host accepted the save, and the record names the delete and the value it removed, though Cal's tab closed before the answer");
      s.end();
      const again = s.join();
      s.end();
      expect(again.notices.some((one) => one.kind === "removed" && one.by === gone && JSON.stringify(one.cells) === JSON.stringify(cells)), "the tab that Ben opens next reads the record and shows that the restored delete removed his value");
    },
  },
];

const PAIR = [
  ["r1", "c2", "first"],
  ["r2", "c2", "also"],
];

function copied(paste = false) {
  const { s, world, tabs } = stage(2);
  const [ana, ben] = tabs;
  const first = paste ? s.paste(ana, paste === true ? PAIR : paste) : s.type(ana, "r1", "c2", "first");
  const second = s.type(ana, paste ? "r3" : "r2", "c2", "second");
  s.send(ana);
  s.recv(ana);
  s.offline(ana);
  s.loseRoom();
  s.restore(0);
  s.online(ana);
  s.answerAll();
  s.flow();
  const copy = ana.edits.get(first).copy;
  expect(copy && s.status(ana, first) === "recovered" && s.status(ana, second) === "recovered", "Ana's tab keeps both edits in a recovery copy");
  const cal = s.join();
  s.answerAll();
  s.flow();
  return { s, world, ana, ben, cal, copy, first, second };
}

function mixed(last = false) {
  const { s, world, tabs } = stage(3);
  const [ana, ben, cal] = tabs;
  const mine = s.type(ana, "r3", "c2", "ana");
  s.send(ana);
  const early = last ? s.insert(ben, "n1", "25") : s.type(ben, "r1", "c2", "ben");
  const later = last ? s.type(ben, "r1", "c2", "ben") : s.insert(ben, "n1", "25");
  const [typed, added] = last ? [later, early] : [early, later];
  s.send(ben);
  s.flow();
  const inside = s.type(cal, "n1", "c2", "cal");
  s.send(cal);
  s.flow();
  s.close(ben);
  s.close(cal);
  s.offline(ana);
  s.loseRoom();
  s.restore(0);
  s.online(ana);
  s.answerAll();
  s.flow();
  const copy = ana.edits.get(mine).copy;
  expect(readRecovery(world.host, copy)?.edits.map((entry) => entry.e).join() === [mine, early, later, inside].join(), "Ana's tab stores the four edits it held, of three authors, in the room's order");
  const dan = s.join();
  s.answerAll();
  s.type(dan, "r1", "c2", "coworker");
  s.settle();
  return { s, world, ana, dan, copy, mine, typed, added, inside };
}

function away() {
  const { s, world, tabs } = stage(2);
  const [sam, dana] = tabs;
  const first = s.type(sam, "r1", "c2", "first");
  const second = s.type(sam, "r2", "c2", "second");
  s.send(sam);
  s.flow();
  s.offline(sam);
  s.offline(dana);
  s.loseRoom();
  s.restore(0);
  s.online(dana);
  s.answerAll();
  s.flow();
  const copy = dana.notices.findLast((notice) => notice.kind === "recovery")?.copy;
  expect(readRecovery(world.host, copy)?.edits.map((entry) => entry.e).join() === [first, second].join(), "Dana's tab stores Sam's two edits, which it held");
  const tom = s.join();
  s.answerAll();
  s.type(tom, "r1", "c2", "coworker");
  s.calm();
  expect(s.cell("r1", "c2") === "coworker" && s.status(sam, first) === "shared", "Tom's value is saved, and Sam's tab is away with both edits unsettled");
  return { s, world, sam, dana, tom, copy, first, second };
}

function restoredThenLost(samThere = false, typesOn = false) {
  const { s, world, tabs } = stage(2);
  const [sam, dana] = tabs;
  const first = s.type(sam, "r1", "c2", "first");
  const second = s.type(sam, "r2", "c2", "second");
  s.send(sam);
  s.flow();
  s.offline(sam);
  s.offline(dana);
  s.loseRoom();
  s.restore(0);
  s.online(dana);
  s.answerAll();
  s.flow();
  const copy = dana.notices.findLast((notice) => notice.kind === "recovery")?.copy;
  const tom = s.join();
  s.answerAll();
  s.calm();
  if (samThere) {
    s.online(sam);
    s.answerAll();
    s.flow();
  }
  s.offline(tom);
  s.restoreCopy(dana, copy);
  for (let i = 0; i < 8; i++) {
    s.send(dana);
    s.recv(dana);
    if (samThere) s.recv(sam);
  }
  expect(world.room.state.wb.rows.r2.cells.c2 === "second" && s.cell("r2", "c2") === undefined, "the room wrote Sam's restored values, and no file holds them yet");
  if (samThere) {
    expect(s.status(sam, second) === "shared", "Sam's tab saw the restore write his edit, and waits for a save");
  }
  let later = null;
  if (typesOn) {
    later = s.type(sam, "r3", "c2", "later");
    s.send(sam);
    s.flow();
  }
  if (samThere) s.offline(sam);
  s.offline(dana);
  s.loseRoom();
  s.online(tom);
  s.answerAll();
  s.flow();
  return { s, world, sam, dana, tom, copy, first, second, later };
}

function deleted(options = {}) {
  const { s, world, tabs } = stage(2, options);
  const [ana, ben] = tabs;
  const gone = s.remove(ana, "r1");
  const second = s.type(ana, "r2", "c2", "second");
  s.send(ana);
  s.recv(ana);
  s.offline(ana);
  s.loseRoom();
  s.restore(0);
  s.online(ana);
  s.answerAll();
  s.flow();
  const copy = ana.edits.get(gone).copy;
  expect(JSON.stringify(readRecovery(world.host, copy)?.edits.map((entry) => [entry.e, entry.saw])) === JSON.stringify([[gone, { c1: "i1" }], [second, [""]]]), "Ana's tab stores the delete with the one cell she saw, and her later edit");
  const cal = s.join();
  s.answerAll();
  s.flow();
  return { s, world, ana, ben, cal, copy, gone, second };
}

function conflicted() {
  const made = copied();
  const { s, ben, cal, copy, first, second } = made;
  s.type(ben, "r2", "c2", "coworker");
  s.settle();
  s.restoreCopy(cal, copy);
  s.settle();
  const notice = s.restored(cal);
  expect(JSON.stringify(notice?.conflicts) === JSON.stringify([{ e: second, cells: [["r2", "c2", "coworker", "second"]] }]) && notice.applied.join() === first && !notice.left.length, "Cal's notice shows Ana's second edit as a conflict with the coworker's value, and her first edit restored");
  return { ...made, job: notice.job, clash: second, other: first, row: "r2", value: "second" };
}

export function runScenario(scenario, plant = "") {
  if (plant && !(plant in PLANTS)) throw new Error(`unknown plant: ${plant}`);
  armed = plant;
  try {
    scenario.run();
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: error.message };
  } finally {
    armed = "";
    usePlant("");
  }
}

const WITNESSES = JSON.parse(fs.readFileSync(new URL("./regressions.json", import.meta.url), "utf8")).filter((one) => one.plant);

const witnessName = ({ seed, mode, moves }) => `witness-${moves ? "moves" : "seed"}-${seed}-${mode}`;

const shared = (one) => WITNESSES.filter((other) => witnessName(other) === witnessName(one)).length > 1;

SCENARIOS.push(
  ...WITNESSES.map(({ seed, mode, profile, plant, found, steps = 400, moves, faults, removals, end }) => ({
    name: `${witnessName({ seed, mode, moves })}${shared({ seed, mode, moves }) ? `-${plant}` : ""}`,
    about: `A replay of ${moves ? `${moves.length} moves shrunk from fuzz seed ${seed}` : `fuzz seed ${seed}`} (${mode === "file" ? `file-only mode${profile ? `, profile ${profile}` : ""}` : `${mode} delivery, profile ${profile}`}${steps === 400 ? "" : `, ${steps} moves`}), which found this defect: ${found}.`,
    plants: [plant],
    run() {
      usePlant(armed);
      if (mode === "file") runFile(seed, 300, { profile });
      else if (moves) replayMoves(moves, { mode, profile, seed, faults, removals, end });
      else replaySeed(seed, steps, { mode, profile });
    },
  })),
);

export function runAll() {
  const rows = [];
  for (const scenario of SCENARIOS) {
    const clean = runScenario(scenario);
    const mutations = scenario.plants.map((plant) => ({ plant, ...runScenario(scenario, plant) }));
    rows.push({ name: scenario.name, about: scenario.about, passes: clean.ok, message: clean.message, mutations });
  }
  const used = new Set(SCENARIOS.flatMap((scenario) => scenario.plants));
  return { rows, unused: Object.keys(PLANTS).filter((plant) => !used.has(plant)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = runAll();
  for (const row of result.rows) {
    console.log(`${row.passes ? "pass" : "FAIL"}  ${row.name}${row.passes ? "" : `: ${row.message}`}`);
    for (const mutation of row.mutations) console.log(`      ${mutation.ok ? "NOT CAUGHT" : "caught"}  ${mutation.plant}${mutation.ok ? "" : `: ${mutation.message}`}`);
  }
  if (result.unused.length) console.log(`plants with no scenario: ${result.unused.join(", ")}`);
  const out = process.argv[2];
  if (out) fs.writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  const bad = result.rows.some((row) => !row.passes || row.mutations.some((mutation) => mutation.ok));
  process.exit(bad || result.unused.length ? 1 : 0);
}
