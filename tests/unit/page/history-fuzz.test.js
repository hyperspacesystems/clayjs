globalThis.ClipboardEvent ??= class ClipboardEvent extends Event {};

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jest } from "@jest/globals";
import * as Y from "../../../src/vendor/yjs.vendor.js";
import { createStore } from "../../../src/live/store.js";
import { identityPlugin } from "../../../src/page/model.js";
import { state as pmState, view as pmView } from "../../../src/vendor/prosemirror.vendor.js";
import { createYPageBinding, seedValue, createPageDoc, docOf, walk, bareShape } from "../../../src/page/ybind/index.js";
import { NET } from "../../../src/page/ybind/layout.js";
import { historyIntentPlugin, createHistoryBridge } from "../../../src/page/history-intent.js";
import { undo as engine, undoParticipant } from "../../../src/plugins/undo.js";

/**
 * A seeded fuzzer for the block editor's steps on the page's one history.
 *
 * Each seed is a random run of edits, edits from a second tab, undos and redos. Four
 * invariants hold throughout: nothing throws and no tab drifts from its Yjs copy; a page undo
 * never removes another person's text; no owner text is lost when the page history is replayed
 * from bottom to top and back; and a seed with no peer edit returns exactly to where it began.
 * A failure prints its seed and the operations so far, so it can be replayed exactly.
 *
 * FUZZ_CONTROL=1 runs the same seeds with the editor's own history alone: no page session and
 * no adapter, so seed N makes the same choices as in page mode but nothing reaches the page.
 * FUZZ_REPLAY=<file> replays a recorded operation list instead of generating one, and
 * FUZZ_SHRINK=1 shrinks a failing list to the shortest one that still breaks the same
 * invariant, writing it under tests/unit/page/fuzz-cases/.
 */

window.clay = { ...(window.clay || {}), undo: engine };

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 5);
const SEED_START = Number(process.env.FUZZ_SEED_START ?? 1);
const STEPS = Number(process.env.FUZZ_STEPS ?? 40);
const CONTROL = process.env.FUZZ_CONTROL === "1";
const SHRINK = process.env.FUZZ_SHRINK === "1";
const MODE = CONTROL ? "control" : "page";
const REPLAY_FILE = process.env.FUZZ_REPLAY ? path.resolve(process.env.FUZZ_REPLAY) : null;
const CASES_DIR = fileURLToPath(new URL("./fuzz-cases/", import.meta.url));
const TIMEOUT = SHRINK ? 600000 : undefined;

const mulberry32 = (seed) => {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];
const below = (rng, n) => Math.floor(rng() * n) % Math.max(n, 1);

const tokenSet = (text) => new Set(text.match(/[OP]\d+/g) ?? []);
const tokenPresent = (text, token) => tokenSet(text).has(token);

let clock = 0;
beforeEach(() => {
  clock = 1000000;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
});

const opened = [];
const leases = [];
let generation = 0;

const stopSession = () => {
  for (const lease of leases.splice(0)) lease.dispose();
  engine.stop();
};

const release = (mark = 0, leaseMark = 0) => {
  for (const lease of leases.splice(leaseMark)) lease.dispose();
  if (!leases.length) engine.stop();
  for (const { view, binding, mount, article, note } of opened.splice(mark)) {
    view.destroy();
    binding.dispose();
    binding.ydoc.destroy();
    mount.remove();
    article.remove();
    note?.remove();
  }
};

afterEach(() => {
  jest.restoreAllMocks();
  stopSession();
  release();
  document.body.replaceChildren();
});

const umOf = (tab) => tab.binding.bridge.um;

const stackIds = new WeakMap();
let debugTab = null;
const recordStep = engine.recordStep.bind(engine);
engine.recordStep = (label, primitive) => {
  const receipt = recordStep(label, primitive);
  const item = debugTab ? umOf(debugTab).undoStack.at(-1) : null;
  if (item && typeof primitive?.newValue === "string") stackIds.set(item, primitive.newValue);
  return receipt;
};
const stackState = (tab) => {
  const um = umOf(tab);
  return {
    undo: [...um.undoStack].map((item) => stackIds.get(item) ?? "?"),
    redo: [...um.redoStack].map((item) => stackIds.get(item) ?? "?"),
  };
};
const stackLines = (before, after) => [
  `undoStack before: ${before.undo.length} [${before.undo.join(", ")}]`,
  `redoStack before: ${before.redo.length} [${before.redo.join(", ")}]`,
  `undoStack after: ${after.undo.length} [${after.undo.join(", ")}]`,
  `redoStack after: ${after.redo.length} [${after.redo.join(", ")}]`,
];

