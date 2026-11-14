globalThis.ClipboardEvent ??= class ClipboardEvent extends Event {};

import * as Y from "../../../../src/vendor/yjs.vendor.js";
import { createStore } from "../../../../src/live/store.js";
import { identityPlugin } from "../../../../src/page/model.js";
import { state as pmState, view as pmView } from "../../../../src/vendor/prosemirror.vendor.js";
import { createPageDoc, createBridge, createYPageBinding, keepViewPos, seedFrom, seedValue, docOf, walk, authorKey } from "../../../../src/page/ybind/index.js";
import { NET } from "../../../../src/page/ybind/layout.js";
import { historyIntentPlugin, createHistoryBridge } from "../../../../src/page/history-intent.js";
import { undo as engine, undoParticipant } from "../../../../src/plugins/undo.js";

// The cases a review found against the first version of the carry: two tabs that moved the
// same block, a block made under the restored original, Undos by two movers, and words typed
// at the end of the block above a quick drag. Where the carry cannot be sure whose a word is,
// the word is set aside with a notice to its typist, as it was before the carry existed.

const A = 300, B = 100, C = 200, D = 400;
const START = [{ id: "p", text: "ALPHA" }, { id: "q", text: "bravo" }, { id: "r", text: "OMEGA" }];

const seed = (blocks) => {
  const pd = createPageDoc(new Y.Doc());
  pd.ydoc.clientID = 1;
  seedFrom(pd, blocks);
  return Y.encodeStateAsUpdateV2(pd.ydoc);
};

const opened = [];
const leases = [];
afterEach(() => {
  for (const lease of leases.splice(0)) lease.dispose();
  engine.stop();
  for (const { view, close, mount } of opened.splice(0)) { view.destroy(); close(); mount.remove(); }
  document.body.replaceChildren();
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
  const view = new pmView.EditorView(mount, { state: pmState.EditorState.create({ doc: keepViewPos(docOf(pd, walk(pd))), plugins: [identityPlugin()] }), dispatchTransaction: (tr) => bridge.dispatch(tr) });
  bridge.attach(view);
  const tab = { pd, bridge, stats, view, mount, client, close: () => { bridge.dispose(); pd.ydoc.destroy(); } };
  opened.push(tab);
  return tab;
}

const send = (from, to) => Y.applyUpdateV2(to.pd.ydoc, Y.encodeStateAsUpdateV2(from.pd.ydoc, Y.encodeStateVector(to.pd.ydoc)), NET);
const exchange = (tabs) => { for (const from of tabs) for (const to of tabs) if (to !== from) send(from, to); };
const settle = (tabs) => { for (let i = 0; i < 4; i++) exchange(tabs); };
const rows = (tab) => { const out = []; tab.view.state.doc.forEach((node) => out.push([node.attrs.id, node.textContent])); return out; };
const posIn = (tab, id, offset) => { let pos = null; tab.view.state.doc.forEach((node, at) => { if (node.attrs.id === id && pos === null) pos = at + 1 + offset; }); return pos; };
const type = (tab, id, offset, chars) => tab.view.dispatch(tab.view.state.tr.insertText(chars, posIn(tab, id, offset)));
const aside = (tab) => tab.bridge.recoverable.map((record) => record.blocks.flatMap((block) => block.runs).filter((run) => run.displaced).map((run) => run.text).join(""));
const split = (tab, id, offset) => {
  const pos = posIn(tab, id, offset);
  const $pos = tab.view.state.doc.resolve(pos);
  tab.view.dispatch(tab.view.state.tr.split(pos, 1, [{ type: $pos.parent.type, attrs: { ...$pos.parent.attrs, id: "n" } }]));
};

// Every tab shows the same blocks and holds the same text, the binding found no mismatch, and
// each word is shown at most once and is never gone from both the page and the recovery list.
const state = (tabs, words = []) => {
  const flows = new Set(tabs.map((tab) => JSON.stringify(tab.pd.flow.toDelta())));
  expect(flows.size).toBe(1);
  for (const tab of tabs) {
    expect(rows(tab)).toEqual(rows(tabs[0]));
    expect(aside(tab)).toEqual(aside(tabs[0]));
    expect(tab.stats.mismatch + (tab.stats.walkMismatch ?? 0)).toBe(0);
  }
  const shown = rows(tabs[0]).map((row) => row[1]).join("|");
  const kept = aside(tabs[0]).join("|");
  for (const word of words) {
    const count = shown.split(word).length - 1;
    expect(count).toBeLessThanOrEqual(1);
    expect(count + kept.split(word).length - 1).toBeGreaterThanOrEqual(1);
  }
  return { rows: rows(tabs[0]), aside: aside(tabs[0]), notices: tabs.map((tab) => tab.bridge.notices.length) };
};

test("S1: two tabs moved q, both undid, a word typed into the restored q reaches each Redo separately: it is set aside once, never shown twice", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B), c = open(update, C);
  const tabs = [a, b, c];
  a.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  b.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  settle(tabs);
  expect(a.bridge.undo()).toBe(true);
  expect(b.bridge.undo()).toBe(true);
  settle(tabs);
  type(c, "q", 5, "Y");
  send(c, a);
  expect(b.bridge.redo()).toBe(true);
  send(b, a);
  expect(a.bridge.redo()).toBe(true);
  send(c, b);
  settle(tabs);
  expect(state(tabs, ["Y"])).toEqual({ rows: [["p", "ALPHA"], ["r", "OMEGA"], ["q", "bravo"]], aside: ["Y"], notices: [0, 0, 1] });
});

