globalThis.ClipboardEvent ??= class ClipboardEvent extends Event {};

import fs from "node:fs";
import * as Y from "../../../../src/vendor/yjs.vendor.js";
import { identityPlugin } from "../../../../src/page/model.js";
import { state as pmState, view as pmView } from "../../../../src/vendor/prosemirror.vendor.js";
import { createPageDoc, createBridge, keepViewPos, seedFrom, docOf, walk, authorKey } from "../../../../src/page/ybind/index.js";
import { NET } from "../../../../src/page/ybind/layout.js";
import { createOriginIndex } from "../../../../src/page/ybind/origins.js";

// Four tabs with delayed, one-way delivery: A and B move, undo and redo; C and D type unique
// tokens and delete seed letters, and never undo. After a full settle every tab must hold the
// same text, no token may show twice, and no token may be gone from both the page and the
// recovery list. CARRY_FUZZ_SEEDS sets the seed count (default 20), CARRY_FUZZ_START the first
// seed, CARRY_FUZZ_MOVERS=A for one mover, CARRY_FUZZ_CYCLE=0 drops the undo-all/redo-all tail,
// CARRY_FUZZ_SYNC_MOVES=1 syncs every move, CARRY_FUZZ_REPLAY=<file> replays saved operations,
// CARRY_FUZZ_SHRINK=1 with CARRY_FUZZ_DUMP=<file> shrinks a failure, CARRY_FUZZ_TRACE=1 logs tabs.

const env = process.env;
const SEEDS = Number(env.CARRY_FUZZ_SEEDS ?? 20);
const START_SEED = Number(env.CARRY_FUZZ_START ?? 1);
const STEPS = Number(env.CARRY_FUZZ_STEPS ?? 40);
const MOVERS = (env.CARRY_FUZZ_MOVERS ?? "A,B").split(",");
const CYCLE = env.CARRY_FUZZ_CYCLE !== "0";
const VERBOSE = env.CARRY_FUZZ_VERBOSE === "1";
const ONLY = env.CARRY_FUZZ_ONLY ? Number(env.CARRY_FUZZ_ONLY) : null;
const SYNC_MOVES = env.CARRY_FUZZ_SYNC_MOVES === "1";
const REPLAY = env.CARRY_FUZZ_REPLAY ? JSON.parse(fs.readFileSync(env.CARRY_FUZZ_REPLAY, "utf8")) : null;
const DUMP = env.CARRY_FUZZ_DUMP ?? null;
const SHRINK = env.CARRY_FUZZ_SHRINK === "1";
const TRACE = env.CARRY_FUZZ_TRACE === "1";

const CLIENTS = { A: 300, B: 100, C: 200, D: 400 };
const TYPISTS = ["C", "D"];
const NAMES = ["A", "B", "C", "D"];

