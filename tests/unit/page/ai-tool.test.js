import { jest } from "@jest/globals";
import { createStore } from "../../../src/live/store.js";
import { createPageAi } from "../../../src/page/ai-surface.js";
import { capabilityAdvertised } from "../../../src/page/tool-capability.js";
import { previewShown } from "../../../src/page/ai-preview.js";
import { history } from "../../../src/vendor/prosemirror.vendor.js";
import { editor, ids, posOf, select, typeText } from "./view-helpers.js";

/**
 * /ai tools as contract A targets: what goes over the `page-tool` helper, what the
 * preview touches, and what Keep writes. The panel that drives these targets is
 * ai-edit's, so nothing here builds chrome.
 */

const artifact = (title) => ({
  title,
  html: `<output>${title}</output>`,
  css: "",
  javascript: "function mount() {}",
  fallbackHtml: `<p>${title}</p>`,
  summary: title,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const baseClay = window.clay;
let view, ai, live, sent, acceptState, saveResult;

function setup({ blocks = [["p", "paragraph", ""]], tools = {}, accepting = true, save = { ok: true } } = {}) {
  document.body.innerHTML = '<article data-page="1"></article>';
  live = createStore({ name: "page.tools", value: tools }).handle;
  sent = [];
  window.clay = {
    wire: {
      send(payload, options) {
        let finish;
        const done = new Promise((resolve) => { finish = resolve; });
        sent.push({ payload, options, cancel: jest.fn(), finish });
        return { done, cancel: sent[sent.length - 1].cancel };
      },
    },
    save: { flush: jest.fn(async () => ({ ok: true })) },
  };
  saveResult = save;
  acceptState = jest.fn(async () => saveResult);
  view = editor(blocks);
  ai = createPageAi({
    getView: () => view,
    store: accepting ? live : { set() { throw new Error("state-too-large"); } },
    acceptState,
  });
}

const reply = (id, title, state = { count: 2 }) => ({ state: "done", result: { requestId: id, artifact: artifact(title), state } });

async function generate(target, comment = "make a counter") {
  const started = await target.start(comment);
  expect(started.status).toBe("ok");
  const handle = started.send({});
  sent.at(-1).finish(reply(started.id, "Made"));
  const outcome = await handle.done;
  expect(outcome.state).toBe("done");
  return { handle, outcome };
}

afterEach(() => {
  if (view && !view.isDestroyed) view.destroy();
  view = ai = live = null;
  window.clay = baseClay;
  document.body.innerHTML = "";
});

test("the capability reads the document's helper list, never the old extension", () => {
  expect(capabilityAdvertised({ extensions: ["page"] })).toBe(false);
  expect(capabilityAdvertised({ extensions: ["page", "page-tool/1"] })).toBe(false);
  expect(capabilityAdvertised({ extensions: [], document: { helpers: [{ name: "ai-edit", state: "ready" }] } })).toBe(false);
  expect(capabilityAdvertised({ extensions: [], document: { helpers: [{ name: "page-tool", state: "ready" }] } })).toBe(true);
  expect(capabilityAdvertised({ extensions: [], document: { helpers: [{ name: "page-tool", state: "unavailable" }] } })).toBe(true);
  expect(capabilityAdvertised({ extensions: [], document: { helpers: [{ name: "page-tool", state: "denied" }] } })).toBe(false);
});

test("a new tool's request is the page-tool protocol with the page's context and no revision", async () => {
  setup({ blocks: [["h", "heading", "Research"], ["p", "paragraph", "Notes"]] });
  const target = ai.newTool(null);
  expect(target.aiTarget).toBe(true);
  // The host keeps the request id in a UUID column, so it is the browser's own.
  const uuid = "3b1c9f4e-6d2a-4c8f-9a1b-7e5d3c2b1a09";
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: () => uuid, configurable: true });
  try {
    await target.start("make a tally");
  } finally {
    delete globalThis.crypto.randomUUID;
  }

  const [call] = sent;
  expect(call.payload).toEqual({
    protocol: "page-tool/1",
    requestId: call.payload.requestId,
    prompt: "make a tally",
    context: { title: document.title, outline: [{ level: 2, text: "Research" }], tables: [] },
    target: null,
    current: null,
  });
  expect(call.payload.requestId).toBe(uuid);
  expect(call.options).toMatchObject({ helper: "page-tool", document: "none", id: call.payload.requestId });
});

