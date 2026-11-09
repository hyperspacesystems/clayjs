import * as Y from "../../../../src/vendor/yjs.vendor.js";
import { createStore } from "../../../../src/live/store.js";
import { createFastLane } from "../../../../src/live/fast-lane.js";
import { serializeLive, textHash } from "../../../../src/live/ops.js";
import { state as pmState, view as pmView } from "../../../../src/vendor/prosemirror.vendor.js";
import { schema } from "../../../../src/page/schema.js";
import { identityPlugin } from "../../../../src/page/model.js";
import { createPageAi } from "../../../../src/page/ai-surface.js";
import { createPageEditor } from "../../../../src/page/editor.js";
import { createYPageBinding, bareShape, seedValue } from "../../../../src/page/ybind/index.js";
import { Sim, createRoom } from "../collab/room-double.js";

/**
 * A kept /ai tool through the page's own binding: the block reaches the Y document as
 * one undoable step, and a revision keeps the old revision's state path untouched.
 */

const artifact = (title) => ({
  title,
  html: `<output>${title}</output>`,
  css: "",
  javascript: "function mount() {}",
  fallbackHtml: `<p>${title}</p>`,
  summary: title,
});

const PARAGRAPH = { id: "p", text: "Hi " };

const baseClay = window.clay;
const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  window.clay = baseClay;
});

function open({ blocks = [PARAGRAPH], tools = {} } = {}) {
  const store = createStore({ name: "page", value: seedValue(blocks.map((block) => ({ ...block }))) });
  const binding = createYPageBinding({ store, setTimer: () => 1, clearTimer: () => {} });
  const mount = document.body.appendChild(document.createElement("div"));
  const view = createPageEditor(mount, {
    doc: binding.doc(), dispatch: binding.dispatch, history: false, undo: binding.undo, redo: binding.redo,
    features: { ensure: () => Promise.resolve(), has: () => true, dispose() {} },
  });
  binding.attach(view);
  window.clay = {
    wire: {
      send(payload) {
        return {
          done: Promise.resolve({ state: "done", result: { requestId: payload.requestId, artifact: artifact("New"), state: { count: 7 } } }),
          cancel() {},
        };
      },
    },
  };
  const toolStore = createStore({ name: "page.tools", value: tools }).handle;
  const ai = createPageAi({ getView: () => view, store: toolStore, acceptState: async () => ({ ok: true }) });
  cleanups.push(() => {
    if (!view.isDestroyed) view.destroy();
    mount.remove();
    binding.dispose();
    binding.ydoc.destroy();
  });
  return { view, binding, tools: toolStore, ai };
}

async function generate(target) {
  const started = await target.start("make a counter");
  expect(started.status).toBe("ok");
  const outcome = await started.send({}).done;
  expect(outcome.state).toBe("done");
  expect((await target.propose(outcome.result)).status).toBe("ready");
}

test("a kept new tool is one undoable step in the binding's own document", async () => {
  const { view, binding, tools, ai } = open();
  const before = binding.doc().toJSON();

  const target = ai.newTool(null);
  await generate(target);
  expect(binding.doc().toJSON()).toEqual(before);

  expect(await target.keep()).toEqual({ status: "kept" });
  const node = view.state.doc.child(1);
  expect(node.type.name).toBe("tool");
  expect(binding.doc().child(1).attrs.id).toBe(node.attrs.id);
  expect(tools.data[node.attrs.id][node.attrs.rev]).toEqual({ count: 7 });

  expect(binding.undo()).toBe(true);
  expect(binding.doc().childCount).toBe(1);
  expect(binding.doc().child(0).type.name).toBe("paragraph");
});

test("a revised tool keeps the revision it replaced, and the state path it was read from", async () => {
  const { view, binding, tools, ai } = open({
    blocks: [PARAGRAPH, { id: "t", t: "tool", attrs: { artifact: artifact("Old"), rev: "r1" } }],
    tools: { t: { r1: { count: 1 } } },
  });

  const target = ai.reviseTool("t");
  await generate(target);
  expect(await target.keep()).toEqual({ status: "kept" });
  expect(view.state.doc.child(1).attrs.rev).not.toBe("r1");
  expect(binding.doc().child(1).attrs.artifact.title).toBe("New");
  expect(tools.data.t.r1).toEqual({ count: 1 });

  expect(binding.undo()).toBe(true);
  expect(binding.doc().child(1).attrs.rev).toBe("r1");
  expect(binding.doc().child(1).attrs.artifact.title).toBe("Old");
});


