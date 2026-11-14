globalThis.ClipboardEvent ??= class ClipboardEvent extends Event {};

import * as Y from "../../../../src/vendor/yjs.vendor.js";
import { identityPlugin } from "../../../../src/page/model.js";
import { schema } from "../../../../src/page/schema.js";
import { state as pmState, view as pmView } from "../../../../src/vendor/prosemirror.vendor.js";
import { createPageDoc, createBridge, keepViewPos, seedFrom, docOf, walk, blocksFromYValue, authorKey, parseGoneIntents } from "../../../../src/page/ybind/index.js";
import { NET } from "../../../../src/page/ybind/layout.js";
import { createOriginIndex } from "../../../../src/page/ybind/origins.js";
import { createProjectionMap } from "../../../../src/page/ybind/projection-map.js";
import { yValueOf } from "../../../../src/page/ybind/provider.js";

const A = 300, B = 100, C = 200;

const seed = (blocks) => {
  const pd = createPageDoc(new Y.Doc());
  pd.ydoc.clientID = 1;
  seedFrom(pd, blocks);
  return Y.encodeStateAsUpdateV2(pd.ydoc);
};

const opened = [];
afterEach(() => {
  for (const { view, bridge, mount } of opened.splice(0)) {
    view.destroy();
    bridge.dispose();
    bridge.pd.ydoc.destroy();
    mount.remove();
  }
});

function open(update, client) {
  const doc = new Y.Doc();
  doc.clientID = client;
  Y.applyUpdateV2(doc, update);
  const pd = createPageDoc(doc);
  pd.ydoc.transact(() => pd.origins.set(authorKey(client), `T${client}`), NET);
  const stats = { groups: 0, mismatch: 0, renders: 0, first: null, proveWalks: true };
  const bridge = createBridge({ pd, stats, captureTimeout: 0 });
  const mount = document.body.appendChild(document.createElement("div"));
  const view = new pmView.EditorView(mount, {
    state: pmState.EditorState.create({ doc: keepViewPos(docOf(pd, walk(pd))), plugins: [identityPlugin()] }),
    dispatchTransaction: (tr) => bridge.dispatch(tr),
  });
  bridge.attach(view);
  const tab = { pd, bridge, stats, view, mount, client };
  opened.push(tab);
  return tab;
}

const send = (from, to) => Y.applyUpdateV2(to.pd.ydoc, Y.encodeStateAsUpdateV2(from.pd.ydoc), NET);
const exchange = (tabs) => { for (const from of tabs) for (const to of tabs) if (to !== from) send(from, to); };
const settle = (tabs) => { exchange(tabs); exchange(tabs); };
const rows = (tab) => { const out = []; tab.view.state.doc.forEach((node) => out.push([node.attrs.id, node.type.name, node.textContent])); return out; };
const nested = (tab) => { const out = []; tab.view.state.doc.forEach((node) => out.push([node.attrs.id, node.attrs.parent ?? null, node.textContent])); return out; };
const spans = (tab, id) => {
  const out = [];
  tab.view.state.doc.forEach((node) => {
    if (node.attrs.id !== id) return;
    node.forEach((child) => out.push([child.text, child.marks.map((mark) => (mark.type.name === "link" ? `link:${mark.attrs.href}` : mark.type.name)).sort().join("+")]));
  });
  return out;
};
const reloaded = (pd) => {
  const doc = new Y.Doc();
  doc.clientID = 401;
  Y.applyUpdateV2(doc, Y.encodeStateAsUpdateV2(pd.ydoc));
  return Object.entries(blocksFromYValue(yValueOf(doc))).sort((left, right) => (left[1].pos < right[1].pos ? -1 : 1)).map(([id, block]) => [id, block.t, block.c]);
};
const aside = (tab) => tab.bridge.recoverable.map((record) => record.blocks.flatMap((block) => block.runs).filter((run) => run.displaced).map((run) => run.text));
const agreed = (tabs, expected, words = []) => {
  for (const tab of tabs) {
    expect(tab.stats.mismatch).toBe(0);
    expect(tab.stats.walkMismatch ?? 0).toBe(0);
    expect(rows(tab)).toEqual(expected);
    expect(reloaded(tab.pd)).toEqual(expected);
    if (words.length) expect(aside(tab)).toEqual(words);
    else {
      expect(tab.bridge.recoverable).toEqual([]);
      expect(tab.bridge.notices).toEqual([]);
    }
    expect(() => createProjectionMap(walk(tab.pd), tab.pd.flow.length)).not.toThrow();
  }
  const states = tabs.map((tab) => JSON.stringify(tab.pd.flow.toDelta()));
  for (const state of states) expect(state).toBe(states[0]);
  return tabs.map((tab) => tab.bridge.notices.length);
};
const posIn = (tab, id, offset) => { let pos = null; tab.view.state.doc.forEach((node, at) => { if (node.attrs.id === id) pos = at + 1 + offset; }); return pos; };
const type = (tab, id, offset, chars) => tab.view.dispatch(tab.view.state.tr.insertText(chars, posIn(tab, id, offset)));
const erase = (tab, id, from, to) => tab.view.dispatch(tab.view.state.tr.delete(posIn(tab, id, from), posIn(tab, id, to)));
const mark = (tab, id, from, to, value) => tab.view.dispatch(tab.view.state.tr.addMark(posIn(tab, id, from), posIn(tab, id, to), value));