function open(value, { plugins = [historyIntentPlugin()] } = {}) {
  const store = createStore({ name: "blockeditor", value: JSON.parse(JSON.stringify(value)) });
  const binding = createYPageBinding({ store, captureTimeout: 0 });
  const article = document.body.appendChild(document.createElement("article"));
  const mount = article.appendChild(document.createElement("div"));
  mount.setAttribute("no-undo", "");
  const view = new pmView.EditorView(mount, {
    state: pmState.EditorState.create({ doc: binding.doc(), plugins: [identityPlugin(), ...plugins] }),
    dispatchTransaction: (tr) => binding.dispatch(tr),
  });
  binding.attach(view);
  const tab = { store, binding, view, mount, article };
  opened.push(tab);
  return tab;
}

async function startSession() {
  const lease = await undoParticipant().prepare({ generation: ++generation, isCurrent: () => true });
  lease.enable();
  leases.push(lease);
  return lease;
}

function bridge(tab) {
  return createHistoryBridge({
    um: tab.binding.bridge.um,
    undo: () => tab.binding.undo(),
    redo: () => tab.binding.redo(),
    article: tab.article,
    focus: () => tab.view.focus(),
  });
}

const sideField = (value) => {
  const node = document.body.appendChild(document.createElement("p"));
  node.id = "side";
  node.textContent = value;
  return node;
};

const articleText = (tab) => tab.view.state.doc.textContent;
const paragraphs = (tab) => {
  const out = [];
  tab.view.state.doc.forEach((node, offset) => out.push({ id: node.attrs.id, offset, node }));
  return out;
};
const endOf = (tab, id) => {
  let end = null;
  tab.view.state.doc.forEach((node, offset) => { if (node.attrs.id === id) end = offset + 1 + node.content.size; });
  return end;
};
const caret = (tab, pos) => tab.view.dispatch(tab.view.state.tr.setSelection(pmState.TextSelection.create(tab.view.state.doc, pos)));
const type = (tab, chars) => {
  for (const ch of chars) {
    const { from, to } = tab.view.state.selection;
    tab.view.someProp("handleTextInput", (f) => f(tab.view, from, to, ch, () => tab.view.state.tr.insertText(ch, from, to)));
  }
};
const relay = (from, to) => Y.applyUpdateV2(to.binding.ydoc, Y.encodeStateAsUpdateV2(from.binding.ydoc), NET);

const reload = (tab) => {
  const doc = new Y.Doc();
  Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(tab.binding.ydoc), NET);
  const pd = createPageDoc(doc);
  const result = docOf(pd, walk(pd));
  doc.destroy();
  return result;
};
const drift = (tab) => {
  const want = bareShape(reload(tab));
  const have = bareShape(tab.view.state.doc);
  if (want !== have) return `the editor shape ${have} differs from its Yjs copy ${want}`;
  if (tab.binding.stats.mismatch !== 0) return `the binding reports ${tab.binding.stats.mismatch} mismatched writes`;
  return null;
};

