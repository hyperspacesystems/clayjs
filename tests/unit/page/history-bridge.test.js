globalThis.ClipboardEvent ??= class ClipboardEvent extends Event {};

import { jest } from "@jest/globals";
import * as Y from "../../../src/vendor/yjs.vendor.js";
import { createStore } from "../../../src/live/store.js";
import { identityPlugin } from "../../../src/page/model.js";
import { state as pmState, view as pmView } from "../../../src/vendor/prosemirror.vendor.js";
import { createYPageBinding, seedValue, migrateHybridValues, bareShape } from "../../../src/page/ybind/index.js";
import { NET } from "../../../src/page/ybind/layout.js";
import { historyIntentPlugin } from "../../../src/page/history-intent.js";
import { tablePlugin } from "../../../src/page/table.js";
import { createHistoryBridge } from "../../../src/page/history-intent.js";
import { gateRevision } from "../../../src/lib/dirty-gate.js";
import { undo as engine, undoParticipant } from "../../../src/plugins/undo.js";

/**
 * The block editor's steps on the page's one history.
 *
 * The page loads both plugins: `undo` owns the one timeline, and a small adapter turns each
 * local block editor step into one page entry. Page undo and redo replay that entry through
 * the editor's own one-step undo and redo, a peer's change makes no entry, and an entry whose
 * editor step has moved is skipped like any other stale step, with the press going on to the
 * next older one.
 */

window.clay = { ...(window.clay || {}), undo: engine };

let clock = 0;
beforeEach(() => {
  clock = 1000000;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
});

const opened = [];
const leases = [];
let generation = 0;

// Every boot leaves a session with its own window key listeners and a history of its own.
const stopSession = () => {
  for (const lease of leases.splice(0)) lease.dispose();
  engine.stop();
};

afterEach(() => {
  jest.restoreAllMocks();
  stopSession();
  for (const { view, binding, mount } of opened.splice(0)) {
    view.destroy();
    binding.dispose();
    binding.ydoc.destroy();
    mount.remove();
  }
  document.body.replaceChildren();
});

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

const side = () => {
  const node = document.body.appendChild(document.createElement("p"));
  node.id = "side";
  node.textContent = "side";
  return node;
};

const text = (tab) => tab.view.state.doc.child(0).textContent;
const ids = (tab) => {
  const out = [];
  tab.view.state.doc.forEach((node) => out.push(node.attrs.id));
  return out;
};
const caret = (tab, pos) => tab.view.dispatch(tab.view.state.tr.setSelection(pmState.TextSelection.create(tab.view.state.doc, pos)));
const type = (tab, chars) => {
  for (const ch of chars) {
    const { from, to } = tab.view.state.selection;
    tab.view.someProp("handleTextInput", (f) => f(tab.view, from, to, ch, () => tab.view.state.tr.insertText(ch, from, to)));
  }
};
const relay = (from, to) => Y.applyUpdateV2(to.binding.ydoc, Y.encodeStateAsUpdateV2(from.binding.ydoc), NET);
const labels = () => engine.history.map((entry) => entry.label);
const umOf = (tab) => tab.binding.bridge.um;
const shape = (tab) => bareShape(tab.view.state.doc);

