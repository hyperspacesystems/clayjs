globalThis.ClipboardEvent ??= class ClipboardEvent extends Event {};

import { jest } from "@jest/globals";
import * as Y from "../../../src/vendor/yjs.vendor.js";
import { createStore } from "../../../src/live/store.js";
import { identityPlugin } from "../../../src/page/model.js";
import { state as pmState, view as pmView } from "../../../src/vendor/prosemirror.vendor.js";
import { createYPageBinding, seedValue } from "../../../src/page/ybind/index.js";
import { NET } from "../../../src/page/ybind/layout.js";
import { historyIntentPlugin, createHistoryBridge } from "../../../src/page/history-intent.js";
import { undo as engine, undoParticipant } from "../../../src/plugins/undo.js";

window.clay = { ...(window.clay || {}), undo: engine };
let clock = 1000000;
beforeEach(() => { jest.spyOn(Date, "now").mockImplementation(() => clock); });
const opened = [];
const leases = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const lease of leases.splice(0)) lease.dispose();
  engine.stop();
  for (const { view, binding, mount } of opened.splice(0)) { view.destroy(); binding.dispose(); binding.ydoc.destroy(); mount.remove(); }
  document.body.replaceChildren();
});
function open(value) {
  const store = createStore({ name: "blockeditor", value: JSON.parse(JSON.stringify(value)) });
  const binding = createYPageBinding({ store, captureTimeout: 0 });
  const article = document.body.appendChild(document.createElement("article"));
  const mount = article.appendChild(document.createElement("div"));
  mount.setAttribute("no-undo", "");
  const view = new pmView.EditorView(mount, {
    state: pmState.EditorState.create({ doc: binding.doc(), plugins: [identityPlugin(), historyIntentPlugin()] }),
    dispatchTransaction: (tr) => binding.dispatch(tr),
  });
  binding.attach(view);
  const tab = { store, binding, view, mount, article };
  opened.push(tab);
  return tab;
}
const start = async (tab) => {
  const lease = await undoParticipant().prepare({ generation: 1, isCurrent: () => true });
  lease.enable(); leases.push(lease);
  return createHistoryBridge({ um: tab.binding.bridge.um, undo: () => tab.binding.undo(), redo: () => tab.binding.redo(), article: tab.article, focus: () => tab.view.focus() });
};
const blocks = (tab) => { const out = []; tab.view.state.doc.forEach((n) => out.push(`${n.attrs.id}:${n.textContent}`)); return out.join(" | "); };
const endOf = (tab, id) => { let end = null; tab.view.state.doc.forEach((node, offset) => { if (node.attrs.id === id) end = offset + 1 + node.content.size; }); return end; };
const caret = (tab, pos) => tab.view.dispatch(tab.view.state.tr.setSelection(pmState.TextSelection.create(tab.view.state.doc, pos)));
const type = (tab, chars) => { for (const ch of chars) { const { from, to } = tab.view.state.selection; tab.view.someProp("handleTextInput", (f) => f(tab.view, from, to, ch, () => tab.view.state.tr.insertText(ch, from, to))); } };
const where = (tab) => `${tab.view.state.selection.$from.parent.attrs.id}@${tab.view.state.selection.$from.parentOffset}`;

test("two editor steps inside one page command are one entry that undoes and redoes both", async () => {
  const tab = open(seedValue([{ id: "p", text: "abc" }]));
  await start(tab);
  caret(tab, 4);
  const receipt = engine.command("Two steps", () => {
    type(tab, "One");
    tab.binding.bridge.um.stopCapturing();
    caret(tab, 7);
    type(tab, "Two");
  });
  expect(tab.binding.bridge.um.undoStack.length).toBe(2);
  expect(engine.history.map((entry) => entry.label)).toEqual(["Two steps"]);
  expect(engine.describe(receipt.id).steps.map((step) => step.prop.replace(/:[a-z0-9]+:/, ":E:"))).toEqual(["blockeditor-step:E:1", "blockeditor-step:E:2"]);
  expect(engine.undo().ok).toBe(true);
  expect(blocks(tab)).toBe("p:abc");
  expect(tab.binding.bridge.um.undoStack.length).toBe(0);
  expect(engine.redo().ok).toBe(true);
  expect(blocks(tab)).toBe("p:abcOneTwo");
  expect(tab.binding.bridge.um.undoStack.length).toBe(2);
  expect(engine.undo().ok).toBe(true);
  expect(blocks(tab)).toBe("p:abc");
});

