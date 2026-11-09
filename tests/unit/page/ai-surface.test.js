import { jest } from "@jest/globals";
import { createPageAi } from "../../../src/page/ai-surface.js";
import { selectBlocks } from "../../../src/page/blocksel.js";
import { previewShown } from "../../../src/page/ai-preview.js";
import { captureArea, proposeArea, keepAreaTransaction } from "../../../src/page/ai-area.js";
import { blockMap } from "../../../src/page/model.js";
import { project } from "../../../src/page/projection.js";
import { chartModel } from "../../../src/page/rich/chart.js";
import wire from "../../../src/plugins/wire.js";
import { editor, posOf, select } from "./view-helpers.js";

// The surface reads `window.clay.wire` when a request is sent, so a page with
// `exclude=wire` never pulls the module in. These pages have one.
const baseClay = window.clay;
beforeEach(() => { window.clay = { ...baseClay, wire }; });
afterEach(() => { window.clay = baseClay; });

const BLOCKS = [
  ["p1", "paragraph", "Alpha one."],
  ["p2", "paragraph", "Beta two."],
  ["p3", "paragraph", "Gamma three."],
];

const reply = (html) => ({ state: "done", result: { html } });

const area = (id, text) => `<div data-clay-area><p data-id="${id}">${text}</p></div>`;

// The surface is created per page, exactly as the page plugin creates it.
const surface = (view) => createPageAi({ getView: () => view });

async function startOn(ai, view, id) {
  select(view, posOf(view, id));
  const target = ai.targetFromSelection();
  const started = await target.start("Tighten this");
  expect(started.status).toBe("ok");
  return { target, started };
}

test("a caret names the block it sits in", () => {
  const view = editor(BLOCKS);
  const ai = surface(view);
  expect(ai.active()).toBe(true);

  select(view, posOf(view, "p2"));
  const target = ai.targetFromSelection();

  expect(target.aiTarget).toBe(true);
  expect(target.ref).toEqual(["p2"]);
  expect(target.quote).toBe(undefined);
  expect(target.isConnected).toBe(true);
});

test("a text selection inside one block quotes the words from the block's start", () => {
  const view = editor(BLOCKS);
  const ai = surface(view);

  select(view, posOf(view, "p2"), posOf(view, "p2") + 4);
  const target = ai.targetFromSelection();

  expect(target.ref).toEqual(["p2"]);
  expect(target.quote).toEqual({ text: "Beta", start: 0, end: 4 });
});

test("a selection across blocks names every touched block", () => {
  const view = editor(BLOCKS);
  const ai = surface(view);

  select(view, posOf(view, "p1") + 2, posOf(view, "p3") + 2);
  const target = ai.targetFromSelection();

  expect(target.ref).toEqual(["p1", "p2", "p3"]);
  expect(target.quote).toBe(undefined);
});

test("a block selection names its span", () => {
  const view = editor(BLOCKS);
  const ai = surface(view);

  const st = view.state;
  view.dispatch(st.tr.setSelection(selectBlocks(st.doc, 1, 2)));

  expect(ai.targetFromSelection().ref).toEqual(["p2", "p3"]);
});

test("a chosen toggle lifts its whole body", () => {
  const view = editor([
    ["t1", "toggle", "Details", { open: true }],
    ["c1", "paragraph", "Child one", { parent: "t1" }],
    ["after", "paragraph", "After the toggle"],
  ]);
  const ai = surface(view);

  const st = view.state;
  view.dispatch(st.tr.setSelection(selectBlocks(st.doc, 0)));

  expect(ai.targetFromSelection().ref).toEqual(["t1", "c1"]);
});

test("between spans one target to another and wholePage names every block", () => {
  const view = editor(BLOCKS);
  const ai = surface(view);

  select(view, posOf(view, "p1"));
  const first = ai.targetFromSelection();
  select(view, posOf(view, "p3"));
  const last = ai.targetFromSelection();

  expect(ai.between(first, last).ref).toEqual(["p1", "p2", "p3"]);
  expect(ai.between(last, first).ref).toEqual(["p1", "p2", "p3"]);
  expect(ai.wholePage().ref).toEqual(["p1", "p2", "p3"]);
});

