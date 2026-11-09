import { state as pmState } from "../../../src/vendor/prosemirror.vendor.js";
import { schema } from "../../../src/page/schema.js";
import { blockMap, identityPlugin } from "../../../src/page/model.js";
import { STEP } from "../../../src/page/blocks.js";
import { captureArea, proposeArea, staleIds, keepAreaTransaction, AREA_GUIDE } from "../../../src/page/ai-area.js";
import { Sim, createRoom } from "./collab/room-double.js";
import { makeYTab, seedValue } from "./ybind/harness/tab.js";

const clone = (v) => JSON.parse(JSON.stringify(v));

const SEED = [
  { id: "h1", t: "heading", attrs: { level: 1 }, text: "Quarterly notes" },
  { id: "p1", text: "Revenue grew and costs stayed flat." },
  { id: "p2", text: "Hiring slowed in the second half." },
  { id: "p3", text: "Keep me exactly as I am." },
  { id: "p4", text: "The last paragraph." },
];

async function pair(blocks = SEED, opts = {}) {
  const sim = new Sim(7);
  const initial = seedValue(blocks);
  const room = createRoom(sim, { page: initial }, {});
  const a = makeYTab(sim, room, "a", clone(initial), opts);
  const b = makeYTab(sim, room, "b", clone(initial), opts);
  a.start();
  b.start();
  await sim.idle();
  return { sim, a, b };
}

const blockOf = (tab, id) => blockMap(tab.editor.state.doc)[id];
const nodeOf = (tab, id) => {
  let found = null;
  tab.editor.state.doc.forEach((node) => { if (node.attrs.id === id) found = node; });
  return found;
};
const textOf = (tab, id) => blockOf(tab, id)?.c ?? null;
const orderOf = (tab) => tab.blocks().map(([id]) => id);

function select(tab, id, offset = 0) {
  let at = null;
  tab.editor.state.doc.forEach((node, pos) => { if (node.attrs.id === id) at = pos; });
  return at + 1 + offset;
}

function typeIn(tab, id, text, offset = 0) {
  const from = select(tab, id, offset);
  const tr = tab.editor.state.tr.insertText(text, from);
  tr.setSelection(pmState.TextSelection.create(tr.doc, from + text.length));
  tab.editor.dispatch(tr);
}

function keep(tab, capture, proposal) {
  const result = keepAreaTransaction(tab.editor.state, capture, proposal);
  expect(result.status).toBe("ok");
  const before = tab.bridge.um.undoStack.length;
  tab.editor.dispatch(result.tr);
  return { tr: result.tr, undoAdded: tab.bridge.um.undoStack.length - before };
}

const TOOL = { title: "T", html: "<div></div>", css: "", javascript: "tool.root.textContent = 1", fallbackHtml: "<p>fallback</p>", summary: "s" };

test("capture sends ids and hides a tool behind a keep divider", async () => {
  const { a } = await pair([
    { id: "p1", text: "Before the tool." },
    { id: "tool1", t: "tool", attrs: { artifact: TOOL, rev: 3, state: null } },
    { id: "p2", text: "After the tool." },
  ]);
  const result = captureArea(a.editor.state.doc, ["p1", "tool1", "p2"]);
  expect(result.status).toBe("ok");
  const { capture } = result;
  expect(capture.html).toContain('data-id="p1"');
  expect(capture.html).toContain('data-id="p2"');
  expect(capture.html).toContain('hr data-id="tool1" data-clay-keep="tool"');
  expect(capture.html).not.toContain("<script");
  expect(capture.html).not.toContain('data-type="tool"');
  expect(capture.held.has("tool1")).toBe(true);
  expect(capture.ids).toEqual(["p1", "tool1", "p2"]);
  expect(AREA_GUIDE).toContain("data-clay-keep");
  expect(AREA_GUIDE).toContain("Keep each checkbox on a list item unless the request says to remove it.");
});