// Who the visible text is attributed to: the author token of the client its origin record resolves to.
const authorsOf = (tab, chars) => {
  const index = createOriginIndex(tab.pd.origins);
  const out = new Set();
  try {
    for (let it = tab.pd.flow._start; it; it = it.right) {
      if (it.deleted || !(it.content instanceof Y.ContentString)) continue;
      for (let offset = 0; offset < it.length; offset++) {
        if (!chars.includes(it.content.str[offset])) continue;
        const source = index.resolve({ client: it.id.client, clock: it.id.clock + offset });
        out.add(tab.pd.origins.get(authorKey(source.client)) ?? null);
      }
    }
  } finally {
    index.dispose();
  }
  return [...out];
};

const knownKeys = (pd) => {
  const kinds = new Set();
  for (const key of pd.origins.keys()) kinds.add(JSON.parse(key)[0]);
  parseGoneIntents(pd.gone, { strict: true });
  return [...kinds].sort();
};

const START = [{ id: "p", text: "ALPHA" }, { id: "q", text: "bravo" }, { id: "r", text: "OMEGA" }];
const P = ["p", "paragraph", "ALPHA"], R = ["r", "paragraph", "OMEGA"];

for (const order of ["after the peer edit", "crossing the peer edit"]) {
  test(`Undo of a move ${order} carries words typed at the start, the middle and the end of the copy to the same places in the original`, () => {
    const update = seed(START);
    const a = open(update, A), b = open(update, B), c = open(update, C);
    const tabs = [a, b, c];
    expect(a.bridge.moveBlocks({ ids: ["q"], afterId: "r" })).toEqual({ status: "moved", ids: ["q"] });
    exchange(tabs);
    agreed(tabs, [P, R, ["q", "paragraph", "bravo"]]);

    type(b, "q", 5, "789");
    type(b, "q", 2, "456");
    type(b, "q", 0, "123");
    if (order === "after the peer edit") send(b, a);
    expect(a.bridge.undo()).toBe(true);
    settle(tabs);
    agreed(tabs, [P, ["q", "paragraph", "123br456avo789"], R]);
    for (const tab of tabs) {
      expect(authorsOf(tab, "123456789")).toEqual([`T${B}`]);
      expect(knownKeys(tab.pd)).toEqual(["author", "boundary", "span"]);
    }

    expect(a.bridge.redo()).toBe(true);
    settle(tabs);
    agreed(tabs, [P, R, ["q", "paragraph", "123br456avo789"]]);
    for (const tab of tabs) expect(authorsOf(tab, "123456789")).toEqual([`T${B}`]);

    expect(a.bridge.undo()).toBe(true);
    settle(tabs);
    agreed(tabs, [P, ["q", "paragraph", "123br456avo789"], R]);
  });
}

