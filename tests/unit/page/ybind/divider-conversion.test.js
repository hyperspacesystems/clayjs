globalThis.ClipboardEvent ??= class ClipboardEvent extends Event { constructor(t, i = {}) { super(t); this.clipboardData = i.clipboardData ?? null; } };
import * as Y from "../../../../src/vendor/yjs.vendor.js";
import { createStore } from "../../../../src/live/store.js";
import { identityPlugin } from "../../../../src/page/model.js";
import { replaceWithDivider } from "../../../../src/page/items.js";
import { state as pmState, view as pmView } from "../../../../src/vendor/prosemirror.vendor.js";
import { createYPageBinding, seedValue, enc } from "../../../../src/page/ybind/index.js";
import { blocksFromYValue } from "../../../../src/page/ybind/decode.js";

const open = (initial) => {
  const store = createStore({ name: "blockeditor", value: initial });
  const binding = createYPageBinding({ store, setTimer: () => 1, clearTimer: () => {} });
  const view = new pmView.EditorView(document.body.appendChild(document.createElement("div")), {
    state: pmState.EditorState.create({ doc: binding.doc(), plugins: [identityPlugin()] }),
    dispatchTransaction: (tr) => binding.dispatch(tr),
  });
  binding.attach(view);
  return { store, binding, view };
};

const rows = (tab) => {
  const out = [];
  tab.view.state.doc.forEach((n) => out.push({ id: n.attrs.id, type: n.type.name, text: n.textContent, parent: n.attrs.parent ?? null }));
  return out;
};

let key = 0;
const send = (from, to) => {
  const update = enc(Y.encodeStateAsUpdateV2(from.binding.ydoc, Y.encodeStateVector(to.binding.ydoc)));
  const k = `remote${key++}`;
  to.store.rebase(
    { ...to.store.value, y: { ...to.store.value.y, [k]: update } },
    { source: "remote", frame: { ops: [{ op: "set", path: ["y", k], value: update }] } },
  );
};

const close = (tab) => { tab.view.destroy(); tab.binding.dispose(); tab.binding.ydoc.destroy(); };

const initial = () => seedValue([
  { id: "a", text: "first" },
  { id: "e", text: "" },
  { id: "z", text: "last" },
]);

test("an empty paragraph turned into a divider reaches a peer and the record as a divider", () => {
  const value = initial();
  const a = open(value), b = open(value);
  a.view.dispatch(replaceWithDivider(a.view.state.tr, 1));
  send(a, b);
  expect(rows(a)[1]).toMatchObject({ id: "e", type: "divider" });
  expect(rows(b)).toEqual(rows(a));
  expect(rows(b).map((r) => r.type)).toEqual(["paragraph", "divider", "paragraph", "paragraph"]);
  expect(blocksFromYValue(a.store.value).e).toMatchObject({ t: "divider" });
  expect(blocksFromYValue(b.store.value).e).toMatchObject({ t: "divider" });
  close(a); close(b);
});

test("undoing the divider conversion gives both tabs the empty paragraph back", () => {
  const value = initial();
  const a = open(value), b = open(value);
  a.view.dispatch(replaceWithDivider(a.view.state.tr, 1));
  send(a, b);
  a.binding.undo();
  send(a, b);
  expect(rows(a).map((r) => [r.id, r.type])).toEqual([["a", "paragraph"], ["e", "paragraph"], ["z", "paragraph"]]);
  expect(rows(b)).toEqual(rows(a));
  expect(blocksFromYValue(b.store.value).e).toMatchObject({ t: "paragraph" });
  close(a); close(b);
});