test("an edit plus a new block lands between its neighbours and both tabs converge", async () => {
  const { sim, a, b } = await pair();
  const result = captureArea(a.editor.state.doc, ["p1", "p2"]);
  expect(result.status).toBe("ok");
  const { capture } = result;
  const reply = '<div data-clay-area><p data-id="p1">Revenue rose.</p><p>A brand new paragraph.</p><p data-id="p2">Hiring slowed.</p></div>';
  const proposal = proposeArea(a.editor.state, capture, reply, { seed: "t2" });
  expect(proposal.status).toBe("ready");
  expect(proposal.plan.created.size).toBe(1);
  const [fresh] = [...proposal.plan.created.keys()];
  keep(a, capture, proposal);
  await sim.idle();
  expect(orderOf(a)).toEqual(["h1", "p1", fresh, "p2", "p3", "p4"]);
  expect(textOf(a, "p1")).toBe("Revenue rose.");
  expect(textOf(a, "p3")).toBe("Keep me exactly as I am.");
  expect(textOf(a, "p4")).toBe("The last paragraph.");
  expect(b.blocks()).toEqual(a.blocks());
});

test("one Keep is one undo item, one undo restores both tabs, then redo", async () => {
  const { sim, a, b } = await pair();
  const result = captureArea(a.editor.state.doc, ["p1", "p2"]);
  const proposal = proposeArea(a.editor.state, result.capture, '<p data-id="p1">Rewritten.</p><p data-id="p2">Also rewritten.</p>', { seed: "undo" });
  const { tr, undoAdded } = keep(a, result.capture, proposal);
  expect(tr.getMeta(STEP)).toBe(true);
  expect(undoAdded).toBe(1);
  await sim.idle();
  expect(textOf(a, "p1")).toBe("Rewritten.");
  expect(textOf(b, "p1")).toBe("Rewritten.");
  a.binding.undo();
  await sim.idle();
  expect(textOf(a, "p1")).toBe("Revenue grew and costs stayed flat.");
  expect(textOf(b, "p1")).toBe("Revenue grew and costs stayed flat.");
  a.binding.redo();
  await sim.idle();
  expect(textOf(a, "p1")).toBe("Rewritten.");
  expect(textOf(b, "p1")).toBe("Rewritten.");
});

test("an undo right after typing takes back only the rewrite", async () => {
  const { sim, a, b } = await pair();
  a.bridge.um.captureTimeout = 500;
  const result = captureArea(a.editor.state.doc, ["p1", "p2"]);
  const typedAt = sim.now();
  typeIn(a, "p3", "TYPED ");
  await sim.idle(20);
  const proposal = proposeArea(a.editor.state, result.capture, '<p data-id="p1">Rewritten.</p><p data-id="p2">Also rewritten.</p>', { seed: "fast" });
  expect(proposal.status).toBe("ready");
  keep(a, result.capture, proposal);
  expect(sim.now() - typedAt).toBeLessThan(100);
  await sim.idle(50);
  expect(textOf(a, "p1")).toBe("Rewritten.");
  a.binding.undo();
  await sim.idle();
  expect(textOf(a, "p1")).toBe("Revenue grew and costs stayed flat.");
  expect(textOf(a, "p3")).toBe("TYPED Keep me exactly as I am.");
  expect(textOf(b, "p3")).toBe("TYPED Keep me exactly as I am.");
});

test("50,000 characters is one undo item and peers converge", async () => {
  const { sim, a, b } = await pair();
  const result = captureArea(a.editor.state.doc, ["p1", "p2", "p3"]);
  const long = "A sentence that is long enough to matter. ".repeat(400);
  const reply = `<p data-id="p1">${long}</p><p data-id="p2">${long}</p><p data-id="p3">${long}</p>`;
  const proposal = proposeArea(a.editor.state, result.capture, reply, { seed: "long" });
  expect(proposal.status).toBe("ready");
  const { undoAdded } = keep(a, result.capture, proposal);
  expect(undoAdded).toBe(1);
  await sim.idle(6000);
  expect(textOf(a, "p1").length).toBe(long.length);
  expect(b.blocks()).toEqual(a.blocks());
});