test("Undo of a move keeps the marks of words a peer typed inside bold text and inside a link", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B);
  const tabs = [a, b];
  const link = schema.marks.link.create({ href: "https://example.com" });
  mark(a, "q", 1, 3, schema.marks.strong.create());
  mark(a, "q", 3, 5, link);
  a.bridge.um.clear();
  exchange(tabs);
  expect(spans(a, "q")).toEqual([["b", ""], ["ra", "strong"], ["vo", "link:https://example.com"]]);

  expect(a.bridge.moveBlocks({ ids: ["q"], afterId: "r" })).toEqual({ status: "moved", ids: ["q"] });
  exchange(tabs);
  type(b, "q", 2, "Y");
  b.view.dispatch(b.view.state.tr.insert(posIn(b, "q", 5), schema.text("Z", [link])));
  b.view.dispatch(b.view.state.tr.insert(posIn(b, "q", 7), schema.text("W")));
  exchange(tabs);
  const moved = [["b", ""], ["rYa", "strong"], ["vZo", "link:https://example.com"], ["W", ""]];
  for (const tab of tabs) expect(spans(tab, "q")).toEqual(moved);

  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, ["q", "paragraph", "brYavZoW"], R]);
  for (const tab of tabs) expect(spans(tab, "q")).toEqual(moved);

  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, R, ["q", "paragraph", "brYavZoW"]]);
  for (const tab of tabs) expect(spans(tab, "q")).toEqual(moved);
});

for (const order of ["after the peer edit", "crossing the peer edit"]) {
  test(`Undo of a move ${order} does not bring back text the peer deleted from the copy`, () => {
    const update = seed(START);
    const a = open(update, A), b = open(update, B), c = open(update, C);
    const tabs = [a, b, c];
    a.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
    exchange(tabs);
    erase(b, "q", 2, 4);
    type(b, "q", 1, "Y");
    exchange([b, c]);
    if (order === "after the peer edit") send(b, a);
    expect(a.bridge.undo()).toBe(true);
    settle(tabs);
    agreed(tabs, [P, ["q", "paragraph", "bYro"], R]);

    expect(a.bridge.redo()).toBe(true);
    settle(tabs);
    agreed(tabs, [P, R, ["q", "paragraph", "bYro"]]);

    expect(a.bridge.undo()).toBe(true);
    settle(tabs);
    agreed(tabs, [P, ["q", "paragraph", "bYro"], R]);
  });
}

test("Undo of two moves in a row carries the peer words back each time, and Redo sets aside only a word typed between the two Undos", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B), c = open(update, C);
  const tabs = [a, b, c];
  a.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  a.bridge.moveBlocks({ ids: ["q"], afterId: null });
  exchange(tabs);
  agreed(tabs, [["q", "paragraph", "bravo"], P, R]);

  type(b, "q", 3, "Y");
  type(b, "r", 5, "!");
  type(c, "p", 0, "?");
  exchange(tabs);
  agreed(tabs, [["q", "paragraph", "braYvo"], ["p", "paragraph", "?ALPHA"], ["r", "paragraph", "OMEGA!"]]);

  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [["p", "paragraph", "?ALPHA"], ["r", "paragraph", "OMEGA!"], ["q", "paragraph", "braYvo"]]);

  type(c, "q", 6, "Z");
  exchange(tabs);
  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [["p", "paragraph", "?ALPHA"], ["q", "paragraph", "braYvoZ"], ["r", "paragraph", "OMEGA!"]]);
  for (const tab of tabs) {
    expect(authorsOf(tab, "Y")).toEqual([`T${B}`]);
    expect(authorsOf(tab, "Z")).toEqual([`T${C}`]);
  }

  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  agreed(tabs, [["p", "paragraph", "?ALPHA"], ["r", "paragraph", "OMEGA!"], ["q", "paragraph", "braYvoZ"]]);
  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  expect(agreed(tabs, [["q", "paragraph", "braYvo"], ["p", "paragraph", "?ALPHA"], ["r", "paragraph", "OMEGA!"]], [["Z"]])).toEqual([0, 0, 1]);
  for (const tab of tabs) expect(authorsOf(tab, "Y")).toEqual([`T${B}`]);

  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [["p", "paragraph", "?ALPHA"], ["r", "paragraph", "OMEGA!"], ["q", "paragraph", "braYvoZ"]]);
  for (const tab of tabs) {
    expect(authorsOf(tab, "Y")).toEqual([`T${B}`]);
    expect(authorsOf(tab, "Z")).toEqual([`T${C}`]);
  }
});

