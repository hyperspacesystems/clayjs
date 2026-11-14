/**
 * @jest-environment jsdom
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { jest } from "@jest/globals";
import { deserialize, serialize } from "node:v8";
import { IDBFactory } from "fake-indexeddb";

globalThis.structuredClone ??= (value) => deserialize(serialize(value));

/**
 * A seeded fuzzer for plain contenteditable fields and RichClay rich fields on the page's
 * one history.
 *
 * Each seed is a random run of the owner typing, another writer's changes, page undos and
 * page redos. Five invariants hold: nothing throws and nothing is logged as an error; a page
 * undo never removes another writer's text; a press changes at most one field, the one its
 * entry names; a seed with no other writer returns exactly to where it began, undoing and
 * redoing; and no owner text is lost when the history is replayed all the way down and back,
 * or it is in a kept recovery copy. A failure prints its seed and its operations, so it can
 * be replayed exactly.
 *
 * FUZZ_SEEDS seeds run from FUZZ_SEED_START, FUZZ_STEPS operations each. FUZZ_REPLAY=<file>
 * replays a recorded operation list instead of generating one, and FUZZ_SHRINK=1 shrinks a
 * failing list to the shortest one that still breaks the same invariant, under
 * tests/unit/fields-fuzz-cases/.
 */

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 5);
const SEED_START = Number(process.env.FUZZ_SEED_START ?? 1);
const STEPS = Number(process.env.FUZZ_STEPS ?? 10);
const SHRINK = process.env.FUZZ_SHRINK === "1";
const REPLAY_FILE = process.env.FUZZ_REPLAY ? path.resolve(process.env.FUZZ_REPLAY) : null;
const CASES_DIR = fileURLToPath(new URL("./fields-fuzz-cases/", import.meta.url));
const TIMEOUT = SHRINK ? 600000 : 120000;

jest.setTimeout(TIMEOUT);

const SLOT = "/notes.html";

const BODY = `
<ul>
  <li data-id="r1"><div editable>
      <p>Rich one.</p>
    </div></li>
  <li data-id="r2"><div editable><p>Rich two.</p></div></li>
</ul>
<p id="a" contenteditable="true">Plain a.</p>
<p id="b" contenteditable="true">Plain b.</p>
`;

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rest = async () => {
  await settle();
  await tick(20);
};

async function until(check, tries = 400) {
  for (let at = 0; at < tries; at++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

function clearRoot() {
  const root = document.documentElement;
  for (const name of Array.from(root.attributes, (attribute) => attribute.name)) root.removeAttribute(name);
}

function response({ ok = true, status = 200, body = "", headers = {} } = {}) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Not Found",
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body || "{}"),
  };
}

let factory;

async function boot({ edit = true, plugins = "undo", body = BODY, recovery = false } = {}) {
  releaseListeners();
  jest.resetModules();
  sessionStorage.clear();
  localStorage.clear();
  delete window.clayEditMode;
  delete window.__hyperclayEditMode;
  document.cookie = "isAdminOfCurrentResource=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  document.cookie = "isAdminOfCurrentResource=true; path=/";
  clearRoot();
  window.history.replaceState({}, "", edit ? `${SLOT}?editmode=true` : SLOT);
  document.head.innerHTML = "";
  // A page left over from an earlier seed keeps its mutation observers on the body it was
  // booted over; a fresh body means this seed's edits are nobody else's to read.
  const fresh = document.createElement("body");
  fresh.innerHTML = body;
  document.documentElement.replaceChild(fresh, document.body);
  window.fetch = async (input, options = {}) => {
    const method = (options && options.method) || "GET";
    if (method === "HEAD") return response();
    if (method === "POST") return response({ body: JSON.stringify({ msg: "Saved" }) });
    if (String(input).includes("/_/meta")) {
      return response({ body: JSON.stringify({ spec: 1, extensions: [], document: {} }) });
    }
    return response({ ok: false, status: 404 });
  };
  window.scrollTo = () => {};
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  if (recovery) {
    const module = await import("../../src/core/recovery.js");
    window.clay = { recovery: module.createRecovery({ mode: "edit", indexedDB: factory }) };
  } else {
    window.clay = {};
  }
  const params = new URLSearchParams(`plugins=${plugins}`);
  const { boot: run } = await import("../../src/loader.js");
  await new Promise((resolve) => run(null, params, resolve));
  await rest();
  booted.push(window.clay);
  return window.clay;
}