const clone = (v) => JSON.parse(JSON.stringify(v));

const TOOL_SEED = () => ({
  blocks: [PARAGRAPH, { id: "t", t: "tool", attrs: { artifact: artifact("Old"), rev: "r1" } }],
  tools: { t: { r1: { count: 1 } } },
});

let reply = null;
let tabCounter = 100;

function peer(sim, room, id, { blocks, page, tools, acceptState }) {
  const store = createStore({ name: "page", value: clone(page ?? seedValue(blocks)) });
  const toolStore = createStore({ name: "page.tools", value: clone(tools) });
  const entries = new Map([["page", { store }], ["page.tools", { store: toolStore }]]);
  const lane = createFastLane({ transport: room.transport(id, { person: id }), entries, now: sim.now, setTimer: sim.setTimer, clearTimer: sim.clearTimer });
  store.onLocal((ops) => lane.local("page", ops, store.mark));
  toolStore.onLocal((ops) => lane.local("page.tools", ops, toolStore.mark));
  const ydoc = new Y.Doc();
  ydoc.clientID = 10000 + tabCounter++;
  const binding = createYPageBinding({ store, ydoc, setTimer: sim.setTimer, clearTimer: sim.clearTimer, captureTimeout: 0 });
  const mount = document.body.appendChild(document.createElement("div"));
  const view = new pmView.EditorView(mount, {
    state: pmState.EditorState.create({ doc: binding.doc(), plugins: [identityPlugin()] }),
    dispatchTransaction: (tr) => binding.dispatch(tr),
  });
  binding.attach(view);
  const ai = createPageAi({
    getView: () => view,
    store: toolStore.handle,
    acceptState: acceptState ?? (async () => ({ ok: true })),
  });
  const tab = {
    id, store, tools: toolStore, lane, view, binding, ai,
    start() { lane.start(); room.open(id); },
    blocks() {
      const out = [];
      view.state.doc.forEach((node) => out.push([node.attrs.id, node.isTextblock ? node.textContent : node.type.name, node.type === schema.nodes.tool ? `${node.attrs.rev}:${node.attrs.artifact.title}` : null]));
      return out;
    },
  };
  cleanups.push(() => {
    if (!view.isDestroyed) view.destroy();
    mount.remove();
    binding.dispose();
    binding.ydoc.destroy();
  });
  return tab;
}

async function pair({ blocks, tools, roomOpts = {}, acceptState } = {}) {
  const seed = TOOL_SEED();
  const sim = new Sim(7);
  const initial = { page: clone(seedValue(blocks ?? seed.blocks)), "page.tools": clone(tools ?? seed.tools) };
  const room = createRoom(sim, initial, roomOpts);
  window.clay = {
    wire: {
      send(payload) {
        return {
          done: Promise.resolve({ state: "done", result: { requestId: payload.requestId, artifact: reply.artifact, state: reply.state } }),
          cancel() {},
        };
      },
    },
  };
  const a = peer(sim, room, "a", { blocks: blocks ?? seed.blocks, tools: tools ?? seed.tools, acceptState });
  const b = peer(sim, room, "b", { blocks: blocks ?? seed.blocks, tools: tools ?? seed.tools, acceptState });
  a.start();
  b.start();
  await sim.idle();
  return { sim, room, a, b };
}

async function replyTo(target, title, state) {
  reply = { artifact: artifact(title), state };
  const started = await target.start("make a counter");
  expect(started.status).toBe("ok");
  const outcome = await started.send({}).done;
  expect(outcome.state).toBe("done");
  expect((await target.propose(outcome.result)).status).toBe("ready");
}

function nodeOf(tab, id) {
  let found = null;
  tab.view.state.doc.forEach((node) => { if (node.attrs.id === id) found = node; });
  return found;
}

const toolOf = (tab, id) => nodeOf(tab, id)?.attrs ?? null;

function removeBlock(tab, id) {
  let at = null;
  tab.view.state.doc.forEach((node, pos) => { if (node.attrs.id === id) at = pos; });
  expect(at).not.toBeNull();
  const node = tab.view.state.doc.nodeAt(at);
  tab.view.dispatch(tab.view.state.tr.delete(at, at + node.nodeSize));
}