test("a peer typing outside the span keeps their text", async () => {
  const { sim, a, b } = await pair();
  const result = captureArea(a.editor.state.doc, ["p1", "p2"]);
  typeIn(b, "p4", "PEER ");
  await sim.idle();
  expect(textOf(a, "p4")).toBe("PEER The last paragraph.");
  const proposal = proposeArea(a.editor.state, result.capture, '<p data-id="p1">Rewritten.</p><p data-id="p2">Also rewritten.</p>', { seed: "outside" });
  expect(proposal.status).toBe("ready");
  keep(a, result.capture, proposal);
  await sim.idle();
  expect(textOf(a, "p4")).toBe("PEER The last paragraph.");
  expect(textOf(b, "p4")).toBe("PEER The last paragraph.");
  expect(b.blocks()).toEqual(a.blocks());
});

test("a peer typing inside the span makes the proposal stale", async () => {
  const { sim, a, b } = await pair();
  const result = captureArea(a.editor.state.doc, ["p1", "p2"]);
  typeIn(b, "p2", "PEER ");
  await sim.idle();
  expect(staleIds(a.editor.state.doc, result.capture)).toEqual(["p2"]);
  const proposal = proposeArea(a.editor.state, result.capture, '<p data-id="p1">Rewritten.</p><p data-id="p2">Also rewritten.</p>', { seed: "inside" });
  expect(proposal.status).toBe("refused");
  expect(proposal.code).toBe("stale");
  const before = a.editor.state.doc;
  const kept = keepAreaTransaction(a.editor.state, result.capture, proposal);
  expect(kept.status).toBe("stale");
  expect(kept.ids).toEqual(["p2"]);
  expect(a.editor.state.doc).toBe(before);
  expect(textOf(a, "p2")).toBe("PEER Hiring slowed in the second half.");
});

test("a peer deleting a span block is stale and the block is not resurrected", async () => {
  const { sim, a, b } = await pair();
  const result = captureArea(a.editor.state.doc, ["p1", "p2"]);
  let at = null;
  b.editor.state.doc.forEach((node, pos) => { if (node.attrs.id === "p2") at = pos; });
  b.editor.dispatch(b.editor.state.tr.delete(at, at + b.editor.state.doc.nodeAt(at).nodeSize));
  await sim.idle();
  expect(staleIds(a.editor.state.doc, result.capture)).toEqual(["p2"]);
  const proposal = proposeArea(a.editor.state, result.capture, '<p data-id="p1">Rewritten.</p>', { seed: "deleted" });
  expect(proposal.status).toBe("refused");
  expect(proposal.code).toBe("stale");
  const kept = keepAreaTransaction(a.editor.state, result.capture, proposal);
  expect(kept.status).toBe("stale");
  await sim.idle();
  expect(orderOf(a)).toEqual(["h1", "p1", "p3", "p4"]);
  expect(orderOf(b)).toEqual(["h1", "p1", "p3", "p4"]);
});

test("undoing a rewrite keeps what a peer typed into the rewritten block", async () => {
  const { sim, a, b } = await pair();
  const result = captureArea(a.editor.state.doc, ["p1", "p2"]);
  const proposal = proposeArea(a.editor.state, result.capture, '<p data-id="p1">Rewritten p1.</p><p data-id="p2">Rewritten p2.</p>', { seed: "peer" });
  keep(a, result.capture, proposal);
  await sim.idle();
  typeIn(b, "p1", "PEER");
  await sim.idle();
  expect(textOf(a, "p1")).toBe("PEERRewritten p1.");
  a.binding.undo();
  await sim.idle();
  expect(textOf(a, "p1")).toBe("PEERRevenue grew and costs stayed flat.");
  expect(textOf(b, "p1")).toBe("PEERRevenue grew and costs stayed flat.");
});