const FIELD_IDS = ["r1", "r2", "a", "b"];
const RICH = new Set(["r1", "r2"]);
const START_TEXT = { r1: "Rich one.", r2: "Rich two.", a: "Plain a.", b: "Plain b." };

const field = (id) => document.querySelector(`[data-id="${id}"] [editable]`);
const plainField = (id) => document.getElementById(id);
const elementOf = (id) => (RICH.has(id) ? field(id) : plainField(id));

const editorOf = (clay, id) => clay.RichClay.init([field(id)])[0];

const caretIn = (node) => {
  const walker = node.ownerDocument.createTreeWalker(node, 4);
  let last = null;
  for (let at = walker.nextNode(); at; at = walker.nextNode()) if (at.data) last = at;
  const range = node.ownerDocument.createRange();
  if (last) range.setStart(last, last.data.length);
  else range.setStart(node, node.childNodes.length);
  range.collapse(true);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
};

async function type(clay, id, text) {
  const element = field(id);
  const editor = editorOf(clay, id);
  editor.focus();
  caretIn(element);
  const win = element.ownerDocument.defaultView;
  for (const char of text) {
    element.dispatchEvent(new win.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: char }));
    editor.squire.insertPlainText(char);
    element.dispatchEvent(new win.InputEvent("input", { bubbles: true, inputType: "insertText", data: char }));
  }
  await rest();
}

