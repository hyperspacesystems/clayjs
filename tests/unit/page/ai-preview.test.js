import { createStore } from "../../../src/live/store.js";
import { createPageEditor } from "../../../src/page/editor.js";
import { createYPageBinding, seedValue } from "../../../src/page/ybind/index.js";
import { schema } from "../../../src/page/schema.js";
import { outline } from "../../../src/page/blocks.js";
import { aiPreviewKey, showPreview, clearPreview, previewShown } from "../../../src/page/ai-preview.js";

globalThis.ClipboardEvent ??= class ClipboardEvent extends Event {};

let mounted = null;

afterEach(() => {
  if (!mounted) return;
  const { view, el, binding, store } = mounted;
  mounted = null;
  if (!view.isDestroyed) view.destroy();
  el.remove();
  binding.dispose();
  store.destroy?.();
});

function mount(blocks = [
  { id: "p1", text: "First paragraph." },
  { id: "p2", text: "Second paragraph." },
  { id: "p3", text: "Third paragraph." },
]) {
  const store = createStore({ name: "blockeditor", value: seedValue(blocks) });
  const binding = createYPageBinding({ store, captureTimeout: 0 });
  const el = document.body.appendChild(document.createElement("div"));
  const view = createPageEditor(el, {
    doc: binding.doc(),
    dispatch: binding.dispatch,
    history: false,
    undo: binding.undo,
    redo: binding.redo,
    board: binding.board,
  });
  binding.attach(view);
  mounted = { store, binding, view, el };
  return mounted;
}

const previewNode = (view, text = "The proposed blocks.") => {
  const dom = view.dom.ownerDocument.createElement("div");
  dom.className = "blockeditor-ai-preview";
  dom.textContent = text;
  return dom;
};

test("a preview hides the chosen blocks and changes neither the document nor the store", () => {
  const { view, store } = mount();
  const doc = view.state.doc;
  const value = JSON.stringify(store.value);
  const hidden = outline(doc).find((e) => e.node.attrs.id === "p2");
  showPreview(view, { ids: ["p2"], dom: previewNode(view) });

  expect(view.state.doc).toBe(doc);
  expect(JSON.stringify(store.value)).toBe(value);
  expect(view.editable).toBe(false);
  expect(previewShown(view.state)).toBe(true);
  const marked = view.dom.querySelectorAll(".blockeditor-ai-hidden");
  expect(marked).toHaveLength(1);
  expect(marked[0].textContent).toBe("Second paragraph.");
  expect(view.dom.querySelector(".blockeditor-ai-preview").textContent).toBe("The proposed blocks.");
  const decos = aiPreviewKey.getState(view.state).decorations.find();
  expect(decos.some((d) => d.from === hidden.at && d.to === hidden.at + hidden.node.nodeSize)).toBe(true);

  clearPreview(view);

  expect(previewShown(view.state)).toBe(false);
  expect(view.editable).toBe(true);
  expect(view.dom.querySelectorAll(".blockeditor-ai-hidden")).toHaveLength(0);
  expect(view.dom.querySelector(".blockeditor-ai-preview")).toBe(null);
});

test("a transaction from elsewhere carries the decorations with the blocks", () => {
  const { view } = mount();
  showPreview(view, { ids: ["p2"], dom: previewNode(view) });

  view.dispatch(view.state.tr.insert(0, schema.nodes.paragraph.create({ id: "new", pos: null }, schema.text("Inserted first."))));

  const ents = outline(view.state.doc);
  const moved = ents.find((e) => e.node.attrs.id === "p2");
  const decos = aiPreviewKey.getState(view.state).decorations.find();
  const marked = decos.find((d) => !d.widget);
  const widget = decos.find((d) => d.widget);
  expect(marked.from).toBe(moved.at);
  expect(marked.to).toBe(moved.at + moved.node.nodeSize);
  expect(widget.from).toBe(moved.at);
  const shown = view.dom.querySelectorAll(".blockeditor-ai-hidden");
  expect(shown).toHaveLength(1);
  expect(shown[0].textContent).toBe("Second paragraph.");
  expect(view.editable).toBe(false);
});