test("a reply with a div holding a script is refused as active", async () => {
  const { a } = await pair();
  const result = captureArea(a.editor.state.doc, ["p1"]);
  const before = a.editor.state.doc;
  const proposal = proposeArea(a.editor.state, result.capture, '<p data-id="p1">Safe</p><div class="x"><script>alert(1)</script><p>nested</p></div>', { seed: "script" });
  expect(proposal.status).toBe("refused");
  expect(proposal.code).toBe("active");
  expect(a.editor.state.doc).toBe(before);
});

test("a reply with an image is refused as active", async () => {
  const { a } = await pair();
  const result = captureArea(a.editor.state.doc, ["p1"]);
  const proposal = proposeArea(a.editor.state, result.capture, '<p data-id="p1">Safe</p><img src="x.png">', { seed: "img" });
  expect(proposal.status).toBe("refused");
  expect(proposal.code).toBe("active");
});

test("a reply copying the id of a block outside the span leaves that block alone", async () => {
  const { sim, a, b } = await pair();
  const result = captureArea(a.editor.state.doc, ["p2"]);
  const proposal = proposeArea(a.editor.state, result.capture, '<p data-id="p3">Hijacked.</p>', { seed: "outside-id" });
  expect(proposal.status).toBe("ready");
  expect(proposal.plan.edited.has("p3")).toBe(false);
  keep(a, result.capture, proposal);
  await sim.idle();
  expect(textOf(a, "p3")).toBe("Keep me exactly as I am.");
  expect(textOf(b, "p3")).toBe("Keep me exactly as I am.");
  expect(orderOf(a)).toEqual(["h1", "p1", "p2", "p3", "p4"]);
});

test("a reply that drops every data-id keeps the span's ids", async () => {
  const { a } = await pair();
  const result = captureArea(a.editor.state.doc, ["p1", "p2"]);
  const proposal = proposeArea(a.editor.state, result.capture, "<p>Rewritten one.</p><p>Rewritten two.</p>", { seed: "dropped" });
  expect(proposal.status).toBe("ready");
  expect([...proposal.plan.edited.keys()].sort()).toEqual(["p1", "p2"]);
  expect(proposal.plan.created.size).toBe(0);
  expect(proposal.plan.deleted).toEqual([]);
});

test("a span of children inside a toggle stays inside it", async () => {
  const { sim, a, b } = await pair([
    { id: "t1", t: "toggle", attrs: {}, text: "Details" },
    { id: "c1", attrs: { parent: "t1" }, text: "Child one" },
    { id: "c2", attrs: { parent: "t1" }, text: "Child two" },
    { id: "after", text: "After the toggle" },
  ]);
  const result = captureArea(a.editor.state.doc, ["c1", "c2"]);
  expect(result.status).toBe("ok");
  expect(result.capture.parent).toBe("t1");
  const reply = '<p data-id="c1">Child one, improved.</p><p data-id="c2">Child two, improved.</p>';
  const proposal = proposeArea(a.editor.state, result.capture, reply, { seed: "toggle" });
  expect(proposal.status).toBe("ready");
  keep(a, result.capture, proposal);
  await sim.idle();
  expect(orderOf(a)).toEqual(["t1", "c1", "c2", "after"]);
  expect(blockOf(a, "c1").parent).toBe("t1");
  expect(blockOf(a, "c2").parent).toBe("t1");
  expect(textOf(a, "c1")).toBe("Child one, improved.");
  expect(b.blocks()).toEqual(a.blocks());
});