async function typePlain(element, text) {
  caretIn(element);
  const last = element.lastChild;
  if (last && last.nodeType === 3) last.data += text;
  else element.appendChild(element.ownerDocument.createTextNode(text));
  element.dispatchEvent(new element.ownerDocument.defaultView.InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  await rest();
}

const open = [];

const watch = (type) => {
  const seen = [];
  const handler = (event) => seen.push(event.detail);
  document.addEventListener(type, handler);
  open.push({ type, handler });
  return seen;
};

const peerWrite = (clay, write) => {
  clay.Mutation.pause();
  try {
    write();
  } finally {
    clay.Mutation.resume();
  }
};

// A real page boots once; this file boots one page per seed in one window, and a page's
// document and window listeners outlive it. Each boot's are taken back when its seed ends,
// or every later seed's keystrokes run through one more page's handlers.
const installed = [];
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const shared = (target) => target === document || target === window || target === document.documentElement;
EventTarget.prototype.addEventListener = function (type, handler, options) {
  if (shared(this) && handler) installed.push({ target: this, type, handler, options });
  return addListener.call(this, type, handler, options);
};
EventTarget.prototype.removeEventListener = function (type, handler, options) {
  const at = installed.findIndex((item) => item.target === this && item.type === type && item.handler === handler);
  if (at >= 0) installed.splice(at, 1);
  return removeListener.call(this, type, handler, options);
};
const releaseListeners = () => {
  for (const { target, type, handler, options } of installed.splice(0)) {
    removeListener.call(target, type, handler, options);
  }
};

beforeEach(() => {
  factory = new IDBFactory();
});

const booted = [];
const mounted = [];
const stopSession = () => { for (const clay of booted.splice(0)) clay?.undo?.stop?.(); };

afterEach(() => {
  jest.restoreAllMocks();
  stopSession();
  for (const { type, handler } of open.splice(0)) document.removeEventListener(type, handler);
  document.body.innerHTML = "";
  window.clay = undefined;
});

const collapse = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const fieldText = (id) => collapse(elementOf(id)?.textContent);
const texts = () => Object.fromEntries(FIELD_IDS.map((id) => [id, fieldText(id)]));
const pageText = () => FIELD_IDS.map(fieldText).join(" ");
const tokenSet = (text) => new Set(String(text).match(/[OP]\d+/g) ?? []);
const tokenPresent = (text, token) => tokenSet(text).has(token);
const lines = (value) => FIELD_IDS.map((id) => `  ${id}: ${JSON.stringify(value[id] ?? "")}`);

const lastTextOf = (root) => {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  let last = null;
  for (let at = walker.nextNode(); at; at = walker.nextNode()) if (at.data) last = at;
  return last;
};

const appendText = (root, text) => {
  const last = lastTextOf(root);
  if (last) last.data += text;
  else root.appendChild(root.ownerDocument.createTextNode(text));
};

const peerRoot = (id) => {
  const element = elementOf(id);
  if (!element) return null;
  if (!RICH.has(id)) return element;
  const paragraphs = element.querySelectorAll("p");
  return paragraphs[paragraphs.length - 1] ?? element;
};

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

const KINDS = ["ownerSentence", "ownerWords", "pause", "peerAppend", "peerDelete", "pageUndo", "pageRedo"];
const WEIGHTS = {
  ownerSentence: 30,
  ownerWords: 10,
  pause: 5,
  peerAppend: 12,
  peerDelete: 8,
  pageUndo: 18,
  pageRedo: 12,
};
const PEER_KINDS = new Set(["peerAppend", "peerDelete"]);
const TOTAL = KINDS.reduce((sum, kind) => sum + WEIGHTS[kind], 0);
const chooseKind = (rng) => {
  let roll = rng() * TOTAL;
  for (const kind of KINDS) {
    roll -= WEIGHTS[kind];
    if (roll < 0) return kind;
  }
  return KINDS[KINDS.length - 1];
};

const generate = (kind, rng) => {
  if (kind === "ownerSentence" || kind === "ownerWords" || kind === "peerAppend") {
    return { kind, id: pick(rng, FIELD_IDS) };
  }
  if (kind === "peerDelete") {
    const id = pick(rng, FIELD_IDS);
    const root = peerRoot(id);
    const node = root ? lastTextOf(root) : null;
    if (!node || !node.data.length) return { kind, id, from: null, to: null };
    const from = below(rng, node.data.length);
    const to = from + 1 + below(rng, node.data.length - from);
    return { kind, id, from, to };
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
  start: "invariant 1: the page starts at the seed's text",
  throw: "invariant 1: no operation throws",
  logged: "invariant 1: nothing is printed with console.error",
  peer: "invariant 2: an undo never removes another writer's text",
  oneField: "invariant 3: one press changes one field, the one its entry names",
  startText: "invariant 4: with no other writer, undo and redo return exactly",
  replay: "invariant 5: replaying the history loses no owner text",
  unexpected: "the harness threw",
};

const targetIds = (steps) => {
  const ids = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.id === "string" && value.id) ids.add(value.id);
    for (const item of Object.values(value)) visit(item);
  };
  visit(steps);
  return ids;
};

const typeInto = (clay, id, text) =>
  RICH.has(id) ? type(clay, id, text) : typePlain(elementOf(id), text);

