import { state as pmState } from "../../../../src/vendor/prosemirror.vendor.js";
import { schema } from "../../../../src/page/schema.js";
import { blockMap } from "../../../../src/page/model.js";
import { outline, moveSpanTr, BlockSelection } from "../../../../src/page/blocks.js";
import { captureArea, proposeArea, staleIds, keepAreaTransaction } from "../../../../src/page/ai-area.js";
import { bareShape } from "../../../../src/page/ybind/index.js";
import { Sim, createRoom } from "../collab/room-double.js";
import { makeYTab, seedValue } from "./harness/tab.js";

const clone = (v) => JSON.parse(JSON.stringify(v));

const SEED = [
  { id: "h1", t: "heading", attrs: { level: 1 }, text: "Quarterly notes" },
  { id: "p1", text: "Revenue grew and costs stayed flat." },
  { id: "p2", text: "Hiring slowed in the second half." },
  { id: "p3", text: "Keep me exactly as I am." },
  { id: "p4", text: "The last paragraph." },
];

async function pair(blocks = SEED, { tabOpts = {}, roomOpts = {} } = {}) {
  const sim = new Sim(7);
  const initial = seedValue(blocks);
  const room = createRoom(sim, { page: initial }, roomOpts);
  const a = makeYTab(sim, room, "a", clone(initial), tabOpts);
  const b = makeYTab(sim, room, "b", clone(initial), tabOpts);
  a.start();
  b.start();
  await sim.idle();
  return { sim, room, a, b };
}

const blockOf = (tab, id) => blockMap(tab.editor.state.doc)[id];
const textOf = (tab, id) => blockOf(tab, id)?.c ?? null;
const orderOf = (tab) => tab.blocks().map(([id]) => id);

function atOf(tab, id) {
  let at = null;
  tab.editor.state.doc.forEach((node, pos) => { if (node.attrs.id === id) at = pos; });
  return at;
}

function select(tab, id, offset = 0) {
  return atOf(tab, id) + 1 + offset;
}

function typeIn(tab, id, text, offset = 0) {
  const from = select(tab, id, offset);
  const tr = tab.editor.state.tr.insertText(text, from);
  tr.setSelection(pmState.TextSelection.create(tr.doc, from + text.length));
  tab.editor.dispatch(tr);
}

function removeBlock(tab, id) {
  const at = atOf(tab, id);
  const node = tab.editor.state.doc.nodeAt(at);
  tab.editor.dispatch(tab.editor.state.tr.delete(at, at + node.nodeSize));
}

function reParent(tab, id, parent) {
  const at = atOf(tab, id);
  const node = tab.editor.state.doc.nodeAt(at);
  tab.editor.dispatch(tab.editor.state.tr.setNodeMarkup(at, null, { ...node.attrs, parent }));
}

function moveBlock(tab, id, end) {
  const state = tab.editor.state;
  const entries = outline(state.doc);
  const at = entries.findIndex((e) => e.node.attrs.id === id);
  const sel = new BlockSelection(state.doc.resolve(entries[at].at), state.doc.resolve(entries[at].end));
  tab.editor.dispatch(moveSpanTr(state, entries, at, at, end ? state.doc.content.size : 0, () => null, sel));
}

function insertBlockBefore(tab, id, blockId, text) {
  const node = schema.nodes.paragraph.create({ id: blockId, pos: null }, schema.text(text));
  tab.editor.dispatch(tab.editor.state.tr.insert(atOf(tab, id), node));
}

function keep(tab, capture, proposal) {
  const result = keepAreaTransaction(tab.editor.state, capture, proposal);
  expect(result.status).toBe("ok");
  const before = tab.bridge.um.undoStack.length;
  tab.editor.dispatch(result.tr);
  return { tr: result.tr, undoAdded: tab.bridge.um.undoStack.length - before };
}

function probe(tab, ids) {
  const result = captureArea(tab.editor.state.doc, ids);
  expect(result.status).toBe("ok");
  return result.capture;
}

async function settled({ sim, room, a, b }) {
  await sim.idle();
  expect(a.stats.mismatch).toBe(0);
  expect(b.stats.mismatch).toBe(0);
  expect(a.blocks()).toEqual(b.blocks());
  const saved = clone(room.stores.get("page").value);
  room.land("page", room.seq);
  const fresh = makeYTab(sim, room, "reopen", saved);
  const opened = fresh.editor.state.doc;
  fresh.start();
  await sim.idle(3000);
  expect(bareShape(fresh.editor.state.doc)).toBe(bareShape(opened));
  expect(fresh.blocks()).toEqual(a.blocks());
  fresh.binding.dispose();
  room.close("reopen");
  return fresh;
}

