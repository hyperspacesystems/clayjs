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


test("A1 an emptied article step is skipped in the same press", async () => {
  const value = seedValue([{ id: "p", text: "abc" }]);
  const tab = open(value), peer = open(value);
  await startSession();
  bridge(tab);
  relay(tab, peer); relay(peer, tab);
  caret(tab, 4); type(tab, "Alpha");
  umOf(tab).stopCapturing(); type(tab, "Beta");
  relay(tab, peer);
  peer.view.dispatch(peer.view.state.tr.delete(9, 13));
  relay(peer, tab);
  expect(text(tab)).toBe("abcAlpha");
  const skipped = watch("clay:undo-skipped");
  const receipt = engine.undo();
  expect({ text: text(tab), skipped: skipped.length, ok: receipt.ok })
    .toEqual({ text: "abc", skipped: 1, ok: true });
});

test("A2 peer deletion between Undo and Redo retains all remaining redo text", async () => {
  const value = seedValue([{ id: "p", text: "abcAlphaBeta" }]);
  const tab = open(value), peer = open(value);
  await startSession();
  bridge(tab);
  relay(tab, peer); relay(peer, tab);
  tab.view.dispatch(tab.view.state.tr.delete(4, 9));
  tab.view.dispatch(tab.view.state.tr.delete(4, 8));
  expect(text(tab)).toBe("abc");
  expect(umOf(tab).undoStack).toHaveLength(2);
  expect(engine.undo().ok).toBe(true);
  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abcAlphaBeta");
  relay(tab, peer);
  peer.view.dispatch(peer.view.state.tr.delete(4, 9));
  relay(peer, tab);
  expect(text(tab)).toBe("abcBeta");
  engine.redo();
  engine.redo();
  expect({ text: text(tab), canRedo: engine.canRedo })
    .toEqual({ text: "abc", canRedo: false });
});

test("A3 article undo keeps a non-field button focused", async () => {
  const button = document.body.appendChild(document.createElement("button"));
  button.textContent = "Undo";
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession(); bridge(tab);
  caret(tab, 4); type(tab, "Alpha");
  button.focus();
  expect(document.activeElement).toBe(button);
  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abc");
  expect(document.activeElement).toBe(button);
});

test("A4 a rapid outside plain field edit splits the next article typing step", async () => {
  const note = side();
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession(); bridge(tab);
  caret(tab, 4); type(tab, "Alpha");
  note.setAttribute("contenteditable", "true");
  note.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "outside", bubbles: true }));
  note.firstChild.data = "outside";
  note.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "outside", bubbles: true }));
  tab.view.dom.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "B", bubbles: true }));
  type(tab, "Beta");
  engine.flush();
  expect(text(tab)).toBe("abcAlphaBeta");
  expect(engine.undo().ok).toBe(true);
  expect({ article: text(tab), outside: note.textContent }).toEqual({ article: "abcAlpha", outside: "outside" });
});


test("A5 peer table overwrite after undo never discards the other cell redo", async () => {
  const value = migrateHybridValues([{ blocks: { tbl: { t: "table", pos: "A",
    cols: { c1: { pos: "1", name: "Name" } },
    rows: { r1: { pos: "1", cells: { c1: "first" } }, r2: { pos: "2", cells: { c1: "second" } } },
  } } }]);
  const plugins = [historyIntentPlugin(), tablePlugin()];
  const tab = open(value, { plugins }), peer = open(value, { plugins });
  const cells = t => {
    const out = [];
    t.view.state.doc.descendants((node, pos) => { if (node.type.name === "table_cell") out.push({ text: node.textContent, pos: pos + 1 }); });
    return out;
  };
  await startSession(); bridge(tab);
  relay(tab, peer); relay(peer, tab);
  caret(tab, cells(tab)[0].pos + 5); type(tab, "Alpha");
  caret(tab, cells(tab)[1].pos + 6); type(tab, "Beta");
  expect(cells(tab).map(c => c.text)).toEqual(["firstAlpha", "secondBeta"]);
  expect(engine.undo().ok).toBe(true);
  expect(engine.undo().ok).toBe(true);
  expect(cells(tab).map(c => c.text)).toEqual(["first", "second"]);
  relay(tab, peer);
  caret(peer, cells(peer)[0].pos + 5); type(peer, "Peer");
  relay(peer, tab);
  expect(cells(tab).map(c => c.text)).toEqual(["firstPeer", "second"]);
  const skipped = watch("clay:undo-skipped");
  const receipts = [engine.redo(), engine.redo()];
  console.log("A5 REDO", JSON.stringify({ receipts, cells: cells(tab).map(c => c.text), editorRedo: umOf(tab).redoStack.length }));
  const afterPageRedo = cells(tab).map(c => c.text);
  expect(engine.canRedo).toBe(false);
  expect(skipped).toHaveLength(1);
  expect(receipts[0].ok).toBe(true);
  expect(umOf(tab).redoStack).toHaveLength(0);
  expect(tab.binding.redo()).toBe(false);
  expect(cells(tab).map(c => c.text)).toEqual(["firstPeer", "secondBeta"]);
  expect(afterPageRedo).toEqual(["firstPeer", "secondBeta"]);
});