test("a held tool in the span keeps its artifact and rev", async () => {
  const { sim, a } = await pair([
    { id: "p1", text: "Before the tool." },
    { id: "tool1", t: "tool", attrs: { artifact: TOOL, rev: 3, state: null } },
    { id: "p2", text: "After the tool." },
  ]);
  const result = captureArea(a.editor.state.doc, ["p1", "tool1", "p2"]);
  const reply = result.capture.html.replace("Before the tool.", "Before the tool, edited.").replace("After the tool.", "After the tool, edited.");
  const proposal = proposeArea(a.editor.state, result.capture, reply, { seed: "held" });
  expect(proposal.status).toBe("ready");
  keep(a, result.capture, proposal);
  await sim.idle();
  expect(textOf(a, "p1")).toBe("Before the tool, edited.");
  expect(textOf(a, "p2")).toBe("After the tool, edited.");
  expect(blockOf(a, "tool1").rev).toBe(3);
  expect(JSON.stringify(blockOf(a, "tool1").artifact)).toBe(JSON.stringify(TOOL));
  expect(orderOf(a)).toEqual(["p1", "tool1", "p2"]);
});

test("blocks that are not next to each other refuse at capture", () => {
  const para = (id) => schema.nodes.paragraph.create({ id, pos: null }, schema.text(id));
  const doc = schema.nodes.doc.create(null, [para("p1"), para("p2"), para("p3")]);
  const result = captureArea(doc, ["p1", "p3"]);
  expect(result.status).toBe("refused");
  expect(result.code).toBe("not-found");
  expect(captureArea(doc, ["p1", "p2"]).status).toBe("ok");
});

test("an opaque block in the span refuses at capture", () => {
  const opaque = schema.nodes.opaque_block.create({ id: "opaque1", pos: null, raw: { t: "mystery" } });
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create({ id: "p1", pos: null }, schema.text("Text.")),
    opaque,
  ]);
  const state = pmState.EditorState.create({ doc, plugins: [identityPlugin()] });
  const result = captureArea(state.doc, ["p1", "opaque1"]);
  expect(result.status).toBe("refused");
  expect(result.code).toBe("opaque");
});

test("a reply with the wrapper dropped is accepted as a fragment", async () => {
  const { sim, a } = await pair();
  const result = captureArea(a.editor.state.doc, ["p1", "p2"]);
  const bare = proposeArea(a.editor.state, result.capture, '<p data-id="p1">Bare one.</p><p data-id="p2">Bare two.</p>', { seed: "bare" });
  expect(bare.status).toBe("ready");
  const wrapped = proposeArea(a.editor.state, result.capture, '<div data-clay-area><p data-id="p1">Bare one.</p><p data-id="p2">Bare two.</p></div>', { seed: "bare" });
  expect(wrapped.status).toBe("ready");
  expect(wrapped.plan.order).toEqual(bare.plan.order);
  keep(a, result.capture, wrapped);
  await sim.idle();
  expect(textOf(a, "p1")).toBe("Bare one.");
  expect(textOf(a, "p2")).toBe("Bare two.");
});

test("an unchanged reply refuses with no-change", async () => {
  const { a } = await pair();
  const result = captureArea(a.editor.state.doc, ["p1", "p2"]);
  const before = a.editor.state.doc;
  const proposal = proposeArea(a.editor.state, result.capture, result.capture.html, { seed: "same" });
  expect(proposal.status).toBe("refused");
  expect(proposal.code).toBe("no-change");
  expect(a.editor.state.doc).toBe(before);
});

test("a plain reply keeps a title's icon and cover", async () => {
  const { sim, a } = await pair([
    { id: "title", t: "heading", attrs: { level: 1, pageIcon: "📄", pageCoverSrc: "cover.png", pageCoverAlt: "Cover" }, text: "Quarterly notes" },
    { id: "p1", text: "Revenue grew and costs stayed flat." },
  ]);
  const result = captureArea(a.editor.state.doc, ["title"]);
  expect(result.status).toBe("ok");
  const proposal = proposeArea(a.editor.state, result.capture, '<h1 data-id="title">Quarterly notes, revised.</h1>', { seed: "title" });
  expect(proposal.status).toBe("ready");
  keep(a, result.capture, proposal);
  await sim.idle();
  const title = blockOf(a, "title");
  expect(title.c).toBe("Quarterly notes, revised.");
  expect(title.pageIcon).toBe("📄");
  expect(title.pageCoverSrc).toBe("https://cover.png");
  expect(title.pageCoverAlt).toBe("Cover");
});