test("Undo of a move of several blocks carries the peer words back into each of them", () => {
  const update = seed([{ id: "p", text: "ALPHA" }, { id: "q", text: "bravo" }, { id: "s", text: "sierra" }, { id: "r", text: "OMEGA" }]);
  const a = open(update, A), b = open(update, B);
  const tabs = [a, b];
  expect(a.bridge.moveBlocks({ ids: ["q", "s"], afterId: "r" })).toEqual({ status: "moved", ids: ["q", "s"] });
  exchange(tabs);
  type(b, "q", 5, "Y");
  type(b, "s", 0, "Z");
  exchange(tabs);
  agreed(tabs, [P, R, ["q", "paragraph", "bravoY"], ["s", "paragraph", "Zsierra"]]);

  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, ["q", "paragraph", "bravoY"], ["s", "paragraph", "Zsierra"], R]);

  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, R, ["q", "paragraph", "bravoY"], ["s", "paragraph", "Zsierra"]]);
});

test("Undo of a move of a toggle carries the peer words back into the toggle and its child", () => {
  const update = seed([
    { id: "t", t: "toggle", text: "Summary", attrs: { open: true } },
    { id: "k", text: "child", attrs: { parent: "t" } },
    { id: "r", text: "OMEGA" },
  ]);
  const a = open(update, A), b = open(update, B);
  const tabs = [a, b];
  expect(a.bridge.moveBlocks({ ids: ["t"], afterId: "r" })).toEqual({ status: "moved", ids: ["t", "k"] });
  exchange(tabs);
  type(b, "t", 7, "!");
  type(b, "k", 2, "Y");
  exchange(tabs);
  for (const tab of tabs) expect(nested(tab)).toEqual([["r", null, "OMEGA"], ["t", null, "Summary!"], ["k", "t", "chYild"]]);

  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [["t", "toggle", "Summary!"], ["k", "paragraph", "chYild"], R]);
  for (const tab of tabs) expect(nested(tab)).toEqual([["t", null, "Summary!"], ["k", "t", "chYild"], ["r", null, "OMEGA"]]);

  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  agreed(tabs, [R, ["t", "toggle", "Summary!"], ["k", "paragraph", "chYild"]]);
  for (const tab of tabs) expect(nested(tab)).toEqual([["r", null, "OMEGA"], ["t", null, "Summary!"], ["k", "t", "chYild"]]);
});

test("the owner's typing into the copy is its own step, undone before the move, and the peer words survive both", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B);
  const tabs = [a, b];
  a.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  exchange(tabs);
  type(a, "q", 5, "X");
  type(b, "q", 0, "Y");
  exchange(tabs);
  agreed(tabs, [P, R, ["q", "paragraph", "YbravoX"]]);

  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, R, ["q", "paragraph", "Ybravo"]]);
  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, ["q", "paragraph", "Ybravo"], R]);

  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, R, ["q", "paragraph", "Ybravo"]]);
  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, R, ["q", "paragraph", "YbravoX"]]);
});

test("Redo of the move keeps what the peer deleted from the restored original, a carried word and old text, and sets aside a new word until the next Undo", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B), c = open(update, C);
  const tabs = [a, b, c];
  a.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  exchange(tabs);
  type(b, "q", 2, "Y");
  type(b, "q", 6, "K");
  exchange(tabs);
  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, ["q", "paragraph", "brYavoK"], R]);

  type(c, "q", 0, "Z");
  erase(b, "q", 2, 3);
  exchange(tabs);
  erase(b, "q", 3, 4);
  exchange(tabs);
  agreed(tabs, [P, ["q", "paragraph", "ZbrvoK"], R]);

  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  expect(agreed(tabs, [P, R, ["q", "paragraph", "brvoK"]], [["Z"]])).toEqual([0, 0, 1]);
  for (const tab of tabs) expect(authorsOf(tab, "K")).toEqual([`T${B}`]);

  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, ["q", "paragraph", "ZbrvoK"], R]);
  for (const tab of tabs) {
    expect(authorsOf(tab, "Z")).toEqual([`T${C}`]);
    expect(authorsOf(tab, "K")).toEqual([`T${B}`]);
  }
});