function save(sim, room, tab) {
  for (const [name, store] of [["page", tab.store], ["page.tools", tab.tools]]) {
    const fast = store.handle.status.mode === "fast";
    const value = clone(fast ? store.authoritative : store.value);
    const at = fast ? { epoch: tab.lane.status.epoch, seq: tab.lane.status.seq, hash: textHash(serializeLive(value)) } : null;
    const mark = store.mark;
    sim.after(40, () => room.fileWritten(name, value, at, null));
    sim.after(80, () => { if (!fast) store.confirm(mark); });
  }
}

async function reopen({ sim, room, a }) {
  save(sim, room, a);
  await sim.idle();
  const page = clone(room.stores.get("page").value);
  const tools = clone(room.stores.get("page.tools").value);
  room.land("page", room.seq);
  room.land("page.tools", room.seq);
  const fresh = peer(sim, room, "reopen", { page, tools });
  const opened = fresh.view.state.doc;
  fresh.start();
  await sim.idle(3000);
  expect(bareShape(fresh.view.state.doc)).toBe(bareShape(opened));
  return fresh;
}

async function settled({ sim, room, a, b }) {
  await sim.idle();
  expect(bareShape(a.view.state.doc)).toBe(bareShape(b.view.state.doc));
  expect(a.blocks()).toEqual(b.blocks());
  expect(b.tools.handle.toJSON()).toEqual(a.tools.handle.toJSON());
  const fresh = await reopen({ sim, room, a });
  expect(fresh.blocks()).toEqual(a.blocks());
  expect(fresh.tools.handle.toJSON()).toEqual(a.tools.handle.toJSON());
  return fresh;
}

test("schedule 1: A revises a tool while B increments its live state; A\u0027s Keep is refused and B\u0027s newer state stays live", async () => {
  const { sim, room, a, b } = await pair();
  const target = a.ai.reviseTool("t");
  await replyTo(target, "New", { count: 7 });

  b.tools.handle.set(["t", "r1", "count"], 2);
  await sim.idle();
  expect(a.tools.handle.toJSON().t.r1).toEqual({ count: 2 });
  expect(toolOf(a, "t").rev).toBe("r1");

  expect(await target.keep()).toEqual({
    status: "failed",
    message: "This tool\u0027s data changed while AI was working, so it was not replaced. Ask again to include the latest data.",
  });
  await sim.idle();
  const kept = toolOf(b, "t");
  expect(kept.artifact.title).toBe("Old");
  expect(kept.rev).toBe("r1");
  for (const tab of [a, b]) {
    expect(toolOf(tab, "t")).toEqual(kept);
    expect(tab.tools.handle.toJSON().t.r1).toEqual({ count: 2 });
    expect(Object.keys(tab.tools.handle.toJSON().t)).toEqual(["r1"]);
  }
  const fresh = await settled({ sim, room, a, b });
  expect(toolOf(fresh, "t").rev).toBe("r1");
  expect(fresh.tools.handle.toJSON().t.r1).toEqual({ count: 2 });
});

test("schedule 2: B revises the same tool and keeps; A\u0027s Keep is refused as stale and B\u0027s artifact stays paired with its revision", async () => {
  const { sim, room, a, b } = await pair();
  const aTarget = a.ai.reviseTool("t");
  await replyTo(aTarget, "From A", { count: 11 });

  const bTarget = b.ai.reviseTool("t");
  await replyTo(bTarget, "From B", { count: 22 });
  expect(await bTarget.keep()).toEqual({ status: "kept" });
  await sim.idle();
  const kept = toolOf(a, "t");
  expect(kept.artifact.title).toBe("From B");
  expect(kept.rev).not.toBe("r1");
  expect(b.tools.handle.toJSON().t[kept.rev]).toEqual({ count: 22 });

  const refused = await aTarget.keep();
  expect(refused.status).toBe("failed");
  await sim.idle();
  expect(toolOf(a, "t")).toEqual(kept);
  expect(toolOf(b, "t")).toEqual(kept);
  expect(a.tools.handle.toJSON().t[kept.rev]).toEqual({ count: 22 });
  await settled({ sim, room, a, b });
});

test("schedule 3: B deletes the tool; A\u0027s Keep is refused and does not bring the block back", async () => {
  const { sim, room, a, b } = await pair();
  const aTarget = a.ai.reviseTool("t");
  await replyTo(aTarget, "From A", { count: 11 });

  removeBlock(b, "t");
  await sim.idle();
  expect(nodeOf(a, "t")).toBeNull();
  expect(nodeOf(b, "t")).toBeNull();

  const refused = await aTarget.keep();
  expect(refused.status).toBe("failed");
  await sim.idle();
  expect(nodeOf(a, "t")).toBeNull();
  expect(nodeOf(b, "t")).toBeNull();
  expect(a.view.state.doc.childCount).toBe(1);
  expect(b.view.state.doc.childCount).toBe(1);
  await settled({ sim, room, a, b });
});

