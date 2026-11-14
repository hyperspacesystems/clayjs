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
import { schema } from "../../../src/page/schema.js";

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

// Break-it cases for the block editor adapter (M7). Each one compares the page history with
// the editor's own undo and redo on a control editor that sees the same edits.

const three = async () => {
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
  umOf(tab).stopCapturing();
  type(tab, "Gamma");
  expect(text(tab)).toBe("abcAlphaBetaGamma");
  expect(labels()).toEqual(["Edit", "Edit", "Edit"]);
  relay(tab, peer);
  peer.view.dispatch(peer.view.state.tr.delete(9, 13));
  relay(peer, tab);
  expect(text(tab)).toBe("abcAlphaGamma");
  return { tab, peer };
};

test("control: the editor's own undo and redo bring the newest sentence back after a peer erased the middle one", async () => {
  const value = seedValue([{ id: "p", text: "abc" }]);
  const tab = open(value);
  const peer = open(value);
  relay(tab, peer);
  relay(peer, tab);
  caret(tab, 4);
  type(tab, "Alpha");
  umOf(tab).stopCapturing();
  type(tab, "Beta");
  umOf(tab).stopCapturing();
  type(tab, "Gamma");
  relay(tab, peer);
  peer.view.dispatch(peer.view.state.tr.delete(9, 13));
  relay(peer, tab);
  expect(text(tab)).toBe("abcAlphaGamma");
  tab.binding.undo();
  tab.binding.undo();
  tab.binding.redo();
  tab.binding.redo();
  expect(text(tab)).toBe("abcAlphaGamma");
});

test("BREAK 1: a peer erases the middle step; undo twice then redo twice loses the owner's newest sentence", async () => {
  const { tab } = await three();
  const skipped = watch("clay:undo-skipped");
  const kept = watch("clay:undo-kept");

  expect(engine.undo().ok).toBe(true);
  expect(text(tab)).toBe("abcAlpha");
  engine.undo();
  expect(text(tab)).toBe("abc");

  engine.redo();
  const last = engine.redo();
  await settle();
  expect({ text: text(tab), skipped: skipped.length, kept: kept.length, last: last.ok }).toEqual({ text: "abcAlphaGamma", skipped: 1, kept: 0, last: true });
});

test("BREAK 1b: the same, undone all the way and redone all the way", async () => {
  const { tab } = await three();
  engine.undo();
  engine.undo();
  engine.undo();
  expect(text(tab)).toBe("abc");
  engine.redo();
  engine.redo();
  engine.redo();
  expect(text(tab)).toBe("abcAlphaGamma");
});

// The mirror case on redo. Undoing a block's type change and then having a peer set that
// block's type makes the redo item for the type change conflict: Yjs's own redo passes over
// it and redoes the next item in the same call.
const setLevel = (tab, level) => {
  const node = tab.view.state.doc.child(0);
  tab.view.dispatch(tab.view.state.tr.setNodeMarkup(0, schema.nodes.heading, { ...node.attrs, level }));
};
const kind = (tab) => { const n = tab.view.state.doc.child(0); return `${n.type.name}${n.attrs.level ?? ""}`; };

const mirror = async (withBridge) => {
  const value = seedValue([{ id: "p", text: "abc" }]);
  const tab = open(value);
  const peer = open(value);
  if (withBridge) {
    await startSession();
    bridge(tab);
  }
  relay(tab, peer);
  relay(peer, tab);
  setLevel(tab, 2);
  umOf(tab).stopCapturing();
  caret(tab, 4);
  type(tab, "Alpha");
  expect(`${kind(tab)} ${text(tab)}`).toBe("heading2 abcAlpha");
  return { tab, peer };
};

test("control: the editor's own redo passes over a type change a peer overwrote and brings the typed word back", async () => {
  const { tab, peer } = await mirror(false);
  tab.binding.undo();
  tab.binding.undo();
  expect(`${kind(tab)} ${text(tab)}`).toBe("paragraph abc");
  relay(tab, peer);
  setLevel(peer, 3);
  relay(peer, tab);
  expect(`${kind(tab)} ${text(tab)}`).toBe("heading3 abc");
  tab.binding.redo();
  expect(`${kind(tab)} ${text(tab)}`).toBe("heading3 abcAlpha");
});

test("BREAK 2: the mirror case on redo: a peer overwrites the step under the newest one, and the owner's word never comes back", async () => {
  const { tab, peer } = await mirror(true);
  expect(labels()).toEqual(["Edit", "Edit"]);
  const skipped = watch("clay:undo-skipped");
  const kept = watch("clay:undo-kept");
  engine.undo();
  engine.undo();
  expect(`${kind(tab)} ${text(tab)}`).toBe("paragraph abc");
  relay(tab, peer);
  setLevel(peer, 3);
  relay(peer, tab);
  expect(`${kind(tab)} ${text(tab)}`).toBe("heading3 abc");

  engine.redo();
  engine.redo();
  engine.redo();
  await settle();
  expect({ text: text(tab), skipped: skipped.length, kept: kept.length, canRedo: engine.canRedo, editorRedo: umOf(tab).redoStack.length })
    .toEqual({ text: "abcAlpha", skipped: 1, kept: 0, canRedo: false, editorRedo: 0 });
});

test("BREAK 3: a page undo of an article step focuses the article although no field had focus", async () => {
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await startSession();
  const focused = [];
  const made = createHistoryBridge({
    um: tab.binding.bridge.um,
    undo: () => tab.binding.undo(),
    redo: () => tab.binding.redo(),
    article: tab.article,
    focus: () => focused.push(document.activeElement === document.body ? "nothing had focus" : "a field had focus"),
  });
  caret(tab, 4);
  type(tab, "Alpha");
  expect(labels()).toEqual(["Edit"]);
  document.activeElement?.blur?.();
  expect(document.activeElement).toBe(document.body);

  engine.undo();
  expect(text(tab)).toBe("abc");
  expect(focused).toEqual([]);
  made.dispose?.();
});

test("BREAK 4: the article: typing that starts with a space after a finished sentence makes a step that holds only the space", async () => {
  const tab = open(seedValue([{ id: "p", text: "Done." }]));
  await startSession();
  bridge(tab);
  caret(tab, 6);
  type(tab, " More words");
  expect(text(tab)).toBe("Done. More words");
  const states = [];
  while (engine.canUndo) {
    engine.undo();
    states.push(text(tab));
  }
  expect(states).toEqual(["Done."]);
});