const planOp = (op, { clay, state }) => {
  switch (op.kind) {
    case "ownerSentence": {
      const a = `O${++state.ownerCount}`;
      const b = `O${++state.ownerCount}`;
      state.ownerTyped.add(a);
      state.ownerTyped.add(b);
      const text = ` ${a} ${b}.`;
      const element = elementOf(op.id);
      if (!element) return { desc: `owner types ${JSON.stringify(text.trim())} at the end of ${op.id} (no such field: skipped)`, apply: async () => {} };
      return { desc: `owner types the sentence ${JSON.stringify(text.trim())} at the end of ${op.id}`, apply: () => typeInto(clay, op.id, text) };
    }
    case "ownerWords": {
      const a = `O${++state.ownerCount}`;
      const b = `O${++state.ownerCount}`;
      state.ownerTyped.add(a);
      state.ownerTyped.add(b);
      const text = ` ${a} ${b}`;
      const element = elementOf(op.id);
      if (!element) return { desc: `owner types ${JSON.stringify(text.trim())} at the end of ${op.id} (no such field: skipped)`, apply: async () => {} };
      return { desc: `owner types the words ${JSON.stringify(text.trim())} at the end of ${op.id}`, apply: () => typeInto(clay, op.id, text) };
    }
    case "pause":
      return { desc: "a pause of 600 ms", apply: () => tick(600) };
    case "peerAppend": {
      const token = `P${++state.peerCount}`;
      const root = peerRoot(op.id);
      if (!root) return { desc: `another writer appends ${JSON.stringify(` ${token}`)} to ${op.id} (no such field: skipped)`, apply: async () => {} };
      return {
        desc: `another writer appends ${JSON.stringify(` ${token}`)} to ${op.id}`,
        apply: async () => { peerWrite(clay, () => appendText(root, ` ${token}`)); },
        peer: true,
      };
    }
    case "peerDelete": {
      const root = peerRoot(op.id);
      const node = root ? lastTextOf(root) : null;
      const usable = node && op.from != null && op.from < op.to && op.to <= node.data.length;
      const desc = usable
        ? `another writer deletes ${JSON.stringify(node.data.slice(op.from, op.to))} from ${op.id}`
        : `another writer deletes ${op.from}..${op.to} from ${op.id} (not applicable: skipped)`;
      if (!usable) return { desc, apply: async () => {}, peer: true };
      return {
        desc,
        apply: async () => { peerWrite(clay, () => { node.data = node.data.slice(0, op.from) + node.data.slice(op.to); }); },
        peer: true,
      };
    }
    case "pageUndo":
      return {
        desc: "page undo",
        apply: async () => { clay.undo.flush(); return clay.undo.undo(); },
        press: "undo",
      };
    case "pageRedo":
      return {
        desc: "page redo",
        apply: async () => { clay.undo.flush(); return clay.undo.redo(); },
        press: "redo",
      };
    default:
      throw new Error(`unknown operation ${JSON.stringify(op)}`);
  }
};

const entryOf = (clay, direction) =>
  direction === "undo" ? clay.undo.history.at(-1) ?? null : clay.undo.future[0] ?? null;