test("Generate previews without touching the document, then Keep saves state before one block in one undo step", async () => {
  setup();
  const before = view.state.doc.toJSON();
  const target = ai.newTool(null);
  const { outcome } = await generate(target);

  expect((await target.propose(outcome.result)).status).toBe("ready");
  expect(previewShown(view.state)).toBe(true);
  expect(view.state.doc.toJSON()).toEqual(before);
  expect(live.data).toEqual({});
  expect(view.dom.querySelector(".page-ai-preview output").textContent).toBe("Made");

  const kept = await target.keep();
  expect(kept.status).toBe("kept");
  expect(acceptState).toHaveBeenCalled();
  expect(view.state.doc.child(0).type.name).toBe("tool");
  expect(previewShown(view.state)).toBe(false);
  const node = view.state.doc.child(0);
  expect(live.data[node.attrs.id][node.attrs.rev]).toEqual({ count: 2 });

  history.undo(view.state, view.dispatch);
  expect(view.state.doc.child(0).type.name).toBe("paragraph");
});

test("a state write the store refuses leaves no block and says why", async () => {
  setup({ accepting: false });
  const target = ai.newTool(null);
  const { outcome } = await generate(target);
  await target.propose(outcome.result);

  const kept = await target.keep();

  expect(kept).toEqual({ status: "failed", message: "state-too-large" });
  expect(view.state.doc.child(0).type.name).toBe("paragraph");
  expect(ids(view)).toEqual(["p"]);
});

test("a save that does not accept the new state leaves no block", async () => {
  setup({ save: { ok: false, msgType: "skipped", msg: "Save already in progress" } });
  const target = ai.newTool(null);
  const { outcome } = await generate(target);
  await target.propose(outcome.result);

  expect(await target.keep()).toEqual({ status: "failed", message: "Save already in progress" });
  expect(view.state.doc.child(0).type.name).toBe("paragraph");
});

test("a save that fails after the block is applied keeps the edit and retries the save alone", async () => {
  setup();
  const target = ai.newTool(null);
  const { outcome } = await generate(target);
  await target.propose(outcome.result);
  // The state is accepted, the block's own save fails once and the retry lands.
  acceptState
    .mockImplementationOnce(async () => ({ ok: true }))
    .mockImplementationOnce(() => { throw new Error("offline"); })
    .mockImplementationOnce(async () => ({ ok: true }));

  expect(await target.keep()).toEqual({ status: "kept" });
  expect(acceptState).toHaveBeenCalledTimes(3);
  expect(view.state.doc.child(0).type.name).toBe("tool");
  // Nothing asked the model a second time.
  expect(sent).toHaveLength(1);
});

test("a save that never accepts says the tool is kept in the document", async () => {
  setup();
  const target = ai.newTool(null);
  const { outcome } = await generate(target);
  await target.propose(outcome.result);
  acceptState
    .mockImplementationOnce(async () => ({ ok: true }))
    .mockImplementation(async () => ({ ok: false, msg: "Save failed" }));

  const kept = await target.keep();

  expect(kept.status).toBe("failed");
  expect(kept.message).toContain("Your tool is in the document");
  expect(view.state.doc.child(0).type.name).toBe("tool");
});

test("Discard cancels the request and a late result never inserts", async () => {
  setup();
  const target = ai.newTool(null);
  const started = await target.start("counter");
  const handle = started.send({});
  target.discard();
  expect(sent[0].cancel).toHaveBeenCalled();

  sent[0].finish(reply(started.id, "Late"));
  expect((await handle.done).state).toBe("error");
  await settle();
  expect(view.state.doc.child(0).type.name).toBe("paragraph");
  expect(previewShown(view.state)).toBe(false);
});

test("a result for another request is ignored", async () => {
  setup();
  const target = ai.newTool(null);
  const started = await target.start("counter");
  const handle = started.send({});
  sent[0].finish(reply("someone-elses-id", "Wrong"));

  expect(await Promise.race([handle.done, settle().then(() => "pending")])).toBe("pending");
  expect(await target.propose({ artifact: artifact("Wrong"), state: {} })).toMatchObject({ status: "ready" });
});