test("words from a tab that was away during the Undo are carried once when it comes back, and its own later typing follows them", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B), c = open(update, C);
  const tabs = [a, b, c];
  a.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  exchange(tabs);
  type(c, "q", 5, "123");
  expect(a.bridge.undo()).toBe(true);
  settle([a, b]);
  agreed([a, b], [P, ["q", "paragraph", "bravo"], R]);
  type(b, "q", 0, "B");
  type(c, "q", 8, " 45");
  settle([a, b]);

  settle(tabs);
  agreed(tabs, [P, ["q", "paragraph", "Bbravo123 45"], R]);
  for (const tab of tabs) expect(authorsOf(tab, "12345")).toEqual([`T${C}`]);

  type(c, "q", 12, "!");
  settle(tabs);
  agreed(tabs, [P, ["q", "paragraph", "Bbravo123 45!"], R]);

  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  expect(agreed(tabs, [P, R, ["q", "paragraph", "bravo123 45"]], [["B", "!"]])).toEqual([0, 1, 1]);
  for (const tab of tabs) expect(authorsOf(tab, "12345")).toEqual([`T${C}`]);
  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, ["q", "paragraph", "Bbravo123 45!"], R]);
});

test("words typed into the restored original that reach the owner after its Redo are set aside once, and come back on the next Undo", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B);
  const tabs = [a, b];
  a.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  exchange(tabs);
  expect(a.bridge.undo()).toBe(true);
  exchange(tabs);
  type(b, "q", 5, "!");
  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  expect(agreed(tabs, [P, R, ["q", "paragraph", "bravo"]], [["!"]])).toEqual([0, 1]);

  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, ["q", "paragraph", "bravo!"], R]);
  for (const tab of tabs) expect(authorsOf(tab, "!")).toEqual([`T${B}`]);
});

test("Redo returns a carried word to the place it was typed, ahead of the owner's own later typing", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B);
  const tabs = [a, b];
  a.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  exchange(tabs);
  type(b, "q", 5, "Y");
  exchange(tabs);
  type(a, "q", 6, "X");
  settle(tabs);
  agreed(tabs, [P, R, ["q", "paragraph", "bravoYX"]]);

  expect(a.bridge.undo()).toBe(true);
  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, ["q", "paragraph", "bravoY"], R]);

  expect(a.bridge.redo()).toBe(true);
  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, R, ["q", "paragraph", "bravoYX"]]);
  for (const tab of tabs) expect(authorsOf(tab, "Y")).toEqual([`T${B}`]);
});

test("Redo of a move sets aside again what the move had set aside before the Undo, together with what reached the original after it", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B);
  const tabs = [a, b];
  type(b, "q", 5, "X");
  a.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  settle(tabs);
  for (const tab of tabs) {
    expect(rows(tab)).toEqual([P, R, ["q", "paragraph", "bravo"]]);
    expect(aside(tab)).toEqual([["X"]]);
  }

  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, ["q", "paragraph", "bravoX"], R]);

  type(b, "q", 0, "W");
  settle(tabs);
  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  expect(agreed(tabs, [P, R, ["q", "paragraph", "bravo"]], [["W", "X"]])).toEqual([0, 1]);

  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, ["q", "paragraph", "WbravoX"], R]);
});

test("the typing tab's own Undo follows its word to where the move's Undo carried it, and leaves its older edit for the next Undo", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B);
  const tabs = [a, b];
  const marked = ["p", "paragraph", "ALPHA!"], carried = ["q", "paragraph", "bravoY"], bare = ["q", "paragraph", "bravo"];
  type(b, "p", 5, "!");
  a.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  settle(tabs);
  type(b, "q", 5, "Y");
  settle(tabs);
  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [marked, carried, R]);

  expect(b.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [marked, bare, R]);
  expect(b.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [P, bare, R]);
  expect(b.bridge.undo()).toBe(false);
  expect(b.bridge.redo()).toBe(true);
  expect(b.bridge.redo()).toBe(true);
  settle(tabs);
  agreed(tabs, [marked, carried, R]);
  for (const tab of tabs) expect(authorsOf(tab, "Y")).toEqual([`T${B}`]);

  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  agreed(tabs, [marked, R, carried]);
  for (const tab of tabs) expect(authorsOf(tab, "Y")).toEqual([`T${B}`]);
  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  agreed(tabs, [marked, carried, R]);
});