const settle = async () => {
  for (let at = 0; at < 8; at++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const START_BLOCKS = [
  { id: "p", text: "p one" },
  { id: "q", text: "q two" },
  { id: "r", text: "r three" },
];
const SIDE_START = "side nil";

const KINDS = ["ownerSentence", "ownerWords", "pause", "sideCommit", "moveBlock", "peerTypes", "peerDeletes", "pageUndo", "pageRedo"];
const WEIGHTS = {
  ownerSentence: 25,
  ownerWords: 10,
  pause: 5,
  sideCommit: 10,
  moveBlock: 5,
  peerTypes: 10,
  peerDeletes: 8,
  pageUndo: 15,
  pageRedo: 12,
};
const PEER_KINDS = new Set(["peerTypes", "peerDeletes"]);
const TOTAL = KINDS.reduce((sum, kind) => sum + WEIGHTS[kind], 0);
const chooseKind = (rng) => {
  let roll = rng() * TOTAL;
  for (const kind of KINDS) {
    roll -= WEIGHTS[kind];
    if (roll < 0) return kind;
  }
  return KINDS[KINDS.length - 1];
};

const generate = (kind, rng, { tab, peer }) => {
  if (kind === "ownerSentence" || kind === "ownerWords" || kind === "peerTypes") {
    return { kind, id: pick(rng, paragraphs(kind === "peerTypes" ? peer : tab)).id };
  }
  if (kind === "moveBlock") {
    const all = paragraphs(tab).map((block) => block.id);
    const id = pick(rng, all);
    const afterId = pick(rng, [null, ...all.filter((other) => other !== id)]);
    return { kind, id, afterId };
  }
  if (kind === "peerDeletes") {
    const candidates = paragraphs(peer).filter((block) => block.node.textContent.length > 0);
    if (!candidates.length) return { kind, blockId: null };
    const block = pick(rng, candidates);
    const length = block.node.textContent.length;
    const from = block.offset + 1 + below(rng, length);
    const to = from + 1 + below(rng, length - (from - block.offset - 1));
    return { kind, blockId: block.id, from, to };
  }
  return { kind };
};

class FuzzFailure extends Error {
  constructor(code, message, ops) {
    super(message);
    this.code = code;
    this.ops = ops;
  }
}

const INVARIANT_NAMES = {
  start: "invariant 1: the starting article is the seed's text",
  throw: "invariant 1: nothing throws",
  drift: "invariant 1: no tab drifts from its Yjs copy",
  peer: "invariant 2: a page undo never removes another person's text",
  startText: "invariant 3: with no peer edit, undoing everything restores the starting text",
  replay: "invariant 4: replaying the history loses no owner text",
  unexpected: "the harness threw",
};

// Builds one operation's description and its run, so a replay runs exactly what it describes.
const planOp = (op, { tab, peer, note, state }) => {
  switch (op.kind) {
    case "ownerSentence": {
      const a = `O${++state.ownerCount}`;
      const b = `O${++state.ownerCount}`;
      state.ownerTyped.add(a);
      state.ownerTyped.add(b);
      const desc = `owner types the sentence "${a} ${b}. " at the end of ${op.id}`;
      const end = endOf(tab, op.id);
      if (end == null) return { desc: `${desc} (no such block: skipped)`, apply() {} };
      return { desc, apply() { caret(tab, end); type(tab, `${a} ${b}. `); } };
    }
    case "ownerWords": {
      const a = `O${++state.ownerCount}`;
      const b = `O${++state.ownerCount}`;
      state.ownerTyped.add(a);
      state.ownerTyped.add(b);
      const desc = `owner types the words "${a} ${b}" at the end of ${op.id}`;
      const end = endOf(tab, op.id);
      if (end == null) return { desc: `${desc} (no such block: skipped)`, apply() {} };
      return { desc, apply() { caret(tab, end); type(tab, `${a} ${b}`); } };
    }
    case "pause":
      return { desc: "a clock pause of 600 ms", apply() { clock += 600; } };
    case "sideCommit": {
      const value = `side ${++state.sideCount}`;
      return {
        desc: `owner sets the side field to "${value}" and commits it`,
        apply() {
          if (CONTROL) { note.textContent = value; return; }
          engine.commit("Rename side", () => { note.textContent = value; });
        },
      };
    }
    case "moveBlock": {
      const desc = `owner moves ${op.id} after ${op.afterId ?? "the top"}`;
      const ids = paragraphs(tab).map((block) => block.id);
      const usable = ids.includes(op.id) && (op.afterId == null || ids.includes(op.afterId));
      if (!usable) return { desc: `${desc} (no such block: skipped)`, apply() {} };
      return { desc, apply() { tab.binding.moveBlocks({ ids: [op.id], afterId: op.afterId }); } };
    }
    case "peerTypes": {
      const token = `P${++state.peerCount}`;
      state.peerTyped.add(token);
      const desc = `peer types "${token}" at the end of ${op.id}`;
      const end = endOf(peer, op.id);
      if (end == null) return { desc: `${desc} (no such block: skipped)`, apply() {} };
      return { desc, apply() { caret(peer, end); type(peer, `${token} `); } };
    }
    case "peerDeletes": {
      if (op.blockId == null) return { desc: "peer deletes: no paragraph has text to remove", apply() {} };
      const block = paragraphs(peer).find((candidate) => candidate.id === op.blockId);
      const start = block ? block.offset + 1 : null;
      const end = block ? start + block.node.content.size : null;
      const usable = block && start <= op.from && op.from < op.to && op.to <= end;
      const desc = usable
        ? `peer deletes ${JSON.stringify(block.node.textContent.slice(op.from - start, op.to - start))} from ${op.blockId}`
        : `peer deletes ${op.from}..${op.to} from ${op.blockId} (not applicable: skipped)`;
      if (!usable) return { desc, apply() {} };
      return {
        desc,
        apply() {
          caret(peer, op.from);
          peer.view.dispatch(peer.view.state.tr.delete(op.from, op.to));
        },
      };
    }
    case "pageUndo":
      return {
        desc: "page undo",
        watching: [...state.peerTyped].filter((token) => tokenPresent(articleText(peer), token)),
        apply() { if (CONTROL) tab.binding.undo(); else engine.undo(); },
      };
    case "pageRedo":
      return { desc: "page redo", apply() { if (CONTROL) tab.binding.redo(); else engine.redo(); } };
    default:
      throw new Error(`unknown operation ${JSON.stringify(op)}`);
  }
};

const executeCase = async (seed, mode, given = null) => {
  const control = mode === "control";
  const rng = given ? null : mulberry32(seed * 7919 + 17);
  const ops = [];
  const lines = [];
  const started = performance.now();

  const note = sideField(SIDE_START);
  const startText = START_BLOCKS.map((block) => block.text).join("");
  const tab = open(seedValue(START_BLOCKS));
  const peer = open(seedValue(START_BLOCKS));
  tab.note = note;
  if (!control) {
    await startSession();
    debugTab = tab;
    bridge(tab);
  }
  relay(tab, peer);
  relay(peer, tab);

  const state = {
    ownerCount: 0,
    peerCount: 0,
    sideCount: 0,
    ownerTyped: new Set(),
    peerTyped: new Set(),
    peerOpSeen: false,
  };

  const fail = (code, why, detail = {}) => {
    const out = [`seed ${seed} [${mode}]: ${why}`, `(${INVARIANT_NAMES[code] ?? code})`, "operations:"];
    for (const line of lines) out.push(`  ${line}`);
    out.push(`article before: ${JSON.stringify(detail.before ?? "")}`);
    out.push(`article after: ${JSON.stringify(detail.after ?? "")}`);
    if (detail.stacks) out.push(...detail.stacks);
    throw new FuzzFailure(code, out.join("\n"), ops.slice());
  };

  if (articleText(tab) !== startText) fail("start", "the starting article is not the seed's text", { after: articleText(tab) });

  for (let at = 0; ; at++) {
    let op;
    if (given) {
      op = given[at];
      if (!op) break;
    } else {
      if (at >= STEPS) break;
      op = generate(chooseKind(rng), rng, { tab, peer });
    }
    const before = articleText(tab);
    const stacksBefore = stackState(tab);
    let plan;
    try {
      plan = planOp(op, { tab, peer, note, state });
    } catch (error) {
      fail("throw", `an operation could not be built: ${error?.message ?? error}`, { before, after: articleText(tab) });
    }
    ops.push(op);
    lines.push(plan.desc);
    if (at < 5) console.log(`seed ${seed} [${mode}] op ${at + 1}: ${plan.desc}`);
    try {
      plan.apply();
    } catch (error) {
      fail("throw", `operation threw: ${error?.message ?? error}`, { before, after: articleText(tab), stacks: stackLines(stacksBefore, stackState(tab)) });
    }
    if (PEER_KINDS.has(op.kind)) state.peerOpSeen = true;
    if (plan.watching) {
      const lost = plan.watching.filter((token) => tokenPresent(before, token) && !tokenPresent(articleText(tab), token));
      if (lost.length) {
        fail("peer", `a page undo removed another person's text: ${lost.join(", ")}`, {
          before, after: articleText(tab), stacks: stackLines(stacksBefore, stackState(tab)),
        });
      }
    }
    relay(tab, peer);
    relay(peer, tab);
    const drifted = drift(tab);
    if (drifted) {
      fail("drift", drifted, {
        before, after: articleText(tab), stacks: stackLines(stacksBefore, stackState(tab)),
      });
    }
    const peerDrifted = drift(peer);
    if (peerDrifted) {
      fail("drift", `the peer tab drifted: ${peerDrifted}`, {
        before, after: articleText(peer), stacks: stackLines(stacksBefore, stackState(tab)),
      });
    }
  }

  const tail = articleText(tab);
  const ownerTokens = [...state.ownerTyped].filter((token) => tokenPresent(tail, token));
  const stacksBefore = stackState(tab);

  const journal = [];
  const watched = control ? [] : ["undo", "redo", "skipped", "refused", "discard"].map((type) => {
    const handler = (detail) => journal.push(`${type} ${JSON.stringify({
      entryId: detail?.entryId ?? null,
      label: detail?.label ?? null,
      direction: detail?.direction ?? null,
      code: detail?.code ?? null,
    })}`);
    engine.on(type, handler);
    return [type, handler];
  });
  const unwatch = () => { for (const [type, handler] of watched) engine.off(type, handler); };
  const pressLines = (mark) => (journal.length > mark ? ["page history during the replay:", ...journal.slice(mark)] : []);

  let undos = 0;
  const undoMark = journal.length;
  if (control) {
    const um = umOf(tab);
    while (um.undoStack.length) {
      if (!tab.binding.undo()) break;
      if (++undos > 200) fail("startText", "the editor's own undo did not run out within 200 presses", { before: tail, after: articleText(tab), stacks: [...stackLines(stacksBefore, stackState(tab)), ...pressLines(undoMark)] });
    }
  } else {
    while (engine.canUndo) {
      const pressBefore = stackState(tab);
      engine.undo();
      journal.push(`press ${undos + 1} undo: undoStack ${pressBefore.undo.length} [${pressBefore.undo.join(", ")}] -> ${stackState(tab).undo.length}, redoStack ${pressBefore.redo.length} -> ${stackState(tab).redo.length}`);
      if (++undos > 200) fail("startText", "page undo did not run out within 200 presses", { before: tail, after: articleText(tab), stacks: [...stackLines(stacksBefore, stackState(tab)), ...pressLines(undoMark)] });
    }
  }
  await settle();
  const afterUndo = articleText(tab);

  if (!state.peerOpSeen) {
    if (afterUndo !== startText) fail("startText", "with no peer edit, undoing everything did not restore the starting text", { before: tail, after: afterUndo, stacks: stackLines(stacksBefore, stackState(tab)) });
    if (note.textContent !== SIDE_START) {
      fail("startText", `with no peer edit, undoing everything left the side field at "${note.textContent}"`, { before: tail, after: afterUndo, stacks: stackLines(stacksBefore, stackState(tab)) });
    }
  }

  let redos = 0;
  const redoMark = journal.length;
  if (control) {
    const um = umOf(tab);
    while (um.redoStack.length) {
      if (!tab.binding.redo()) break;
      if (++redos > 200) fail("replay", "the editor's own redo did not run out within 200 presses", { before: afterUndo, after: articleText(tab), stacks: [...stackLines(stacksBefore, stackState(tab)), ...pressLines(redoMark)] });
    }
  } else {
    while (engine.canRedo) {
      const pressBefore = stackState(tab);
      engine.redo();
      journal.push(`press ${redos + 1} redo: undoStack ${pressBefore.undo.length} -> ${stackState(tab).undo.length}, redoStack ${pressBefore.redo.length} [${pressBefore.redo.join(", ")}] -> ${stackState(tab).redo.length}`);
      if (++redos > 200) fail("replay", "page redo did not run out within 200 presses", { before: afterUndo, after: articleText(tab), stacks: [...stackLines(stacksBefore, stackState(tab)), ...pressLines(redoMark)] });
    }
  }
  unwatch();
  await settle();
  relay(peer, tab);
  const finalText = articleText(tab);
  const reference = control ? tail : articleText(peer);
  const lost = ownerTokens.filter((token) => tokenPresent(reference, token) && !tokenPresent(finalText, token));
  if (lost.length) {
    fail("replay", `replaying the history lost owner text ${control ? "the article had" : "the peer still has"}: ${lost.join(", ")}`, { before: tail, after: finalText, stacks: [...stackLines(stacksBefore, stackState(tab)), ...pressLines(undoMark)] });
  }

  console.log(`seed ${seed} [${mode}]: ${ops.length} operations, ${undos} undos, ${redos} redos, ${(performance.now() - started).toFixed(0)} ms`);
  return { ops, undos, redos };
};

// One attempt at a case, cleaned up afterwards so a shrink can run many in one test.
const attempt = async (seed, mode, ops) => {
  const mark = opened.length;
  const leaseMark = leases.length;
  debugTab = null;
  try {
    await executeCase(seed, mode, ops);
    return null;
  } catch (error) {
    if (error instanceof FuzzFailure) return error;
    return new FuzzFailure("unexpected", `seed ${seed} [${mode}]: ${error?.stack ?? error}`, ops ?? []);
  } finally {
    debugTab = null;
    release(mark, leaseMark);
  }
};

const writeCase = (seed, mode, invariant, ops, failure) => {
  fs.mkdirSync(CASES_DIR, { recursive: true });
  const file = path.join(CASES_DIR, `seed-${seed}-${mode}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ seed, mode, invariant, ops, failure }, null, 2)}\n`);
  return file;
};

const shrink = async (seed, mode, ops, invariant) => {
  let list = ops.map((op) => ({ ...op }));
  const same = async (candidate) => {
    const outcome = await attempt(seed, mode, candidate);
    return outcome && outcome.code === invariant;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (let at = list.length - 1; at >= 0; at--) {
      const candidate = [...list.slice(0, at), ...list.slice(at + 1)];
      if (await same(candidate)) {
        list = candidate;
        changed = true;
      }
    }
    for (let at = 0; at < list.length; at++) {
      const candidate = [...list.slice(0, at), ...list.slice(at + 1)];
      if (await same(candidate)) {
        list = candidate;
        changed = true;
        at--;
      }
    }
  }
  return list;
};

const report = async (seed, mode, failure) => {
  if (!SHRINK) throw failure;
  const invariant = failure.code;
  const shrunk = await shrink(seed, mode, failure.ops, invariant);
  const replay = await attempt(seed, mode, shrunk);
  const file = writeCase(seed, mode, invariant, shrunk, replay?.message ?? failure.message);
  console.log(`seed ${seed} [${mode}]: ${failure.ops.length} operations shrink to ${shrunk.length} (${INVARIANT_NAMES[invariant] ?? invariant})`);
  console.log(`seed ${seed} [${mode}] shrunk operations:`);
  for (const op of shrunk) console.log(`  ${JSON.stringify(op)}`);
  console.log(file);
  throw new FuzzFailure(invariant, `${failure.message}\n\nshrunk to ${shrunk.length} operations in ${file}\n${replay?.message ?? ""}`, shrunk);
};

if (REPLAY_FILE) {
  const data = JSON.parse(fs.readFileSync(REPLAY_FILE, "utf8"));
  const ops = Array.isArray(data) ? data : data.ops;
  const seed = Array.isArray(data) ? SEED_START : data.seed ?? SEED_START;
  test(`replay ${path.basename(REPLAY_FILE)} in ${MODE} mode`, async () => {
    const failure = await attempt(seed, MODE, ops);
    if (failure) await report(seed, MODE, failure);
  }, TIMEOUT);
} else {
  for (let seed = SEED_START; seed < SEED_START + SEEDS; seed++) {
    test(`seed ${seed}`, async () => {
      const failure = await attempt(seed, MODE, null);
      if (failure) await report(seed, MODE, failure);
    }, TIMEOUT);
  }
}