const executeCase = async (seed, given = null) => {
  const rng = given ? null : mulberry32(seed * 7919 + 17);
  const ops = [];
  const journal = [];
  const started = performance.now();
  const errors = [];

  const clay = await boot({ recovery: true });
  mounted.push(editorOf(clay, "r1"), editorOf(clay, "r2"));
  await rest();
  jest.spyOn(console, "error").mockImplementation((...args) => { errors.push(args.map((arg) => String(arg)).join(" ")); });
  const skips = watch("clay:undo-skipped");
  const kept = watch("clay:undo-kept");

  const state = { ownerCount: 0, peerCount: 0, ownerTyped: new Set(), peerOpSeen: false };
  let peerTokens = new Set();

  const fail = (code, why, detail = {}) => {
    const out = [`seed ${seed}: ${why}`, `(${INVARIANT_NAMES[code] ?? code})`, "operations:"];
    for (const line of journal) out.push(`  ${line}`);
    out.push("fields before:", ...lines(detail.before ?? {}));
    out.push("fields after:", ...lines(detail.after ?? {}));
    out.push(`history labels: ${JSON.stringify(clay.undo.history.map((entry) => entry.label))}`);
    throw new FuzzFailure(code, out.join("\n"), ops.slice());
  };

  const atStart = texts();
  for (const id of FIELD_IDS) {
    if (atStart[id] !== START_TEXT[id]) fail("start", `${id} does not start at its own text`, { after: atStart });
  }

  // A plain field's text steps name no data-id, so only the count can be held there; a
  // rich field's steps name the field and the changed one must be that field.
  const press = (op, plan, before, after) => {
    if (op.kind !== "pageUndo" && op.kind !== "pageRedo") return;
    const skipped = skips.length > plan.skipMark;
    const changed = FIELD_IDS.filter((id) => before[id] !== after[id]);
    if (changed.length > 1) {
      fail("oneField", `a ${plan.press} changed ${changed.length} fields: ${changed.join(", ")}`, { before, after });
    }
    if (skipped || !changed.length || !plan.entry) return;
    const named = targetIds(plan.entry.steps);
    if (named.size && !changed.every((id) => named.has(id))) {
      fail("oneField", `a ${plan.press} of entry ${JSON.stringify(plan.entry.label)} changed ${changed.join(", ")} but its steps name ${[...named].join(", ")} steps ${JSON.stringify(plan.entry.steps)}`, { before, after });
    }
  };

  for (let at = 0; ; at++) {
    let op;
    if (given) {
      op = given[at];
      if (!op) break;
    } else {
      if (at >= STEPS) break;
      op = generate(chooseKind(rng), rng);
    }
    const before = texts();
    const pageBefore = pageText();
    let plan;
    try {
      plan = planOp(op, { clay, state });
    } catch (error) {
      fail("throw", `an operation could not be built: ${error?.message ?? error}`, { before, after: texts() });
    }
    const direction = plan.press ?? null;
    plan.skipMark = skips.length;
    if (direction) {
      const entry = entryOf(clay, direction);
      plan.entry = entry ? clay.undo.describe(entry.id) : null;
    }
    ops.push(op);
    journal.push(plan.desc);
    if (at < 5) console.log(`seed ${seed} op ${at + 1}: ${plan.desc}`);
    try {
      await plan.apply();
    } catch (error) {
      fail("throw", `operation threw: ${error?.message ?? error}`, { before, after: texts() });
    }
    if (PEER_KINDS.has(op.kind)) {
      state.peerOpSeen = true;
      await rest();
      peerTokens = new Set([...tokenSet(pageText())].filter((token) => token.startsWith("P")));
    } else {
      await settle();
    }
    clay.undo.flush();
    const after = texts();
    if (direction) {
      const lost = [...peerTokens].filter((token) => tokenPresent(pageBefore, token) && !tokenPresent(pageText(), token));
      if (lost.length) {
        fail("peer", `a ${direction} removed another writer's text: ${lost.join(", ")}`, { before, after });
      }
      press(op, plan, before, after);
    }
    if (errors.length) {
      fail("logged", `console.error was printed: ${errors[0]}`, { before, after });
    }
  }

  // Steps still waiting to be redone come back first, so "redo everything" below has the
  // same end to return to.
  for (let redos = 0; clay.undo.canRedo; ) {
    clay.undo.flush();
    clay.undo.redo();
    if (++redos > 200) fail("replay", "page redo did not run out within 200 presses", { after: texts() });
  }
  await settle();
  const tail = texts();
  const ownerTokens = [...state.ownerTyped].filter((token) => tokenPresent(pageText(), token));

  let undos = 0;
  while (clay.undo.canUndo) {
    clay.undo.flush();
    clay.undo.undo();
    if (++undos > 200) fail("startText", "page undo did not run out within 200 presses", { before: tail, after: texts() });
  }
  await settle();
  const undone = texts();

  if (!state.peerOpSeen) {
    for (const id of FIELD_IDS) {
      if (undone[id] !== START_TEXT[id]) {
        fail("startText", `with no other writer, undoing everything left ${id} at ${JSON.stringify(undone[id])}`, { before: tail, after: undone });
      }
    }
  }

  let redos = 0;
  while (clay.undo.canRedo) {
    clay.undo.flush();
    clay.undo.redo();
    if (++redos > 200) fail("replay", "page redo did not run out within 200 presses", { before: undone, after: texts() });
  }
  await settle();
  const redone = texts();

  if (!state.peerOpSeen) {
    for (const id of FIELD_IDS) {
      if (redone[id] !== tail[id]) {
        fail("startText", `with no other writer, redoing everything left ${id} at ${JSON.stringify(redone[id])} and not ${JSON.stringify(tail[id])}`, { before: undone, after: redone });
      }
    }
  }

  const listed = await clay.undo.kept();
  const keptJson = JSON.stringify(listed?.records ?? []);
  const final = pageText();
  const lost = ownerTokens.filter((token) => !tokenPresent(final, token) && !keptJson.includes(token));
  if (lost.length) {
    fail("replay", `replaying the history lost owner text: ${lost.join(", ")}`, { before: tail, after: redone });
  }
  if (errors.length) fail("logged", `console.error was printed: ${errors[0]}`, { before: tail, after: redone });

  // A skipped step's recovery copy is written behind the press; the page must finish it
  // before this case's window goes away.
  await until(() => kept.length >= skips.length, 120);
  await rest();

  console.log(`seed ${seed}: ${ops.length} operations, ${undos} undos, ${redos} redos, ${(performance.now() - started).toFixed(0)} ms`);
  return { ops, undos, redos };
};