for (const first of ["a", "b"]) {
  test(`schedule 4 (${first} reaches the room first): both revise the same tool and keep before either receives the other\u0027s transaction`, async () => {
    const { sim, room, a, b } = await pair({ roomOpts: { answerLatency: (id) => (id === first ? 10 : 200) } });
    const aTarget = a.ai.reviseTool("t");
    await replyTo(aTarget, "From A", { count: 11 });
    const bTarget = b.ai.reviseTool("t");
    await replyTo(bTarget, "From B", { count: 22 });

    expect(await aTarget.keep()).toEqual({ status: "kept" });
    expect(await bTarget.keep()).toEqual({ status: "kept" });
    const revOf = (tab) => Object.keys(tab.tools.handle.toJSON().t).find((rev) => rev !== "r1");
    const revA = revOf(a);
    const revB = revOf(b);
    expect(revA).not.toBe(revB);
    expect(toolOf(a, "t").rev).toBe(revA);
    expect(toolOf(b, "t").rev).toBe(revB);

    await sim.idle();
    expect(room.stores.get("page").log.map((e) => e.from)).toEqual([first, first === "a" ? "b" : "a"]);
    const survivor = toolOf(a, "t");
    expect(toolOf(b, "t")).toEqual(survivor);
    expect(survivor.rev === revA || survivor.rev === revB).toBe(true);
    expect(survivor.artifact.title).toBe(survivor.rev === revA ? "From A" : "From B");
    for (const tab of [a, b]) {
      expect(tab.tools.handle.toJSON().t[revA]).toEqual({ count: 11 });
      expect(tab.tools.handle.toJSON().t[revB]).toEqual({ count: 22 });
      expect(tab.tools.handle.toJSON().t.r1).toEqual({ count: 1 });
    }
    const fresh = await settled({ sim, room, a, b });
    expect(toolOf(a, "t")).toEqual(survivor);
    expect(fresh.tools.handle.toJSON().t[revA]).toEqual({ count: 11 });
    expect(fresh.tools.handle.toJSON().t[revB]).toEqual({ count: 22 });
    expect(fresh.tools.handle.toJSON().t.r1).toEqual({ count: 1 });
  });
}

test("schedule 5: A\u0027s new tool state is accepted before its node broadcasts; B never runs another revision\u0027s state and both agree after a reconnect and reopen", async () => {
  let open;
  const gate = new Promise((resolve) => { open = () => resolve(); });
  const acceptState = async () => {
    await gate;
    return { ok: true };
  };
  const { sim, room, a, b } = await pair({ blocks: [PARAGRAPH], tools: {}, acceptState });

  const target = a.ai.newTool(null);
  await replyTo(target, "Made", { count: 7 });
  const keeping = target.keep();
  await sim.idle();
  const id = Object.keys(a.tools.handle.toJSON())[0];
  const rev = Object.keys(a.tools.handle.toJSON()[id])[0];
  expect(b.tools.handle.toJSON()[id]?.[rev]).toEqual({ count: 7 });
  expect(nodeOf(a, id)).toBeNull();
  expect(nodeOf(b, id)).toBeNull();

  open();
  expect(await keeping).toEqual({ status: "kept" });
  await sim.idle();
  expect(toolOf(a, id).artifact.title).toBe("Made");
  expect(toolOf(b, id)).toEqual(toolOf(a, id));
  expect(toolOf(b, id).rev).toBe(rev);
  for (const tab of [a, b]) expect(tab.tools.handle.toJSON()[id][toolOf(tab, id).rev]).toEqual({ count: 7 });

  room.close("a");
  await sim.idle();
  room.open("a");
  await sim.idle();
  expect(toolOf(a, id)).toEqual(toolOf(b, id));
  const fresh = await settled({ sim, room, a, b });
  const reopened = toolOf(fresh, id);
  const live = toolOf(a, id);
  expect([reopened.id, reopened.rev, reopened.artifact]).toEqual([live.id, live.rev, live.artifact]);
  expect(fresh.tools.handle.toJSON()[id][reopened.rev]).toEqual({ count: 7 });
});