test("S4: a paragraph made under the restored q while the move is undone is never glued onto the moved q by Redo", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B);
  const tabs = [a, b];
  a.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  settle(tabs);
  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  split(b, "q", 5);
  type(b, "n", 0, "NEW");
  settle(tabs);
  expect(state(tabs, ["NEW"]).rows).toEqual([["p", "ALPHA"], ["q", "bravo"], ["n", "NEW"], ["r", "OMEGA"]]);

  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  expect(state(tabs, ["NEW"])).toEqual({ rows: [["p", "ALPHA"], ["r", "OMEGA"], ["q", "bravo"]], aside: ["NEW"], notices: [0, 1] });

  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  expect(state(tabs, ["NEW"])).toEqual({ rows: [["p", "ALPHA"], ["q", "bravo"], ["n", "NEW"], ["r", "OMEGA"]], aside: [], notices: [0, 0] });

  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  expect(state(tabs, ["NEW"])).toEqual({ rows: [["p", "ALPHA"], ["r", "OMEGA"], ["q", "bravo"]], aside: ["NEW"], notices: [0, 1] });
});

test("S5: B moves q, A moves it again, both Undo at the same moment, then each Redoes: q keeps its words", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B);
  const tabs = [a, b];
  b.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  settle(tabs);
  a.bridge.moveBlocks({ ids: ["q"], afterId: null });
  settle(tabs);
  expect(a.bridge.undo()).toBe(true);
  expect(b.bridge.undo()).toBe(true);
  settle(tabs);
  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  expect(state(tabs, ["bravo"])).toEqual({ rows: [["p", "ALPHA"], ["q", "bravo"], ["r", "OMEGA"]], aside: [], notices: [0, 0] });
  expect(b.bridge.redo()).toBe(true);
  settle(tabs);
  expect(state(tabs, ["bravo"])).toEqual({ rows: [["q", "bravo"], ["p", "ALPHA"], ["r", "OMEGA"]], aside: [], notices: [0, 0] });
});

test("S5b: B moves q, A moves it again, A undoes, B undoes after seeing it, then A redoes: q keeps its words", () => {
  const update = seed(START);
  const a = open(update, A), b = open(update, B);
  const tabs = [a, b];
  b.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
  settle(tabs);
  a.bridge.moveBlocks({ ids: ["q"], afterId: null });
  settle(tabs);
  expect(a.bridge.undo()).toBe(true);
  settle(tabs);
  expect(b.bridge.undo()).toBe(true);
  settle(tabs);
  expect(a.bridge.redo()).toBe(true);
  settle(tabs);
  expect(state(tabs, ["bravo"])).toEqual({ rows: [["p", "ALPHA"], ["q", "bravo"], ["r", "OMEGA"]], aside: [], notices: [0, 0] });
});