const attempt = async (seed, ops) => {
  const openMark = open.length;
  try {
    await executeCase(seed, ops);
    return null;
  } catch (error) {
    if (error instanceof FuzzFailure) return error;
    return new FuzzFailure("unexpected", `seed ${seed}: ${error?.stack ?? error}`, ops ?? []);
  } finally {
    stopSession();
    for (const editor of mounted.splice(0)) {
      try { editor?.destroy?.(); } catch {}
    }
    await settle();
    // The mutation hub is published on the window, so it outlives a boot: its observer is
    // taken off the root and the window's copy dropped, or every later seed's edits are
    // read by one more stale page.
    releaseListeners();
    await settle();
    releaseListeners();
    window.__clayMutation?._observer?.disconnect?.();
    delete window.__clayMutation;
    for (const { type, handler } of open.splice(openMark)) document.removeEventListener(type, handler);
    factory = new IDBFactory();
  }
};

const writeCase = (seed, invariant, ops, failure) => {
  fs.mkdirSync(CASES_DIR, { recursive: true });
  const file = path.join(CASES_DIR, `seed-${seed}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ seed, invariant, ops, failure }, null, 2)}\n`);
  return file;
};

const shrink = async (seed, ops, invariant) => {
  let list = ops.map((op) => ({ ...op }));
  const same = async (candidate) => {
    const outcome = await attempt(seed, candidate);
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

const report = async (seed, failure) => {
  if (!SHRINK) throw failure;
  const invariant = failure.code;
  const shrunk = await shrink(seed, failure.ops, invariant);
  const replay = await attempt(seed, shrunk);
  const file = writeCase(seed, invariant, shrunk, replay?.message ?? failure.message);
  console.log(`seed ${seed}: ${failure.ops.length} operations shrink to ${shrunk.length} (${INVARIANT_NAMES[invariant] ?? invariant})`);
  console.log(`seed ${seed} shrunk operations:`);
  for (const op of shrunk) console.log(`  ${JSON.stringify(op)}`);
  console.log(file);
  throw new FuzzFailure(invariant, `${failure.message}\n\nshrunk to ${shrunk.length} operations in ${file}\n${replay?.message ?? ""}`, shrunk);
};

if (REPLAY_FILE) {
  const data = JSON.parse(fs.readFileSync(REPLAY_FILE, "utf8"));
  const ops = Array.isArray(data) ? data : data.ops;
  const seed = Array.isArray(data) ? SEED_START : data.seed ?? SEED_START;
  test(`replay ${path.basename(REPLAY_FILE)}`, async () => {
    const failure = await attempt(seed, ops);
    if (failure) await report(seed, failure);
  }, TIMEOUT);
} else {
  for (let seed = SEED_START; seed < SEED_START + SEEDS; seed++) {
    test(`seed ${seed}`, async () => {
      const failure = await attempt(seed, null);
      if (failure) await report(seed, failure);
    }, TIMEOUT);
  }
}