test("schedule 1: A rewrites X and keeps over B's edit to Y; both survive and A's undo restores only X", async () => {
  const { sim, room, a, b } = await pair();
  const capture = probe(a, ["p1"]);
  const proposal = proposeArea(a.editor.state, capture, '<p data-id="p1">Revenue rose sharply.</p>', { seed: "s1" });
  expect(proposal.status).toBe("ready");

  typeIn(b, "p3", " Still true.", "Keep me exactly as I am.".length);
  await sim.idle();
  expect(textOf(a, "p3")).toBe("Keep me exactly as I am. Still true.");
  expect(staleIds(a.editor.state.doc, capture)).toEqual([]);

  keep(a, capture, proposal);
  await sim.idle();
  expect(textOf(a, "p1")).toBe("Revenue rose sharply.");
  expect(textOf(b, "p1")).toBe("Revenue rose sharply.");
  expect(textOf(a, "p3")).toBe("Keep me exactly as I am. Still true.");
  expect(textOf(b, "p3")).toBe("Keep me exactly as I am. Still true.");
  expect(orderOf(a)).toEqual(["h1", "p1", "p2", "p3", "p4"]);
  await settled({ sim, room, a, b });

  a.binding.undo();
  await sim.idle();
  expect(textOf(a, "p1")).toBe("Revenue grew and costs stayed flat.");
  expect(textOf(b, "p1")).toBe("Revenue grew and costs stayed flat.");
  expect(textOf(a, "p3")).toBe("Keep me exactly as I am. Still true.");
  expect(textOf(b, "p3")).toBe("Keep me exactly as I am. Still true.");
  await settled({ sim, room, a, b });
});

const STALE_SEED = [
  { id: "h1", t: "heading", attrs: { level: 1 }, text: "Quarterly notes" },
  { id: "t1", t: "toggle", attrs: {}, text: "Details" },
  { id: "p1", text: "Revenue grew and costs stayed flat." },
  { id: "p2", text: "Hiring slowed in the second half." },
  { id: "p3", text: "Keep me exactly as I am." },
];

async function staleSchedule(name, mutate, check) {
  const { sim, room, a, b } = await pair(STALE_SEED);
  const capture = probe(a, ["p1", "p2"]);
  const proposal = proposeArea(a.editor.state, capture, '<p data-id="p1">Rewritten one.</p><p data-id="p2">Rewritten two.</p>', { seed: name });
  expect(proposal.status).toBe("ready");

  mutate(b, a);
  await sim.idle();
  const received = b.blocks();
  expect(a.blocks()).toEqual(received);
  await settled({ sim, room, a, b });

  const result = keepAreaTransaction(a.editor.state, capture, proposal);
  expect(result.status).toBe("stale");
  check({ a, b });

  await sim.idle();
  expect(a.blocks()).toEqual(received);
  expect(b.blocks()).toEqual(received);
  expect(textOf(a, "p1")).not.toBe("Rewritten one.");
  await settled({ sim, room, a, b });
}

test("schedule 2a: B edits X before A's Keep; the keep is stale and B's text stays", async () => {
  await staleSchedule("s2a", (b) => typeIn(b, "p1", " B was here.", "Revenue grew and costs stayed flat.".length), ({ a, b }) => {
    expect(textOf(a, "p1")).toBe("Revenue grew and costs stayed flat. B was here.");
    expect(textOf(b, "p1")).toBe("Revenue grew and costs stayed flat. B was here.");
  });
});

test("schedule 2b: B deletes X before A's Keep; the keep is stale and X stays deleted", async () => {
  await staleSchedule("s2b", (b) => removeBlock(b, "p1"), ({ a }) => {
    expect(blockOf(a, "p1")).toBeUndefined();
    expect(orderOf(a)).toEqual(["h1", "t1", "p2", "p3"]);
  });
});

test("schedule 2c: B moves X under another parent before A's Keep; the keep is stale", async () => {
  await staleSchedule("s2c", (b) => reParent(b, "p1", "t1"), ({ a }) => {
    expect(blockOf(a, "p1").parent).toBe("t1");
    expect(textOf(a, "p1")).toBe("Revenue grew and costs stayed flat.");
  });
});

test("schedule 2d: B inserts a block inside A's span before A's Keep; the keep is stale", async () => {
  await staleSchedule("s2d", (b) => insertBlockBefore(b, "p2", "bnew", "B inserted this."), ({ a }) => {
    expect(orderOf(a)).toEqual(["h1", "t1", "p1", "bnew", "p2", "p3"]);
    expect(textOf(a, "bnew")).toBe("B inserted this.");
  });
});

test("schedule 3: A discards its proposal by not keeping; the document is B's work and A sends nothing", async () => {
  const { sim, room, a, b } = await pair();
  const capture = probe(a, ["p1", "p2"]);
  const proposal = proposeArea(a.editor.state, capture, '<p data-id="p1">Rewritten one.</p><p data-id="p2">Rewritten two.</p>', { seed: "s3" });
  expect(proposal.status).toBe("ready");

  typeIn(b, "p2", " And later.", "Hiring slowed in the second half.".length);
  await sim.idle();
  const bWork = b.blocks();
  expect(bWork).toEqual(a.blocks());

  const seq = room.seq;
  const posts = room.posts;
  expect(proposal.plan.edited.size).toBe(2);
  expect(a.store.pending.length).toBe(0);
  expect(room.seq).toBe(seq);
  expect(room.posts).toBe(posts);

  await settled({ sim, room, a, b });
  expect(textOf(a, "p1")).toBe("Revenue grew and costs stayed flat.");
  expect(textOf(b, "p1")).toBe("Revenue grew and costs stayed flat.");
  expect(textOf(a, "p2")).toBe("Hiring slowed in the second half. And later.");
  expect(textOf(b, "p2")).toBe("Hiring slowed in the second half. And later.");
});