const watched = [];
// The recovery copy behind a skipped step is made after the press returns, so a case that
// proves no copy was made waits for it.
const settle = async () => {
  for (let at = 0; at < 8; at++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const watch = (type) => {
  const seen = [];
  const handler = (event) => seen.push(event.detail);
  document.addEventListener(type, handler);
  watched.push({ type, handler });
  return seen;
};
afterEach(() => {
  for (const { type, handler } of watched.splice(0)) document.removeEventListener(type, handler);
});

test("two typed sentences make two page entries, and joined keystrokes make none", async () => {
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession();
  bridge(tab);
  caret(tab, 4);

  type(tab, "Hi");
  expect(umOf(tab).undoStack.length).toBe(1);
  expect(labels()).toEqual(["Edit"]);
  type(tab, " there. ");
  expect(umOf(tab).undoStack.length).toBe(1);
  expect(labels()).toEqual(["Edit"]);
  type(tab, "Next one");
  expect(text(tab)).toBe("abcHi there. Next one");
  expect(umOf(tab).undoStack.length).toBe(2);
  expect(labels()).toEqual(["Edit", "Edit"]);

  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abcHi there. ");
  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abc");
  expect(engine.undo().code).toBe("empty");
  expect(labels()).toEqual([]);

  expect(engine.redo().ok).toBe(true);
  expect(text(tab)).toBe("abcHi there. ");
  expect(engine.redo().ok).toBe(true);
  expect(text(tab)).toBe("abcHi there. Next one");
  expect(labels()).toEqual(["Edit", "Edit"]);

  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abcHi there. ");
  expect(engine.redo().ok).toBe(true);
  expect(text(tab)).toBe("abcHi there. Next one");
});

test("a page change between two block steps is undone in order, and it seals the open block step", async () => {
  const note = side();
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession();
  bridge(tab);
  caret(tab, 4);
  type(tab, "one");
  engine.commit("Rename side", () => { note.textContent = "changed"; });
  type(tab, "two");
  expect(text(tab)).toBe("abconetwo");
  expect(labels()).toEqual(["Edit", "Rename side", "Edit"]);

  expect(engine.undo().label).toBe("Edit");
  expect(text(tab)).toBe("abcone");
  expect(note.textContent).toBe("changed");
  expect(engine.undo().label).toBe("Rename side");
  expect(note.textContent).toBe("side");
  expect(text(tab)).toBe("abcone");
  expect(engine.undo().label).toBe("Edit");
  expect(text(tab)).toBe("abc");

  expect(engine.redo().ok).toBe(true);
  expect(engine.redo().ok).toBe(true);
  expect(engine.redo().ok).toBe(true);
  expect(text(tab)).toBe("abconetwo");
  expect(note.textContent).toBe("changed");
});

test("without the adapter, the same typing is one editor step", async () => {
  const note = side();
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession();
  caret(tab, 4);
  type(tab, "one");
  engine.commit("Rename side", () => { note.textContent = "changed"; });
  type(tab, "two");
  expect(text(tab)).toBe("abconetwo");
  expect(umOf(tab).undoStack.length).toBe(1);
  expect(labels()).toEqual(["Rename side"]);
});

test("a peer's change adds no page entry and survives the owner's undo", async () => {
  const value = seedValue([{ id: "p", text: "abc" }]);
  const tab = open(value);
  const peer = open(value);
  await startSession();
  bridge(tab);
  relay(tab, peer);
  relay(peer, tab);
  caret(tab, 4);
  type(tab, "mine");
  expect(labels()).toEqual(["Edit"]);
  caret(peer, 1);
  type(peer, "theirs");
  relay(peer, tab);
  expect(text(tab)).toContain("theirs");
  expect(labels()).toEqual(["Edit"]);
  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toContain("theirs");
  expect(text(tab)).not.toContain("mine");
});

test("a step taken behind the timeline's back is skipped, and the press goes on to the next older entry", async () => {
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession();
  bridge(tab);
  caret(tab, 4);
  const skipped = watch("clay:undo-skipped");
  const refused = watch("clay:undo-refused");
  const kept = watch("clay:undo-kept");

  type(tab, "One. Two");
  expect(umOf(tab).undoStack.length).toBe(2);
  expect(tab.binding.undo()).toBe(true);
  expect(text(tab)).toBe("abcOne. ");

  const receipt = engine.undo();
  expect(receipt.ok).toBe(true);
  expect(text(tab)).toBe("abc");
  expect(skipped.length).toBe(1);
  expect(skipped[0].label).toBe("Edit");
  await settle();
  expect(refused).toEqual([]);
  expect(kept).toEqual([]);

  type(tab, "Three");
  expect(umOf(tab).undoStack.length).toBe(1);
  expect(tab.binding.undo()).toBe(true);
  expect(text(tab)).toBe("abc");
  const empty = engine.undo();
  expect(empty.ok).toBe(false);
  expect(empty.code).toBe("empty");
  expect(text(tab)).toBe("abc");
  expect(skipped.length).toBe(2);
  await settle();
  expect(refused).toEqual([]);
  expect(kept).toEqual([]);
});

test("a new step after an undo clears redo on both stacks", async () => {
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession();
  bridge(tab);
  caret(tab, 4);
  type(tab, "One. Two");
  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abcOne. ");
  type(tab, " Three");
  expect(text(tab)).toBe("abcOne.  Three");
  expect(engine.canRedo).toBe(false);
  expect(umOf(tab).redoStack.length).toBe(0);
  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abcOne. ");
  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abc");
});

test("recording and replaying a block step never marks the page dirty, and a plain page entry does", async () => {
  const note = side();
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession();
  bridge(tab);
  caret(tab, 4);

  const before = gateRevision();
  type(tab, "One. Two");
  expect(umOf(tab).undoStack.length).toBe(2);
  expect(engine.undo().ok).toBe(true);
  expect(engine.redo().ok).toBe(true);
  expect(gateRevision()).toBe(before);

  engine.commit("Rename side", () => { note.textContent = "changed"; });
  expect(gateRevision()).toBeGreaterThan(before);

  const plain = gateRevision();
  expect(engine.undo().ok).toBe(true);
  expect(engine.undo().label).toBe("Edit");
  expect(gateRevision()).toBeGreaterThan(plain);
});

test("a new adapter on the same editor skips the old entries instead of replaying them", async () => {
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession();
  const first = bridge(tab);
  caret(tab, 4);
  type(tab, "one");
  expect(labels()).toEqual(["Edit"]);
  first.dispose();

  umOf(tab).clear();
  umOf(tab).stopCapturing();
  bridge(tab);
  type(tab, "two");
  expect(text(tab)).toBe("abconetwo");
  expect(labels()).toEqual(["Edit", "Edit"]);

  const skipped = watch("clay:undo-skipped");
  const refused = watch("clay:undo-refused");
  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abcone");
  const stale = engine.undo();
  expect(stale.ok).toBe(false);
  expect(stale.code).toBe("empty");
  expect(text(tab)).toBe("abcone");
  expect(skipped.length).toBe(1);
  expect(refused).toEqual([]);
});

test("with no live undo session the adapter records nothing", async () => {
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  expect(engine.pageHistory).toBe(false);
  bridge(tab);
  caret(tab, 4);
  type(tab, "One. Two");
  expect(umOf(tab).undoStack.length).toBe(2);
  expect(engine.history).toEqual([]);
});

test("dispose removes the stack listener and the commit listener", async () => {
  const note = side();
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession();
  const adapter = bridge(tab);
  caret(tab, 4);
  type(tab, "one");
  expect(umOf(tab).undoStack.length).toBe(1);
  expect(labels()).toEqual(["Edit"]);

  adapter.dispose();
  type(tab, "two");
  expect(umOf(tab).undoStack.length).toBe(1);
  expect(labels()).toEqual(["Edit"]);

  engine.commit("Rename side", () => { note.textContent = "changed"; });
  expect(labels()).toEqual(["Edit", "Rename side"]);
  type(tab, "three");
  expect(text(tab)).toBe("abconetwothree");
  expect(umOf(tab).undoStack.length).toBe(1);
});

// Astra's counterexamples: the adapter must never replay a different step than the one the
// entry stands for, except in the one case Yjs itself moves the stack under an entry.
test("a peer erases the newest step: the owner's older text is never lost", async () => {
  const value = seedValue([{ id: "p", text: "abc" }]);
  const tab = open(value);
  const peer = open(value);
  await startSession();
  bridge(tab);
  relay(tab, peer);
  relay(peer, tab);

  caret(tab, 4);
  type(tab, "Alpha");
  umOf(tab).stopCapturing();
  type(tab, "Beta");
  expect(text(tab)).toBe("abcAlphaBeta");
  expect(labels()).toEqual(["Edit", "Edit"]);
  relay(tab, peer);
  expect(text(peer)).toBe("abcAlphaBeta");

  const um = umOf(tab);
  const before = um.undoStack.length;

  caret(peer, 9);
  peer.view.dispatch(peer.view.state.tr.delete(9, 13));
  relay(peer, tab);
  expect(text(tab)).toBe("abcAlpha");
  expect(um.undoStack.length).toBe(before);

  const skipped = watch("clay:undo-skipped");
  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abc");
  expect(skipped).toHaveLength(1);
  expect(text(tab)).not.toContain("Beta");

  engine.undo();
  expect(text(tab)).toBe("abc");
  relay(tab, peer);
  relay(peer, tab);
  expect(text(peer)).not.toContain("Beta");

  engine.redo();
  expect(text(tab)).toBe("abcAlpha");
  engine.redo();
  expect(text(tab)).not.toContain("Beta");
  engine.undo();
  engine.undo();
  expect(text(tab)).toBe("abc");
});

test("two table cells typed in undo and redo one step at a time, as the editor's own calls do", async () => {
  const value = migrateHybridValues([{
    blocks: {
      tbl: {
        t: "table", pos: "A",
        cols: { c1: { pos: "1", name: "Name" } },
        rows: { r1: { pos: "1", cells: { c1: "" } }, r2: { pos: "2", cells: { c1: "" } } },
      },
    },
  }]);
  const plugins = [historyIntentPlugin(), tablePlugin()];
  const cellPositions = (tab) => {
    const out = [];
    tab.view.state.doc.descendants((node, pos) => { if (node.type.name === "table_cell") out.push(pos + 1); });
    return out;
  };
  const run = (tab) => {
    const [first] = cellPositions(tab);
    caret(tab, first);
    type(tab, "abc");
    caret(tab, cellPositions(tab)[1]);
    type(tab, "def");
  };

  const tab = open(value, { plugins });
  const control = open(value, { plugins });
  await startSession();
  bridge(tab);
  run(tab);
  run(control);
  expect(shape(tab)).toBe(shape(control));

  for (let press = 0; press < 2; press++) {
    expect(control.binding.undo()).toBe(true);
    expect(engine.undo().ok).toBe(true);
    expect(shape(tab)).toBe(shape(control));
  }
  for (let press = 0; press < 2; press++) {
    expect(control.binding.redo()).toBe(true);
    expect(engine.redo().ok).toBe(true);
    expect(shape(tab)).toBe(shape(control));
  }
});

test("a block move then typing undo and redo as the editor's own calls do", async () => {
  const value = seedValue([{ id: "p", text: "abc" }, { id: "q", text: "Quinn" }]);
  const posOf = (tab, id) => {
    let found = null;
    tab.view.state.doc.forEach((node, offset) => { if (node.attrs.id === id) found = offset + 1; });
    return found;
  };
  const run = (tab) => {
    caret(tab, 4);
    type(tab, "ab");
    tab.binding.moveBlocks({ ids: ["q"], afterId: null });
    caret(tab, posOf(tab, "p") + 2);
    type(tab, "cd");
  };

  const tab = open(value);
  const control = open(value);
  await startSession();
  bridge(tab);
  run(tab);
  run(control);
  expect(shape(tab)).toBe(shape(control));
  expect(ids(tab)).toEqual(["q", "p"]);

  for (let press = 0; press < 2; press++) {
    expect(control.binding.undo()).toBe(true);
    expect(engine.undo().ok).toBe(true);
    expect(shape(tab)).toBe(shape(control));
  }
  for (let press = 0; press < 2; press++) {
    expect(control.binding.redo()).toBe(true);
    expect(engine.redo().ok).toBe(true);
    expect(shape(tab)).toBe(shape(control));
  }
});

test("an adapter made before the session starts follows it, and a page commit then seals its open step", async () => {
  const note = side();
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  expect(engine.pageHistory).toBe(false);
  bridge(tab);
  caret(tab, 4);
  await startSession();

  type(tab, "one");
  expect(umOf(tab).undoStack.length).toBe(1);
  expect(labels()).toEqual(["Edit"]);

  engine.commit("Rename side", () => { note.textContent = "changed"; });
  type(tab, "two");
  expect(text(tab)).toBe("abconetwo");
  expect(umOf(tab).undoStack.length).toBe(2);
  expect(labels()).toEqual(["Edit", "Rename side", "Edit"]);

  expect(engine.undo().label).toBe("Edit");
  expect(text(tab)).toBe("abcone");
  expect(engine.undo().label).toBe("Rename side");
  expect(note.textContent).toBe("side");
  expect(engine.undo().label).toBe("Edit");
  expect(text(tab)).toBe("abc");
});
