let snapshot;
let regions;
let contentDom;

const PAGE = `
  <header><input value="typed"><p>before</p></header>
  <section item data-id="tab-1"><h2>Tab</h2><table grid class="g"><tbody><tr><td>1</td><td>2</td></tr></tbody></table><p>after</p></section>
  <section item data-id="tab-2" no-snapshot><table grid><tbody><tr><td>hidden</td></tr></tbody></table></section>`;

beforeAll(async () => {
  window.clayEditMode = true;
  snapshot = await import("../../src/core/snapshot.js");
  regions = await import("../../src/lib/owned-regions.js");
  contentDom = await import("../../src/lib/content-dom.js");
});

const register = ({ selector, ...spec }) => regions.own(selector, spec);
let release = null;
beforeEach(() => { document.body.innerHTML = PAGE; });
afterEach(() => { release?.dispose(); release = null; });

const spec = (extra = {}) => ({ selector: "section[item] > table[grid]", serialize: () => "<tbody><tr><td>owner</td></tr></tbody>", revision: () => "r1", ...extra });

test("a view with holes copies a hole root without its children and everything else as before", () => {
  const table = document.querySelector("table[grid]");
  document.querySelector("input").value = "typed later";
  const plain = contentDom.createContentView(document.documentElement, { capability: "snapshot" });
  const view = contentDom.createContentView(document.documentElement, { capability: "snapshot", holes: new Map([[table, true]]) });
  expect(plain.holes).toEqual([]);
  expect(view.holes.length).toBe(1);
  expect(view.holes[0].live).toBe(table);
  expect(view.holes[0].copy.outerHTML).toBe('<table grid="" class="g"></table>');
  expect(view.original(view.holes[0].copy)).toBe(table);
  view.holes[0].copy.innerHTML = table.innerHTML;
  expect(view.root.outerHTML).toBe(plain.root.outerHTML);
  expect(view.root.querySelector("input").value).toBe("typed later");
  expect(view.root.querySelector("[no-snapshot]")).toBeNull();
});

test("a capture leaves one comment in each owned root and none of its cells", () => {
  release = register(spec());
  const clone = snapshot.captureSnapshot({ flushUndo: false });
  const copy = clone.querySelector("table[grid]");
  expect(copy.childNodes.length).toBe(1);
  expect(copy.firstChild.nodeType).toBe(8);
  expect(copy.firstChild.data.startsWith("clay-owned:")).toBe(true);
  expect(copy.firstChild.data.endsWith(":bn:2:38:r1<tbody><tr><td>owner</td></tr></tbody>")).toBe(true);
  expect(clone.querySelectorAll("td").length).toBe(0);
  expect(clone.querySelector("h2").textContent).toBe("Tab");
  const compare = snapshot.captureSnapshot({ flushUndo: false, owned: "revision" });
  expect(compare.querySelector("table[grid]").firstChild.data.endsWith(":rn:2:0:r1")).toBe(true);
});

test("registration checks its arguments and dispose stops owning", () => {
  expect(() => register({ selector: "", serialize() {}, revision() {} })).toThrow(TypeError);
  expect(() => register({ selector: "table", revision() {} })).toThrow(TypeError);
  expect(() => register({ selector: "table", serialize() {} })).toThrow(TypeError);
  expect(() => register({ selector: "table[", serialize() {}, revision() {} })).toThrow();
  expect(regions.hasOwnedRegions()).toBe(false);
  release = register(spec());
  expect(regions.hasOwnedRegions()).toBe(true);
  release.dispose();
  release = null;
  expect(regions.hasOwnedRegions()).toBe(false);
  expect(snapshot.captureSnapshot({ flushUndo: false }).querySelectorAll("td").length).toBe(2);
});

test("only the outermost matching root is owned, and body is never a root", () => {
  let calls = 0;
  release = register(spec({ selector: "body, section[item], table[grid]", serialize: () => { calls++; return "<p>owner</p>"; } }));
  const clone = snapshot.captureSnapshot({ flushUndo: false });
  expect(calls).toBe(2);
  const section = clone.querySelector('[data-id="tab-1"]');
  expect(section.childNodes.length).toBe(1);
  expect(section.firstChild.nodeType).toBe(8);
  expect(clone.querySelector("header p").textContent).toBe("before");
});