test("A6 article undo places selection at changed paragraph after a caret move", async () => {
  const tab = open(seedValue([{ id: "p", text: "abc" }, { id: "q", text: "second" }]));
  await startSession(); bridge(tab);
  caret(tab, 4); type(tab, "Alpha");
  const secondPos = tab.view.state.doc.child(0).nodeSize + 2;
  caret(tab, secondPos);
  expect(tab.view.state.selection.$from.parent.attrs.id).toBe("q");
  tab.view.focus();
  expect(document.activeElement).toBe(tab.view.dom);
  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abc");
  expect(tab.view.state.selection.$from.parent.attrs.id).toBe("p");
});


test.each(["article", "side", "button"])("undo and redo caret policy with %s focused", async (focused) => {
  const tab = open(seedValue([{ id: "p", text: "abc" }, { id: "q", text: "second" }]));
  const other = document.body.appendChild(document.createElement(focused === "button" ? "button" : "p"));
  if (focused === "side") other.setAttribute("contenteditable", "true");
  await startSession(); bridge(tab);
  caret(tab, 4); type(tab, "Alpha");
  const focusAway = () => {
    caret(tab, tab.view.state.doc.child(0).nodeSize + 2);
    if (focused === "article") tab.view.focus();
    else other.focus();
  };
  for (const direction of ["undo", "redo"]) {
    focusAway();
    expect(engine[direction]().ok).toBe(true);
    expect(text(tab)).toBe(direction === "undo" ? "abc" : "abcAlpha");
    expect(document.activeElement).toBe(focused === "button" ? other : tab.view.dom);
    if (focused !== "button") {
      expect(tab.view.state.selection.$from.parent.attrs.id).toBe("p");
      expect(tab.view.state.selection.from).toBe(direction === "undo" ? 4 : 9);
    }
  }
});


test("an app command containing two editor steps keeps both identities", async () => {
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession(); bridge(tab);
  engine.command("Write two sentences", () => {
    caret(tab, 4); type(tab, "One. Two.");
  });
  expect(text(tab)).toBe("abcOne. Two.");
  expect(umOf(tab).undoStack).toHaveLength(2);
  expect(engine.history).toHaveLength(1);
  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abc");
  expect(engine.redo().ok).toBe(true);
  expect(text(tab)).toBe("abcOne. Two.");
});


test("repeated local map writes retain every undo and redo", async () => {
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession(); bridge(tab);
  const kind = () => tab.view.state.doc.child(0).attrs.level ?? "paragraph";
  for (const level of [2, 3, 4]) {
    tab.view.dispatch(tab.view.state.tr.setNodeMarkup(0, tab.view.state.schema.nodes.heading, { ...tab.view.state.doc.child(0).attrs, level }));
    umOf(tab).stopCapturing();
  }
  for (const level of [3, 2, "paragraph"]) {
    expect(engine.undo().ok).toBe(true);
    expect(kind()).toBe(level);
  }
  for (const level of [2, 3, 4]) {
    expect(engine.redo().ok).toBe(true);
    expect(kind()).toBe(level);
  }
});
