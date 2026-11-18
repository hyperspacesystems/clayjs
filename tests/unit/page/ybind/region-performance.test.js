import { createStore } from "../../../../src/live/store.js";
import { identityPlugin } from "../../../../src/page/model.js";
import { schema } from "../../../../src/page/schema.js";
import {
  state as pmState,
  view as pmView,
} from "../../../../src/vendor/prosemirror.vendor.js";
import {
  createYPageBinding,
  migrateHybridValues,
  bareShape,
  sameBareShape,
  docOf,
  walk,
  tokensOf,
  tokenIndex,
  textTokenRange,
} from "../../../../src/page/ybind/index.js";

globalThis.ClipboardEvent ??= class ClipboardEvent extends Event {};

test("text token ranges equal the full writer indexes and tokens", () => {
  const p = (id, content) => schema.nodes.paragraph.create({ id, pos: null }, content);
  const doc = schema.nodes.doc.create(null, [
    p("a", [schema.text("ab😀"), schema.nodes.hard_break.create(), schema.text("cd", [schema.marks.strong.create()])]),
    schema.nodes.divider.create({ id: "divider", pos: null }),
    p("b", schema.text("finish")),
  ]);
  const index = tokenIndex(doc), tokens = tokensOf(doc);
  doc.forEach((block, offset) => {
    if (!block.isTextblock) return;
    for (let from = offset + 1; from <= offset + 1 + block.content.size; from++) {
      for (const to of [from, Math.min(from + 1, offset + 1 + block.content.size), offset + 1 + block.content.size]) {
        const range = textTokenRange(doc, from, to);
        expect([range.start, range.end]).toEqual([index[from], index[to]]);
        expect(range.tokens).toEqual(tokens.slice(index[from], index[to]));
      }
    }
  });
});

test("the direct shape comparison agrees with the serialized mismatch check", () => {
  const p = (id, pos, text, marks = []) => schema.nodes.paragraph.create({ id, pos }, schema.text(text, marks));
  const base = schema.nodes.doc.create(null, [p("a", "A", "plain"), p("b", "B", "marked", [schema.marks.strong.create()])]);
  const variants = [
    schema.nodes.doc.create(null, [p("other", "Z", "plain"), p("again", "Y", "marked", [schema.marks.strong.create()])]),
    schema.nodes.doc.create(null, [p("a", "A", "changed"), p("b", "B", "marked", [schema.marks.strong.create()])]),
    schema.nodes.doc.create(null, [p("a", "A", "plain"), p("b", "B", "marked")]),
    schema.nodes.doc.create(null, [p("a", "A", "plain")]),
  ];
  for (const variant of variants) expect(sameBareShape(base, variant)).toBe(bareShape(base) === bareShape(variant));
});

test("region writes preserve mapped steps and an appended inline transaction", () => {
  const blocks = { first: { t: "paragraph", pos: "A", c: "ab😀cd" }, second: { t: "paragraph", pos: "B", c: "tail" } };
  const binding = createYPageBinding({ store: createStore({ name: "blockeditor", value: migrateHybridValues([{ blocks }]) }) });
  const append = new pmState.Plugin({ appendTransaction(transactions, _old, next) {
    if (!transactions.some((tr) => tr.docChanged) || transactions.some((tr) => tr.getMeta("appended"))) return null;
    return next.tr.insertText("!", 2).setMeta("appended", true);
  } });
  const mount = document.body.appendChild(document.createElement("div"));
  const view = new pmView.EditorView(mount, {
    state: pmState.EditorState.create({ doc: binding.doc(), plugins: [identityPlugin(), append] }),
    dispatchTransaction: (tr) => binding.dispatch(tr),
  });
  binding.attach(view);
  try {
    const secondAt = view.state.doc.child(0).nodeSize + 2;
    const tr = view.state.tr.insertText("Z", 2);
    tr.insert(3, schema.nodes.hard_break.create());
    tr.insertText("Q", tr.mapping.map(secondAt));
    view.dispatch(tr);
    expect(binding.stats.lastGroup.regional).toBe(true);
    expect(binding.stats.mismatch).toBe(0);
    expect(bareShape(view.state.doc)).toBe(bareShape(docOf(binding.pd, walk(binding.pd))));
  } finally {
    view.destroy();
    binding.dispose();
    mount.remove();
  }
});