for (const typist of [D, 50]) {
  test(`S6: words typed at the end of r (typist ${typist}) during a quick drag of q below r and its Undo never land in q`, () => {
    const update = seed(START);
    const b = open(update, B), t = open(update, typist);
    const tabs = [b, t];
    b.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
    expect(b.bridge.undo()).toBe(true);
    type(t, "r", 5, "XYZ");
    settle(tabs);
    const out = state(tabs, ["XYZ"]);
    expect(out.rows[1]).toEqual(["q", "bravo"]);
    if (typist === 50) expect(out).toEqual({ rows: [["p", "ALPHA"], ["q", "bravo"], ["r", "OMEGAXYZ"]], aside: [], notices: [0, 0] });
    else expect(out).toEqual({ rows: [["p", "ALPHA"], ["q", "bravo"], ["r", "OMEGA"]], aside: ["XYZ"], notices: [0, 1] });
  });
}

for (const dropper of [B, 500]) {
  test(`S7: a word carried to the end of r while another tab (${dropper}) drops q right after r stays in r, shown once after r moves again`, () => {
    const update = seed(START);
    const a = open(update, A), b = open(update, dropper), d = open(update, D);
    const tabs = [a, b, d];
    a.bridge.moveBlocks({ ids: ["r"], afterId: "p" });
    send(a, d);
    type(d, "r", 5, "WORD");
    expect(a.bridge.undo()).toBe(true);
    b.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
    send(d, a);
    expect(rows(a)).toEqual([["p", "ALPHA"], ["q", "bravo"], ["r", "OMEGAWORD"]]);
    a.bridge.moveBlocks({ ids: ["r"], afterId: "p" });
    settle(tabs);
    expect(state(tabs, ["WORD"])).toEqual({ rows: [["p", "ALPHA"], ["r", "OMEGAWORD"], ["q", "bravo"]], aside: [], notices: [0, 0, 0] });

    expect(a.bridge.undo()).toBe(true);
    expect(b.bridge.undo()).toBe(true);
    settle(tabs);
    expect(state(tabs, ["WORD"])).toEqual({ rows: [["p", "ALPHA"], ["q", "bravo"], ["r", "OMEGAWORD"]], aside: [], notices: [0, 0, 0] });
  });
}

const erase = (tab, id, from, to) => tab.view.dispatch(tab.view.state.tr.delete(posIn(tab, id, from), posIn(tab, id, to)));

for (const later of ["K typed into r", "Z typed after Y"]) {
  test(`R1: another person deletes the typist's newest word (${later}); the typist's Undo then takes out the carried Y, never the older " first"`, () => {
    const update = seed(START);
    const a = open(update, A), c = open(update, C), d = open(update, D);
    const tabs = [a, c, d];
    type(d, "p", 5, " first");
    settle(tabs);
    a.bridge.moveBlocks({ ids: ["q"], afterId: "r" });
    settle(tabs);
    type(d, "q", 5, "Y");
    settle(tabs);
    if (later === "Z typed after Y") { type(d, "q", 6, "Z"); settle(tabs); }
    expect(a.bridge.undo()).toBe(true);
    settle(tabs);
    if (later === "K typed into r") { type(d, "r", 5, "K"); settle(tabs); erase(c, "r", 5, 6); }
    else erase(c, "q", 6, 7);
    settle(tabs);
    expect(state(tabs, ["first", "Y"]).rows).toEqual([["p", "ALPHA first"], ["q", "bravoY"], ["r", "OMEGA"]]);

    expect(d.bridge.undo()).toBe(true);
    settle(tabs);
    expect(state(tabs, ["first"])).toEqual({ rows: [["p", "ALPHA first"], ["q", "bravo"], ["r", "OMEGA"]], aside: [], notices: [0, 0, 0] });
    expect(d.bridge.undo()).toBe(true);
    settle(tabs);
    expect(state(tabs).rows).toEqual([["p", "ALPHA"], ["q", "bravo"], ["r", "OMEGA"]]);
  });
}