const mulberry32 = (seed) => { let a = seed | 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

const seedUpdate = () => {
  const pd = createPageDoc(new Y.Doc());
  pd.ydoc.clientID = 1;
  seedFrom(pd, [{ id: "p", text: "alpha" }, { id: "q", text: "bravo" }, { id: "r", text: "charlie" }, { id: "s", text: "delta" }]);
  return Y.encodeStateAsUpdateV2(pd.ydoc);
};

const opened = [];
const closeAll = () => { for (const { view, bridge, mount } of opened.splice(0)) { view.destroy(); bridge.dispose(); bridge.pd.ydoc.destroy(); mount.remove(); } };
afterEach(closeAll);

function open(update, name) {
  const doc = new Y.Doc();
  doc.clientID = CLIENTS[name];
  Y.applyUpdateV2(doc, update);
  const pd = createPageDoc(doc);
  pd.ydoc.transact(() => pd.origins.set(authorKey(doc.clientID), `T${name}`), NET);
  const stats = { groups: 0, mismatch: 0, renders: 0, first: null, proveWalks: true };
  const bridge = createBridge({ pd, stats, captureTimeout: 0 });
  const mount = document.body.appendChild(document.createElement("div"));
  const view = new pmView.EditorView(mount, {
    state: pmState.EditorState.create({ doc: keepViewPos(docOf(pd, walk(pd))), plugins: [identityPlugin()] }),
    dispatchTransaction: (tr) => bridge.dispatch(tr),
  });
  bridge.attach(view);
  const tab = { name, pd, bridge, stats, view, mount };
  opened.push(tab);
  return tab;
}

const send = (from, to) => Y.applyUpdateV2(to.pd.ydoc, Y.encodeStateAsUpdateV2(from.pd.ydoc, Y.encodeStateVector(to.pd.ydoc)), NET);
const rows = (tab) => { const out = []; tab.view.state.doc.forEach((node, offset) => out.push({ id: node.attrs.id, offset, text: node.textContent })); return out; };
const visibleText = (tab) => rows(tab).map((row) => row.text).join("|");
const svKey = (tab) => JSON.stringify([...Y.decodeStateVector(Y.encodeStateVector(tab.pd.ydoc))].sort((a, b) => a[0] - b[0]));
const TOKEN = /\{([CD])(\d+)\}/g;
const tokensIn = (text) => [...text.matchAll(TOKEN)].map((m) => m[0]);
const recoverableText = (tab) => tab.bridge.recoverable.map((record) => record.blocks.map((block) => block.runs.map((run) => run.text ?? "").join("")).join("|")).join("||");
const freeOffsets = (text) => { const out = []; let depth = 0; for (let i = 0; i <= text.length; i++) { if (depth === 0) out.push(i); if (i < text.length) { if (text[i] === "{") depth++; else if (text[i] === "}") depth--; } } return out; };

class Failure extends Error { constructor(kind, message) { super(message); this.kind = kind; } }

function nextOp(rng, tabs, counter) {
  const roll = rng();
  if (roll < 0.12) {
    const name = pick(rng, MOVERS);
    const ids = rows(tabs[name]).map((row) => row.id);
    const id = pick(rng, ids);
    return { k: "move", tab: name, id, afterId: pick(rng, [null, ...ids.filter((other) => other !== id)]), sync: SYNC_MOVES };
  }
  if (roll < 0.22) return { k: "undo", tab: pick(rng, MOVERS) };
  if (roll < 0.30) return { k: "redo", tab: pick(rng, MOVERS) };
  if (roll < 0.52) {
    const name = pick(rng, TYPISTS);
    const row = pick(rng, rows(tabs[name]));
    if (!row) return null;
    return { k: "type", tab: name, id: row.id, offset: pick(rng, freeOffsets(row.text)), token: `{${name}${++counter.n}}` };
  }
  if (roll < 0.62) {
    const name = pick(rng, TYPISTS);
    const row = pick(rng, rows(tabs[name]));
    if (!row) return null;
    const spots = [];
    for (let i = 0; i < row.text.length; i++) if (/[a-z]/.test(row.text[i])) spots.push(i);
    if (!spots.length) return null;
    const from = pick(rng, spots);
    let to = from + 1;
    while (to < row.text.length && to - from < 3 && /[a-z]/.test(row.text[to]) && rng() < 0.5) to++;
    return { k: "del", tab: name, id: row.id, from, to };
  }
  const from = pick(rng, NAMES);
  return { k: "send", from, to: pick(rng, NAMES.filter((n) => n !== from)) };
}

function execute(op, tabs, typed, log) {
  const all = Object.values(tabs);
  const tab = tabs[op.tab];
  const row = op.id !== undefined && tab ? rows(tab).find((r) => r.id === op.id) : null;
  switch (op.k) {
    case "move": {
      if (op.sync) for (const other of all) if (other !== tab) send(other, tab);
      const ids = rows(tab).map((r) => r.id);
      if (!ids.includes(op.id) || (op.afterId !== null && (!ids.includes(op.afterId) || op.afterId === op.id))) { log.push(`${op.tab} move ${op.id} after ${op.afterId}: skipped`); break; }
      const r = tab.bridge.moveBlocks({ ids: [op.id], afterId: op.afterId });
      log.push(`${op.tab} moves ${op.id} after ${op.afterId}${op.sync ? " (synced)" : ""} -> ${r.status}`);
      if (op.sync) for (const other of all) if (other !== tab) send(tab, other);
      break;
    }
    case "undo": log.push(`${op.tab} undo -> ${tab.bridge.undo()}`); break;
    case "redo": log.push(`${op.tab} redo -> ${tab.bridge.redo()}`); break;
    case "type": {
      if (!row) { log.push(`${op.tab} type ${op.token}: no block ${op.id}, skipped`); break; }
      const offsets = freeOffsets(row.text);
      const offset = offsets.includes(op.offset) ? op.offset : offsets[offsets.length - 1];
      typed.set(op.token, op.tab);
      log.push(`${op.tab} types ${op.token} into ${op.id} at ${offset} (${JSON.stringify(row.text)})`);
      tab.view.dispatch(tab.view.state.tr.insertText(op.token, row.offset + 1 + offset));
      break;
    }
    case "del": {
      if (!row || op.to > row.text.length || !/^[a-z]+$/.test(row.text.slice(op.from, op.to))) { log.push(`${op.tab} del ${op.id} ${op.from}..${op.to}: skipped`); break; }
      log.push(`${op.tab} deletes ${JSON.stringify(row.text.slice(op.from, op.to))} from ${op.id}`);
      tab.view.dispatch(tab.view.state.tr.delete(row.offset + 1 + op.from, row.offset + 1 + op.to));
      break;
    }
    case "send": send(tabs[op.from], tabs[op.to]); log.push(`send ${op.from} -> ${op.to}`); break;
    case "settle": {
      for (let round = 0; round < 12; round++) {
        for (const from of all) for (const to of all) if (from !== to) send(from, to);
        if (new Set(all.map(svKey)).size === 1) { for (const from of all) for (const to of all) if (from !== to) send(from, to); if (new Set(all.map(svKey)).size === 1) { log.push("settle"); return; } }
      }
      throw new Failure("settle", "tabs never settled");
    }
    case "check": check(op.phase, all, typed); log.push(`check ${op.phase}`); break;
    default: throw new Error(`unknown op ${JSON.stringify(op)}`);
  }
}

function check(phase, all, typed) {
  const deltas = all.map((tab) => JSON.stringify(tab.pd.flow.toDelta()));
  if (new Set(deltas).size !== 1) throw new Failure("diverge", `${phase}: flows differ`);
  const texts = all.map(visibleText);
  if (new Set(texts).size !== 1) throw new Failure("diverge", `${phase}: visible text differs: ${JSON.stringify(texts)}`);
  for (const tab of all) if (tab.stats.mismatch || tab.stats.walkMismatch) throw new Failure("mismatch", `${phase}: ${tab.name} mismatch`);
  const text = texts[0];
  const seen = new Map();
  for (const token of tokensIn(text)) seen.set(token, (seen.get(token) ?? 0) + 1);
  const dups = [...seen].filter(([, n]) => n > 1).map(([token, n]) => `${token}x${n}`);
  if (dups.length) throw new Failure("dup", `${phase}: duplicated tokens ${dups.join(", ")} in ${JSON.stringify(text)}`);
  const rec = all.map(recoverableText).join("###");
  const lost = [...typed.keys()].filter((token) => !seen.has(token) && !rec.includes(token));
  if (lost.length) throw new Failure("lost", `${phase}: lost tokens ${lost.join(", ")}; visible ${JSON.stringify(text)}; recoverable ${JSON.stringify(rec)}`);
  const index = createOriginIndex(all[0].pd.origins);
  try {
    const chars = [];
    for (let it = all[0].pd.flow._start; it; it = it.right) {
      if (it.deleted || !(it.content instanceof Y.ContentString)) continue;
      for (let offset = 0; offset < it.length; offset++) chars.push({ ch: it.content.str[offset], id: { client: it.id.client, clock: it.id.clock + offset } });
    }
    const flat = chars.map((c) => c.ch).join("");
    for (const m of flat.matchAll(TOKEN)) {
      if (!seen.has(m[0])) continue;
      for (let i = m.index; i < m.index + m[0].length; i++) {
        const author = all[0].pd.origins.get(authorKey(index.resolve(chars[i].id).client));
        if (author !== `T${typed.get(m[0])}`) throw new Failure("author", `${phase}: token ${m[0]} char ${chars[i].ch} attributed to ${author}`);
      }
    }
  } finally { index.dispose(); }
  return { text, displaced: [...typed.keys()].filter((token) => !seen.has(token)) };
}

function run({ seed, ops = null }) {
  const update = seedUpdate();
  const tabs = {};
  for (const name of NAMES) tabs[name] = open(update, name);
  const all = Object.values(tabs);
  const typed = new Map();
  const log = [];
  const done = [];
  const counter = { n: 0 };
  const rng = ops ? null : mulberry32(seed * 9973 + 7);
  let failure = null;
  const apply = (op) => {
    done.push(op);
    try {
      execute(op, tabs, typed, log);
      if (TRACE) log.push(`    ${NAMES.map((n) => `${n}: ${rows(tabs[n]).map((r) => `${r.id}=${r.text}`).join(" ")}`).join("  /  ")}  rec[${NAMES.map((n) => recoverableText(tabs[n])).join(";")}]`);
    } catch (error) { failure = error instanceof Failure ? error : new Failure("throw", `${JSON.stringify(op)} threw: ${error?.stack ?? error}`); }
  };
  if (ops) { for (const op of ops) { apply(op); if (failure) break; } }
  else {
    for (let step = 0; step < STEPS && !failure; step++) { const op = nextOp(rng, tabs, counter); if (op) apply(op); }
    const tail = [{ k: "settle" }, { k: "check", phase: "after settle" }];
    if (CYCLE) {
      for (const name of MOVERS) { for (let i = 0; i < 20; i++) tail.push({ k: "undo", tab: name }); tail.push({ k: "settle" }); }
      tail.push({ k: "check", phase: "after undoing everything" });
      for (const name of MOVERS) { for (let i = 0; i < 20; i++) tail.push({ k: "redo", tab: name }); tail.push({ k: "settle" }); }
      tail.push({ k: "check", phase: "after redoing everything" });
    }
    for (const op of tail) { if (failure) break; apply(op); }
  }
  let displaced = [];
  if (!failure) { try { displaced = check("final", all, typed).displaced; } catch (error) { failure = error; } }
  closeAll();
  return { failure, ops: done, log, displaced };
}

function shrink(ops, kind) {
  let list = ops.slice();
  let changed = true;
  while (changed) {
    changed = false;
    for (let at = list.length - 1; at >= 0; at--) {
      const candidate = [...list.slice(0, at), ...list.slice(at + 1)];
      const out = run({ seed: 0, ops: candidate });
      if (out.failure && out.failure.kind === kind) { list = candidate; changed = true; }
    }
  }
  return list;
}

const move = (tab, id, afterId, sync = false) => ({ k: "move", tab, id, afterId, sync });
const undo = (tab) => ({ k: "undo", tab });
const redo = (tab) => ({ k: "redo", tab });
const type = (tab, id, offset, token) => ({ k: "type", tab, id, offset, token });
const del = (tab, id, from, to) => ({ k: "del", tab, id, from, to });
const pass = (from, to) => ({ k: "send", from, to });
const settle = { k: "settle" };

// Shrunk seeds, each a loss or a duplicate in an earlier version of the carry: the review of the
// first version found all but 703, which the second version showed.
const CASES = {
  "321: Redo by two movers never glues block p's text and a typed word onto q twice": [del("C", "q", 1, 4), move("B", "q", "s", true), move("B", "q", "p", true), del("C", "q", 0, 1), undo("B"), type("D", "q", 1, "{D2}"), type("D", "p", 3, "{D4}"), undo("B"), pass("C", "D"), del("D", "q", 4, 5), move("A", "p", "q", true), redo("B"), move("A", "s", "q", true), del("C", "q", 11, 12), undo("A"), undo("A"), undo("B"), settle, redo("A"), settle, redo("B"), redo("B"), settle],
  "343: after two movers each undo and redo twice, q holds its text and the typed word once": [move("B", "q", "r", true), type("C", "q", 2, "{C1}"), move("A", "q", "p", true), move("B", "q", null, true), move("A", "q", "r", true), undo("A"), undo("A"), undo("B"), undo("B"), settle, redo("A"), redo("A"), settle, redo("B"), redo("B"), settle],
  "2169: a carried word survives another mover's later Undo": [move("A", "r", null), undo("A"), type("D", "r", 6, "{D4}"), redo("A"), move("B", "r", "s"), pass("B", "D"), pass("D", "A"), undo("A"), settle, undo("B"), settle],
  "2217: a word typed at the end of s during a quick drag below s is never lost": [move("B", "r", "s"), undo("B"), type("D", "s", 5, "{D1}"), move("A", "r", "s"), pass("D", "B"), pass("B", "A"), undo("A"), settle],
  "3234: a word typed at the end of p is never carried into a block dragged below p": [move("A", "q", null), move("B", "s", "p"), type("C", "p", 5, "{C5}"), pass("C", "A"), undo("B"), pass("A", "B"), move("A", "p", null), settle],
  "3441: two tabs that moved r and both undo never both carry the word typed at the end of s": [move("B", "r", "s"), type("D", "s", 5, "{D1}"), move("A", "r", "s"), pass("B", "D"), pass("D", "A"), undo("B"), undo("A"), pass("D", "B"), redo("B"), settle],
  "703: a word carried to the end of s while another tab drops r right after s is shown once after s moves again": [move("A", "s", "p"), pass("A", "D"), type("D", "s", 5, "{D5}"), undo("A"), move("B", "r", "s"), pass("D", "A"), move("A", "s", "p"), settle],
};

if (REPLAY) {
  test("replay", () => {
    const out = run({ seed: 0, ops: REPLAY });
    console.log(`replay log:\n  ${out.log.join("\n  ")}\nresult: ${out.failure ? `${out.failure.kind}: ${out.failure.message}` : "ok"} displaced ${out.displaced.join(",")}`);
    if (out.failure) throw out.failure;
  });
} else {
  for (const [name, ops] of Object.entries(CASES)) {
    test(`case ${name}`, () => {
      const out = run({ seed: 0, ops });
      if (out.failure) throw new Error(`${out.failure.kind}: ${out.failure.message}\n  ${out.log.join("\n  ")}`);
    });
  }
  const seeds = ONLY ? [ONLY] : Array.from({ length: SEEDS }, (_, i) => START_SEED + i);
  for (const seed of seeds) {
    test(`seed ${seed}`, () => {
      let out = run({ seed });
      if (out.failure && SHRINK) {
        const small = shrink(out.ops, out.failure.kind);
        out = run({ seed: 0, ops: small });
        if (DUMP) fs.writeFileSync(DUMP, JSON.stringify(small, null, 1));
        console.log(`seed ${seed} shrunk to ${small.length} ops:\n  ${out.log.join("\n  ")}\n${out.failure?.message}`);
      } else if (DUMP && out.failure) fs.writeFileSync(DUMP, JSON.stringify(out.ops, null, 1));
      if (VERBOSE) console.log(`seed ${seed}\n  ${out.log.join("\n  ")}`);
      if (out.failure) throw new Error(`seed ${seed}: ${out.failure.kind}: ${out.failure.message}`);
    }, 120000);
  }
}