test("extending a picked range upward keeps the blocks already selected below it", () => {
  const view = editor(BLOCKS);
  const ai = surface(view);
  const target = (id) => { select(view, posOf(view, id)); return ai.targetFromSelection(); };

  const second = target("p2");
  const third = target("p3");
  const first = target("p1");
  const selected = ai.between(second, third);
  expect(selected.ref).toEqual(["p2", "p3"]);

  expect(ai.between(selected, first).ref).toEqual(["p1", "p2", "p3"]);
});

test("the request carries the area and the block vocabulary", async () => {
  const view = editor(BLOCKS);
  const ai = surface(view);
  const send = jest.spyOn(wire, "send").mockReturnValue({
    done: Promise.resolve(reply(area("p2", "Beta two, edited."))),
    cancel: jest.fn(),
  });
  try {
    const { started } = await startOn(ai, view, "p2");
    await started.send({ onStatus() {} }).done;

    const [payload, options] = send.mock.calls[0];
    expect(options.helper).toBe("ai-edit");
    expect(payload.editId).toBe("page area");
    expect(payload.tag).toBe("div");
    expect(payload.elementHTML).toContain('data-id="p2"');
    expect(payload.elementHTML).not.toContain('data-id="p1"');
    expect(payload.comment).toContain("Tighten this");
    expect(payload.comment).toContain("data-clay-keep");
  } finally {
    send.mockRestore();
  }
});

test("a page with no wire is refused instead of sending", async () => {
  const view = editor(BLOCKS);
  const ai = surface(view);
  window.clay = undefined;

  select(view, posOf(view, "p2"));
  const target = ai.targetFromSelection();

  expect(await target.start("Tighten this")).toEqual({
    status: "refused",
    code: "no-wire",
    message: "AI editing isn't available on this page right now.",
  });
});