test("the /ai pick replaces its own slash text and keeps what was typed before it", async () => {
  setup({ blocks: [["p", "paragraph", "hello "]] });
  const view2 = view;
  view2.coordsAtPos = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
  select(view2, view2.state.doc.content.size - 1);
  const at = view2.state.doc.content.size - 1;
  for (const char of "/ai") typeText(view2, char);
  const target = ai.newTool({ from: at, to: view2.state.selection.head });
  const { outcome } = await generate(target);
  await target.propose(outcome.result);

  expect(await target.keep()).toEqual({ status: "kept" });
  expect(view2.state.doc.child(0).textContent).toBe("hello ");
  expect(view2.state.doc.child(1).type.name).toBe("tool");
});

test("a lost slash bookmark asks where to insert instead of using the caret that moved", async () => {
  setup({ blocks: [["p", "paragraph", "/ai"]] });
  const at = posOf(view, "p");
  const target = ai.newTool({ from: at + 1, to: at + 4 });
  const { outcome } = await generate(target);
  expect((await target.propose(outcome.result)).status).toBe("ready");
  // The block the /ai lived in goes away while the model works.
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.child(0).nodeSize, view.state.schema.nodes.paragraph.create({ id: "other", pos: "V" })));

  const kept = await target.keep();

  expect(kept.status).toBe("failed");
  expect(kept.message).toContain("moved");
  expect(ids(view)).toEqual(["other"]);
});

test("a revision sends the tool's live artifact and state as current, and Keep replaces it in one step", async () => {
  setup({
    blocks: [["t", "tool", "", { artifact: artifact("Old"), rev: "r1", state: { count: 1 } }]],
    tools: { t: { r1: { count: 1 } } },
  });
  const target = ai.reviseTool("t");
  const started = await target.start("make it bigger");
  expect(sent[0].payload.target).toEqual({ toolId: "t", rev: "r1" });
  expect(sent[0].payload.current).toEqual({ artifact: artifact("Old"), state: { count: 1 } });

  const handle = started.send({});
  sent[0].finish(reply(started.id, "New", { count: 9 }));
  await target.propose((await handle.done).result);
  expect(previewShown(view.state)).toBe(true);

  expect(await target.keep()).toEqual({ status: "kept" });
  expect(view.state.doc.child(0).attrs.artifact.title).toBe("New");
  expect(view.state.doc.child(0).attrs.rev).not.toBe("r1");
  expect(live.data.t.r1).toEqual({ count: 1 });

  history.undo(view.state, view.dispatch);
  expect(view.state.doc.child(0).attrs.rev).toBe("r1");
});

test("a tool someone else revised while the model worked is not replaced", async () => {
  setup({
    blocks: [["t", "tool", "", { artifact: artifact("Old"), rev: "r1", state: { count: 1 } }]],
    tools: { t: { r1: { count: 1 } } },
  });
  const target = ai.reviseTool("t");
  const { outcome } = await generate(target, "make it bigger");
  await target.propose(outcome.result);
  view.dispatch(view.state.tr.setNodeMarkup(0, null, { ...view.state.doc.child(0).attrs, rev: "other" }));

  const kept = await target.keep();

  expect(kept.status).toBe("failed");
  expect(kept.message).toContain("changed while you were revising");
  expect(view.state.doc.child(0).attrs.rev).toBe("other");
});

test("a tool block with a title differing only in quote marks is still not replaced", async () => {
  setup({
    blocks: [["t", "tool", "", { artifact: artifact("Old"), rev: "r1", state: { count: 1 } }]],
    tools: { t: { r1: { count: 1 } } },
  });
  const target = ai.reviseTool("t");
  const { outcome } = await generate(target, "make it bigger");
  await target.propose(outcome.result);
  // A peer's edit of the artifact alone, with the revision the request went out on.
  view.dispatch(view.state.tr.setNodeMarkup(0, null, { ...view.state.doc.child(0).attrs, artifact: artifact("Peer") }));

  expect(await target.keep()).toEqual({ status: "kept" });
  expect(view.state.doc.child(0).attrs.artifact.title).toBe("Made");
});

test("a page with no wire refuses the request without sending", async () => {
  setup();
  window.clay = { save: { flush: jest.fn() } };
  const target = ai.newTool(null);

  expect(await target.start("make a counter")).toEqual({
    status: "refused",
    code: "no-wire",
    message: "AI tool making isn't available on this page right now.",
  });
  expect(sent).toHaveLength(0);
});