test("a plain reply keeps a checklist item's owner and due but drops its checkbox", async () => {
  const { sim, a } = await pair([
    { id: "li1", t: "list_item", attrs: { kind: "check", checked: true, owner: "Ada", due: "2026-01-02" }, text: "Book the venue" },
  ]);
  const result = captureArea(a.editor.state.doc, ["li1"]);
  expect(result.status).toBe("ok");
  const proposal = proposeArea(a.editor.state, result.capture, '<ul><li data-id="li1">Book the venue, today</li></ul>', { seed: "check" });
  expect(proposal.status).toBe("ready");
  keep(a, result.capture, proposal);
  await sim.idle();
  const item = blockOf(a, "li1");
  expect(item.c).toBe("Book the venue, today");
  expect(nodeOf(a, "li1").attrs.kind).toBe("bullet");
  expect(nodeOf(a, "li1").attrs.checked).toBe(false);
  expect(item.owner).toBe("Ada");
  expect(item.due).toBe("2026-01-02");
});

test("a reply that demotes a heading keeps the level it asks for", async () => {
  const { sim, a } = await pair([
    { id: "h1", t: "heading", attrs: { level: 1 }, text: "Quarterly notes" },
    { id: "p1", text: "After the heading." },
  ]);
  const result = captureArea(a.editor.state.doc, ["h1"]);
  expect(result.status).toBe("ok");
  const proposal = proposeArea(a.editor.state, result.capture, '<h2 data-id="h1">Quarterly notes, revised.</h2>', { seed: "level" });
  expect(proposal.status).toBe("ready");
  keep(a, result.capture, proposal);
  await sim.idle();
  expect(nodeOf(a, "h1").attrs.level).toBe(2);
  expect(textOf(a, "h1")).toBe("Quarterly notes, revised.");
});

test("a reply that turns a numbered list into a bullet list changes its kind", async () => {
  const { sim, a } = await pair([
    { id: "li1", t: "list_item", attrs: { kind: "ordered" }, text: "First step" },
  ]);
  const result = captureArea(a.editor.state.doc, ["li1"]);
  expect(result.status).toBe("ok");
  const proposal = proposeArea(a.editor.state, result.capture, '<ul><li data-id="li1">First step, revised</li></ul>', { seed: "kind" });
  expect(proposal.status).toBe("ready");
  keep(a, result.capture, proposal);
  await sim.idle();
  expect(nodeOf(a, "li1").attrs.kind).toBe("bullet");
  expect(textOf(a, "li1")).toBe("First step, revised");
});

test("a plain reply of the same length removes the link it no longer writes", async () => {
  const { sim, a } = await pair([{ id: "p1", text: "Visit the site" }]);
  const at = select(a, "p1");
  a.editor.dispatch(a.editor.state.tr.addMark(at, at + 5, schema.marks.link.create({ href: "https://example.com/old" })));
  await sim.idle();
  const result = captureArea(a.editor.state.doc, ["p1"]);
  expect(result.status).toBe("ok");
  expect(result.capture.html).toContain("<a");
  const proposal = proposeArea(a.editor.state, result.capture, '<p data-id="p1">Read about it!</p>', { seed: "link" });
  expect(proposal.status).toBe("ready");
  keep(a, result.capture, proposal);
  await sim.idle();
  expect(textOf(a, "p1")).toBe("Read about it!");
  expect(blockOf(a, "p1").m).toBeUndefined();
});