test("with the page history, the typist's own Undo after its word was carried takes out that word and nothing older", async () => {
  const value = seedValue([{ id: "p", text: "alpha" }, { id: "q", text: "bravo" }, { id: "r", text: "omega" }]);
  const page = (client) => {
    const store = createStore({ name: "blockeditor", value: JSON.parse(JSON.stringify(value)) });
    const binding = createYPageBinding({ store, captureTimeout: 0 });
    binding.ydoc.clientID = client;
    const article = document.body.appendChild(document.createElement("article"));
    const mount = article.appendChild(document.createElement("div"));
    mount.setAttribute("no-undo", "");
    const view = new pmView.EditorView(mount, { state: pmState.EditorState.create({ doc: binding.doc(), plugins: [identityPlugin(), historyIntentPlugin()] }), dispatchTransaction: (tr) => binding.dispatch(tr) });
    binding.attach(view);
    const tab = { binding, view, mount, article, close: () => { binding.dispose(); binding.ydoc.destroy(); article.remove(); } };
    opened.push(tab);
    return tab;
  };
  const relay = (from, to) => Y.applyUpdateV2(to.binding.ydoc, Y.encodeStateAsUpdateV2(from.binding.ydoc), NET);
  const sync = (x, y) => { for (let i = 0; i < 3; i++) { relay(x, y); relay(y, x); } };
  const text = (tab) => { const out = []; tab.view.state.doc.forEach((node) => out.push(`${node.attrs.id}:${node.textContent}`)); return out.join("|"); };
  const endOf = (tab, id) => { let end = null; tab.view.state.doc.forEach((node, offset) => { if (node.attrs.id === id) end = offset + 1 + node.content.size; }); return end; };
  const typeAt = (tab, pos, chars) => {
    tab.view.dispatch(tab.view.state.tr.setSelection(pmState.TextSelection.create(tab.view.state.doc, pos)));
    for (const ch of chars) { const { from, to } = tab.view.state.selection; tab.view.someProp("handleTextInput", (f) => f(tab.view, from, to, ch, () => tab.view.state.tr.insertText(ch, from, to))); }
  };

  window.clay = { ...(window.clay || {}), undo: engine };
  const owner = page(A);
  const typist = page(B);
  sync(owner, typist);
  const lease = await undoParticipant().prepare({ generation: 1, isCurrent: () => true });
  lease.enable();
  leases.push(lease);
  const history = createHistoryBridge({ um: typist.binding.bridge.um, undo: () => typist.binding.undo(), redo: () => typist.binding.redo(), article: typist.article, focus: () => {} });
  leases.push(history);
  const skipped = [];
  engine.on("skipped", (detail) => skipped.push(detail?.code ?? "skip"));

  typeAt(typist, endOf(typist, "p"), " first sentence. ");
  engine.commit?.("pause", () => {});
  owner.binding.moveBlocks({ ids: ["q"], afterId: "r" });
  sync(owner, typist);
  typeAt(typist, endOf(typist, "q"), "Y");
  sync(owner, typist);
  expect(owner.binding.undo()).toBe(true);
  sync(owner, typist);
  expect(text(typist)).toBe("p:alpha first sentence. |q:bravoY|r:omega");

  engine.undo();
  sync(owner, typist);
  expect(text(typist)).toBe("p:alpha first sentence. |q:bravo|r:omega");
  expect(text(owner)).toBe(text(typist));
  expect(skipped).toEqual([]);
  expect(engine.canUndo).toBe(true);

  engine.redo();
  sync(owner, typist);
  expect(text(typist)).toBe("p:alpha first sentence. |q:bravoY|r:omega");
  expect(text(owner)).toBe(text(typist));
  expect(skipped).toEqual([]);
});