test("schedule 4: A keeps, B types into the result, A undoes; they converge and B's characters remain", async () => {
  const { sim, room, a, b } = await pair();
  const capture = probe(a, ["p1"]);
  const proposal = proposeArea(a.editor.state, capture, '<p data-id="p1">The AI rewrote this.</p>', { seed: "s4" });
  expect(proposal.status).toBe("ready");

  keep(a, capture, proposal);
  await sim.idle();
  expect(textOf(b, "p1")).toBe("The AI rewrote this.");

  typeIn(b, "p1", " B adds this.", "The AI rewrote this.".length);
  await sim.idle();
  expect(textOf(a, "p1")).toBe("The AI rewrote this. B adds this.");
  expect(textOf(b, "p1")).toBe("The AI rewrote this. B adds this.");
  await settled({ sim, room, a, b });

  a.binding.undo();
  await sim.idle();
  const after = textOf(a, "p1");
  expect(textOf(b, "p1")).toBe(after);
  expect(after).toContain("B adds this.");
  expect(after).toContain("Revenue grew and costs stayed flat.");
  await settled({ sim, room, a, b });
});

for (const [name, first] of [["A", "a"], ["B", "b"]]) {
  test(`schedule 5 (${first} keeps first): both propose against one baseline and both keep before either receives the other's transaction`, async () => {
    const { sim, room, a, b } = await pair(SEED, { roomOpts: { latency: () => 120 } });
    const captureA = probe(a, ["p1"]);
    const captureB = probe(b, ["p1"]);
    const proposalA = proposeArea(a.editor.state, captureA, '<p data-id="p1">A replying.</p>', { seed: "s5a" });
    const proposalB = proposeArea(b.editor.state, captureB, '<p data-id="p1">B replying.</p>', { seed: "s5b" });
    expect(proposalA.status).toBe("ready");
    expect(proposalB.status).toBe("ready");
    expect(staleIds(a.editor.state.doc, captureA)).toEqual([]);
    expect(staleIds(b.editor.state.doc, captureB)).toEqual([]);

    const tabs = { a, b };
    const captures = { a: captureA, b: captureB };
    const proposals = { a: proposalA, b: proposalB };
    keep(tabs[first], captures[first], proposals[first]);
    const second = first === "a" ? "b" : "a";
    keep(tabs[second], captures[second], proposals[second]);
    await settled({ sim, room, a, b });

    const outcome = { a: textOf(a, "p1"), b: textOf(b, "p1"), notices: a.allNotices() };
    expect(outcome).toMatchObject({ a: expect.stringContaining("A replying") });
    expect(outcome).toMatchObject({ b: expect.stringContaining("B replying") });
    expect(outcome.a).toBe(outcome.b);
  });
}

const ORDER_SEED = ["a", "b", "c", "d"].map((id) => ({ id, text: id.toUpperCase() }));

test("a reorder of chosen blocks follows a peer moving another block to the front", async () => {
  const { sim, a, b } = await pair(ORDER_SEED);
  const capture = probe(a, ["b", "c"]);
  const proposal = proposeArea(a.editor.state, capture, '<p data-id="c">C</p><p data-id="b">B</p>', { seed: "peer-order" });
  expect(proposal.status).toBe("ready");

  moveBlock(b, "d", false);
  await sim.idle();
  expect(orderOf(a)).toEqual(["d", "a", "b", "c"]);

  keep(a, capture, proposal);
  await sim.idle();
  expect(orderOf(a)).toEqual(["d", "a", "c", "b"]);
  expect(orderOf(b)).toEqual(["d", "a", "c", "b"]);
  expect(a.blocks()).toEqual(b.blocks());
});

test("a new block before a chosen block follows it to its new place", async () => {
  const { sim, a, b } = await pair(ORDER_SEED);
  const capture = probe(a, ["b"]);
  const proposal = proposeArea(a.editor.state, capture, '<h2>New heading</h2><p data-id="b">B</p>', { seed: "peer-target" });
  expect(proposal.status).toBe("ready");
  const fresh = [...proposal.plan.created.keys()][0];

  moveBlock(b, "b", true);
  await sim.idle();
  expect(orderOf(a)).toEqual(["a", "c", "d", "b"]);

  keep(a, capture, proposal);
  await sim.idle();
  const ids = orderOf(b);
  expect(ids.indexOf(fresh) + 1).toBe(ids.indexOf("b"));
  expect(a.blocks()).toEqual(b.blocks());
});