test("a reply whose checkbox is unchecked unchecks the item", async () => {
  const { sim, a } = await pair([
    { id: "li1", t: "list_item", attrs: { kind: "check", checked: true }, text: "Book the venue" },
  ]);
  const result = captureArea(a.editor.state.doc, ["li1"]);
  expect(result.status).toBe("ok");
  const proposal = proposeArea(a.editor.state, result.capture, '<ul><li data-id="li1"><input type="checkbox" disabled>Book the venue</li></ul>', { seed: "uncheck" });
  expect(proposal.status).toBe("ready");
  keep(a, result.capture, proposal);
  await sim.idle();
  expect(nodeOf(a, "li1").attrs.kind).toBe("check");
  expect(nodeOf(a, "li1").attrs.checked).toBe(false);
});

test("a held image between text inside a toggle keeps the nesting of the text after it", async () => {
  const { sim, a } = await pair([
    { id: "t1", t: "toggle", attrs: { open: true }, text: "Details" },
    { id: "c1", attrs: { parent: "t1" }, text: "Before image." },
    { id: "img", t: "image", attrs: { src: "sample.png", alt: "Sample", parent: "t1" } },
    { id: "c2", attrs: { parent: "t1" }, text: "After image." },
    { id: "outside", text: "Outside" },
  ]);
  const result = captureArea(a.editor.state.doc, ["t1", "c1", "img", "c2"]);
  expect(result.status).toBe("ok");
  expect(result.capture.html).toContain('hr data-id="img"');
  const html = result.capture.html.replace("Before image.", "Before image, revised.");
  const proposal = proposeArea(a.editor.state, result.capture, html, { seed: "nesting" });
  expect(proposal.status).toBe("ready");
  keep(a, result.capture, proposal);
  await sim.idle();
  expect(blockOf(a, "c1").parent).toBe("t1");
  expect(blockOf(a, "img").parent).toBe("t1");
  expect(blockOf(a, "c2").parent).toBe("t1");
});

test("a held board with a card survives a text rewrite around it", async () => {
  const { sim, a } = await pair([
    { id: "p1", text: "Before board." },
    { id: "board", t: "board", attrs: { columns: { todo: { pos: "B", name: "To do" } }, cards: { task: { pos: "B", col: "todo", title: "Book a venue" } } } },
    { id: "p2", text: "After board." },
  ]);
  const result = captureArea(a.editor.state.doc, ["p1", "board", "p2"]);
  expect(result.status).toBe("ok");
  const proposal = proposeArea(a.editor.state, result.capture, result.capture.html.replace("Before board.", "Before board, revised."), { seed: "board" });
  expect(proposal.status).toBe("ready");
  keep(a, result.capture, proposal);
  await sim.idle();
  expect(blockOf(a, "board").cards.task.title).toBe("Book a venue");
  expect(textOf(a, "p1")).toBe("Before board, revised.");
});

test("an opaque block outside the span captures and stays untouched", () => {
  const opaque = schema.nodes.opaque_block.create({ id: "opaque1", pos: null, raw: { t: "mystery" } });
  const doc = schema.nodes.doc.create(null, [
    opaque,
    schema.nodes.paragraph.create({ id: "p1", pos: null }, schema.text("First.")),
    schema.nodes.paragraph.create({ id: "p2", pos: null }, schema.text("Second.")),
  ]);
  const state = pmState.EditorState.create({ doc, plugins: [identityPlugin()] });
  const result = captureArea(state.doc, ["p1", "p2"]);
  expect(result.status).toBe("ok");
  const proposal = proposeArea(state, result.capture, '<p data-id="p1">First, revised.</p><p data-id="p2">Second, revised.</p>', { seed: "opaque" });
  expect(proposal.status).toBe("ready");
  const kept = keepAreaTransaction(state, result.capture, proposal);
  expect(kept.status).toBe("ok");
  const after = state.apply(kept.tr).doc;
  const ids = [];
  after.forEach((node) => ids.push(node.attrs.id));
  expect(ids).toEqual(["opaque1", "p1", "p2"]);
  expect(blockMap(after).p1.c).toBe("First, revised.");
});
