import { createStore } from "../../../../src/live/store.js";
import { createPageAi } from "../../../../src/page/ai-surface.js";
import { createPageEditor } from "../../../../src/page/editor.js";
import { createYPageBinding, seedValue } from "../../../../src/page/ybind/index.js";

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