test("with a side field focused, undo of an article step moves focus to the article and the caret to the change", async () => {
  const side = document.body.appendChild(document.createElement("p"));
  side.setAttribute("contenteditable", "true");
  side.textContent = "side";
  const tab = open(seedValue([{ id: "p", text: "abc" }, { id: "q", text: "second" }]));
  await start(tab);
  caret(tab, 4); type(tab, "Alpha");
  caret(tab, endOf(tab, "q"));
  side.focus();
  expect(document.activeElement).toBe(side);
  expect(engine.undo().ok).toBe(true);
  expect(blocks(tab)).toBe("p:abc | q:second");
  expect(where(tab)).toBe("p@3");
  expect(document.activeElement).toBe(tab.view.dom);
  expect(engine.redo().ok).toBe(true);
  expect(where(tab)).toBe("p@8");
});

test("with the article focused, undo and redo keep focus and put the caret at the change", async () => {
  const tab = open(seedValue([{ id: "p", text: "abc" }, { id: "q", text: "second" }]));
  await start(tab);
  tab.view.focus();
  caret(tab, 4); type(tab, "Alpha");
  caret(tab, endOf(tab, "q"));
  expect(engine.undo().ok).toBe(true);
  expect(where(tab)).toBe("p@3");
  expect(document.activeElement).toBe(tab.view.dom);
  expect(engine.redo().ok).toBe(true);
  expect(where(tab)).toBe("p@8");
});

test("the editor's own undo, with no page session, also leaves the caret at the change", async () => {
  const tab = open(seedValue([{ id: "p", text: "abc" }, { id: "q", text: "second" }]));
  caret(tab, 4); type(tab, "Alpha");
  caret(tab, endOf(tab, "q"));
  tab.view.focus();
  expect(tab.binding.undo()).toBe(true);
  expect(where(tab)).toBe("p@3");
});

test("a step emptied by a peer below a live one: the press undoes the live one, the next press skips the dead one", async () => {
  const value = seedValue([{ id: "p", text: "abc" }]);
  const tab = open(value), peer = open(value);
  await start(tab);
  const relay = (from, to) => Y.applyUpdateV2(to.binding.ydoc, Y.encodeStateAsUpdateV2(from.binding.ydoc), NET);
  relay(tab, peer); relay(peer, tab);
  caret(tab, 4); type(tab, "Alpha");
  tab.binding.bridge.um.stopCapturing(); type(tab, "Beta");
  tab.binding.bridge.um.stopCapturing(); type(tab, "Gamma");
  relay(tab, peer);
  peer.view.dispatch(peer.view.state.tr.delete(9, 13));
  relay(peer, tab);
  const stacks = () => `${tab.binding.bridge.um.undoStack.length}/${tab.binding.bridge.um.redoStack.length}`;
  expect(stacks()).toBe("3/0");
  engine.undo();
  expect(`${blocks(tab)} ${stacks()}`).toBe("p:abcAlpha 2/1");
  engine.undo();
  expect(`${blocks(tab)} ${stacks()}`).toBe("p:abc 0/2");
  engine.redo();
  expect(`${blocks(tab)} ${stacks()}`).toBe("p:abcAlpha 1/1");
  engine.redo();
  expect(`${blocks(tab)} ${stacks()}`).toBe("p:abcAlphaGamma 2/0");
  expect(engine.canRedo).toBe(false);
});

test("a page command with two editor steps is all or nothing: a peer erases one step, the entry is skipped whole", async () => {
  const value = seedValue([{ id: "p", text: "abc" }]);
  const tab = open(value), peer = open(value);
  await start(tab);
  const relay = (from, to) => Y.applyUpdateV2(to.binding.ydoc, Y.encodeStateAsUpdateV2(from.binding.ydoc), NET);
  relay(tab, peer); relay(peer, tab);
  let skipped = 0;
  const onSkipped = () => { skipped += 1; };
  document.addEventListener("clay:undo-skipped", onSkipped);
  caret(tab, 4);
  engine.command("Two steps", () => {
    type(tab, "One");
    tab.binding.bridge.um.stopCapturing();
    caret(tab, 7);
    type(tab, "Two");
  });
  relay(tab, peer);
  peer.view.dispatch(peer.view.state.tr.delete(4, 7));
  relay(peer, tab);
  expect(blocks(tab)).toBe("p:abcTwo");
  expect(engine.undo().code).toBe("empty");
  document.removeEventListener("clay:undo-skipped", onSkipped);
  expect(skipped).toBe(1);
  expect(blocks(tab)).toBe("p:abcTwo");
  expect(tab.binding.bridge.um.undoStack.length).toBe(1);
  expect(tab.binding.bridge.um.redoStack.length).toBe(0);
  relay(tab, peer);
  expect(blocks(peer)).toBe("p:abcTwo");
});