test("Keep is one transaction and one save flush", async () => {
  const view = editor(BLOCKS);
  const ai = surface(view);
  const send = jest.spyOn(wire, "send").mockReturnValue({
    done: Promise.resolve(reply(area("p2", "Beta two, edited."))),
    cancel: jest.fn(),
  });
  const clay = window.clay;
  try {
    const { target, started } = await startOn(ai, view, "p2");
    expect((await target.propose((await started.send({}).done).result)).status).toBe("ready");
    expect(previewShown(view.state)).toBe(true);

    const flush = jest.fn().mockResolvedValue({ ok: true });
    window.clay = { ...clay, save: { flush } };
    const dispatch = jest.spyOn(view, "dispatch");
    const kept = await target.keep();

    expect(kept.status).toBe("kept");
    expect(dispatch.mock.calls.filter(([tr]) => tr.docChanged)).toHaveLength(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(view.state.doc.textContent).toContain("Beta two, edited.");
    expect(previewShown(view.state)).toBe(false);
  } finally {
    window.clay = clay;
    send.mockRestore();
  }
});

test("Keep on an area someone else changed keeps nothing and says so", async () => {
  const view = editor(BLOCKS);
  const ai = surface(view);
  const send = jest.spyOn(wire, "send").mockReturnValue({
    done: Promise.resolve(reply(area("p2", "Beta two, edited."))),
    cancel: jest.fn(),
  });
  const clay = window.clay;
  try {
    const { target, started } = await startOn(ai, view, "p2");
    await target.propose((await started.send({}).done).result);
    view.dispatch(view.state.tr.insertText("Someone else typed. ", posOf(view, "p2")));

    const flush = jest.fn();
    window.clay = { ...clay, save: { flush } };
    const dispatch = jest.spyOn(view, "dispatch");
    const kept = await target.keep();

    expect(kept.status).toBe("failed");
    expect(kept.message).toBe("Someone changed this area while AI was working, so nothing was changed.");
    expect(dispatch.mock.calls.filter(([tr]) => tr.docChanged)).toHaveLength(0);
    expect(flush).not.toHaveBeenCalled();
    expect(view.state.doc.textContent).not.toContain("Beta two, edited.");
  } finally {
    window.clay = clay;
    send.mockRestore();
  }
});

test("two adding Keeps in a row create distinct blocks and the first keeps its text", async () => {
  const view = editor(BLOCKS);
  const ai = surface(view);
  const send = jest.spyOn(wire, "send")
    .mockReturnValueOnce({
      done: Promise.resolve(reply('<div data-clay-area><p data-id="p1">Alpha revised.</p><p>First addition.</p></div>')),
      cancel: jest.fn(),
    })
    .mockReturnValueOnce({
      done: Promise.resolve(reply('<div data-clay-area><p data-id="p2">Beta revised.</p><p>Second addition.</p></div>')),
      cancel: jest.fn(),
    });
  try {
    const first = await startOn(ai, view, "p1");
    expect((await first.target.propose((await first.started.send({}).done).result)).status).toBe("ready");
    expect((await first.target.keep()).status).toBe("kept");

    const second = await startOn(ai, view, "p2");
    expect((await second.target.propose((await second.started.send({}).done).result)).status).toBe("ready");
    expect((await second.target.keep()).status).toBe("kept");

    const texts = [];
    view.state.doc.forEach((node) => texts.push([node.attrs.id, node.textContent]));
    expect(texts).toHaveLength(5);
    const idOf = (text) => texts.find(([, c]) => c === text)?.[0];
    expect(idOf("First addition.")).toBeDefined();
    expect(idOf("Second addition.")).toBeDefined();
    expect(idOf("First addition.")).not.toBe(idOf("Second addition."));
  } finally {
    send.mockRestore();
  }
});

test("a rejected flush reports a failed save with its change already in the document", async () => {
  const view = editor(BLOCKS);
  const ai = surface(view);
  const send = jest.spyOn(wire, "send").mockReturnValue({
    done: Promise.resolve(reply(area("p2", "Beta two, edited."))),
    cancel: jest.fn(),
  });
  const clay = window.clay;
  try {
    const { target, started } = await startOn(ai, view, "p2");
    expect((await target.propose((await started.send({}).done).result)).status).toBe("ready");
    window.clay = { ...clay, save: { flush: jest.fn().mockRejectedValue(new Error("Save timed out.")) } };
    const kept = await target.keep();
    expect(kept).toEqual({
      status: "failed",
      message: "Your change is in the document, but saving failed. It will be saved with your next edit.",
    });
    expect(view.state.doc.textContent).toContain("Beta two, edited.");
    expect(previewShown(view.state)).toBe(false);
  } finally {
    window.clay = clay;
    send.mockRestore();
  }
});

const TOOL = {
  artifact: { title: "Tally", html: "<output>0</output>", css: "", javascript: "function mount() {}", fallbackHtml: "<p>0</p>", summary: "" },
  rev: "r1",
  state: { count: 1 },
};

test("a tool block under the pointer or in the selection is a Revise target, not a rewrite", () => {
  const view = editor([["p1", "paragraph", "Alpha one."], ["t1", "tool", "", TOOL], ["p3", "paragraph", "Gamma three."]]);
  const ai = surface(view);

  const st = view.state;
  view.dispatch(st.tr.setSelection(selectBlocks(st.doc, 1)));
  const fromCaret = ai.targetFromSelection();
  expect(fromCaret.aiTarget).toBe(true);
  expect(fromCaret.label).toBe("This tool");
  expect(fromCaret.ref).toEqual(["t1"]);

  view.posAtCoords = () => ({ pos: posOf(view, "t1"), inside: -1 });
  const under = ai.targetAt(0, 0);
  expect(under.label).toBe("This tool");
  expect(under.ref).toEqual(["t1"]);
});

test("a range that starts on a tool block stays one rewrite over every block it covers", () => {
  const view = editor([["p1", "paragraph", "Alpha one."], ["t1", "tool", "", TOOL], ["p3", "paragraph", "Gamma three."]]);
  const ai = surface(view);

  const st = view.state;
  view.dispatch(st.tr.setSelection(selectBlocks(st.doc, 1)));
  const tool = ai.targetFromSelection();
  select(view, posOf(view, "p3"));
  const paragraph = ai.targetFromSelection();

  const across = ai.between(tool, paragraph);
  expect(across.label).toBe("2 blocks");
  expect(across.ref).toEqual(["t1", "p3"]);
});

test("a table rewrite with no data-col keeps an outside chart's source and its column settings", () => {
  const view = editor([
    ["tbl", "table", "", {
      cols: { label: { pos: "B", name: "Month" }, amount: { pos: "C", name: "Revenue", kind: "number", width: 200 } },
      rows: { row1: { pos: "B", cells: { label: "Jan", amount: "10" } } },
    }],
    ["chart", "chart", "", { source: "tbl", x: "label", series: ["amount"], kind: "bar" }],
  ]);
  const before = blockMap(view.state.doc);
  const asChart = (blocks) => chartModel({ ...blocks.chart, type: blocks.chart.kind }, project(blocks).find((b) => b.id === "tbl"));
  expect(asChart(before).state).toBe("ok");

  const { capture } = captureArea(view.state.doc, ["tbl"]);
  const reply = '<table data-id="tbl"><thead><tr><th>Month</th><th>Revenue</th></tr></thead><tbody><tr data-id="row1"><td>January</td><td>10</td></tr></tbody></table>';
  const proposal = proposeArea(view.state, capture, reply, { seed: "table-cols" });
  expect(proposal.status).toBe("ready");
  const kept = keepAreaTransaction(view.state, capture, proposal);
  expect(kept.status).toBe("ok");
  view.dispatch(kept.tr);

  const after = blockMap(view.state.doc);
  expect(after.chart).toEqual(before.chart);
  expect(asChart(after).state).toBe("ok");
  expect(after.tbl.cols.amount).toEqual(expect.objectContaining({ kind: "number", width: 200 }));
});

test("a table rewrite that keeps every data-col keeps its column kind and width", () => {
  const view = editor([
    ["tbl", "table", "", {
      cols: { label: { pos: "B", name: "Month" }, amount: { pos: "C", name: "Revenue", kind: "number", width: 200 } },
      rows: { row1: { pos: "B", cells: { label: "Jan", amount: "10" } } },
    }],
  ]);
  const { capture } = captureArea(view.state.doc, ["tbl"]);
  const reply = '<table data-id="tbl"><thead><tr><th data-col="label">Month</th><th data-col="amount">Revenue</th></tr></thead><tbody><tr data-id="row1"><td>January</td><td>10</td></tr></tbody></table>';
  const proposal = proposeArea(view.state, capture, reply, { seed: "table-ids" });
  expect(proposal.status).toBe("ready");
  const kept = keepAreaTransaction(view.state, capture, proposal);
  expect(kept.status).toBe("ok");
  view.dispatch(kept.tr);

  expect(blockMap(view.state.doc).tbl.cols.amount).toEqual(expect.objectContaining({ kind: "number", width: 200 }));
});

test("Keep and Discard both return focus to the editor", async () => {
  const view = editor(BLOCKS);
  const ai = surface(view);
  const focus = jest.spyOn(view, "focus");
  const send = jest.spyOn(wire, "send").mockReturnValue({
    done: Promise.resolve(reply(area("p2", "Beta two, edited."))),
    cancel: jest.fn(),
  });
  try {
    const kept = await startOn(ai, view, "p2");
    expect((await kept.target.propose((await kept.started.send({}).done).result)).status).toBe("ready");
    expect((await kept.target.keep()).status).toBe("kept");
    expect(focus).toHaveBeenCalled();

    focus.mockClear();
    const discarded = await startOn(ai, view, "p1");
    expect((await discarded.target.propose((await discarded.started.send({}).done).result)).status).toBe("ready");
    discarded.target.discard();
    expect(focus).toHaveBeenCalled();
  } finally {
    send.mockRestore();
  }
});
