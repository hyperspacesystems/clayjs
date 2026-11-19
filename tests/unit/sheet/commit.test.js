/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, expect, jest, test } from "@jest/globals";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

function page(body) {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.Sap;
  delete window.sapPlugins;
  delete window.clayEditMode;
  window.clay = { ready: new Promise(() => {}) };
  document.head.innerHTML = "";
  document.body.innerHTML = body;
}

const loadCore = async () => (await import("../../../src/vendor/sap-core.vendor.js")).default;

const BOOK = () => `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="3">3</td><td n></td></tr>
<tr data-id="r2" data-pos="l"><td n v="4">4</td><td n></td></tr>
</tbody></table></section>

<section item data-id="s2" data-pos="l"><h2 bind="name">Sheet2</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n f="=Sheet1!A1*2" v="0">0</td><td n></td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit>{"rev":1}</script>
</div>
</main>`;

async function start(body = BOOK()) {
  page(body);
  const Sap = await loadCore();
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const { commitCell, tabTable } = await import("../../../src/sheet/commit.js");
  const onRebuild = jest.fn();
  const books = ownWorkbooks({ onRebuild });
  await books.ready;
  Sap.mount();
  await turn();
  const root = document.querySelector("[sheet-workbook]");
  return { Sap, books, book: books.books.get(root), root, onRebuild, commitCell, tabTable };
}

const tableOf = (id) => document.querySelector(`section[data-id="${id}"] table[grid]`);

function docOf(inner) {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body><main sap plugins="grid"><div items="sheets" sheet-workbook>${inner}</div></main></body></html>`,
    "text/html",
  );
}

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  jest.restoreAllMocks();
});

// Bug: the commit used the row index taken when the edit began instead of resolving the row id on commit.
test("the value lands by id after a row was inserted above the cell while editing", async () => {
  const { Sap, root, commitCell } = await start();
  const target = { tab: "s1", row: "r2", col: "c2" };

  Sap.grid(tableOf("s1")).insertRows("1", 1);
  const res = commitCell(root, target, "99");

  expect(res).toEqual({ ok: true, changed: true });
  expect(Sap.grid(tableOf("s1")).get("B3")).toBe(99);
  expect(Sap.grid(tableOf("s1")).get("B2")).toBeNull();
});

// Bug: the commit held the old table element from when editing began, whose Grid was disposed by a merge.
test("the value lands in the new table after a merge replaced the tab's table", async () => {
  const { Sap, book, root, commitCell, tabTable } = await start();
  const saved = book.serialize({ purpose: "save" });
  const oldTable = tabTable(root, "s1");
  const target = { tab: "s1", row: "r2", col: "c2" };

  const peer = docOf(saved);
  peer.querySelector('section[data-id="s1"] tr[data-id="r1"] td').textContent = "10";
  peer.querySelector('section[data-id="s1"] tr[data-id="r1"] td').setAttribute("v", "10");
  book.merge({ document: peer, base: docOf(saved) })();
  expect(tableOf("s1")).not.toBe(oldTable);

  const res = commitCell(root, target, "77");
  expect(res).toEqual({ ok: true, changed: true });
  expect(Sap.grid(tableOf("s1")).get("B2")).toBe(77);
  expect(book.serialize({})).toContain(">77<");
});

// Bug: a deleted row fell back to an index and overwrote the row below.
test("a row deleted while editing gives gone and leaves the workbook's bytes unchanged", async () => {
  const { Sap, book, root, commitCell } = await start();
  const target = { tab: "s1", row: "r1", col: "c1" };

  Sap.grid(tableOf("s1")).deleteRows("1:1");
  const before = book.serialize({});
  const rev = book.revision;

  const res = commitCell(root, target, "500");
  expect(res).toEqual({ ok: false, why: "gone" });
  expect(book.serialize({})).toBe(before);
  expect(book.revision).toBe(rev);
});

// Bug: Enter on an untouched cell dispatched a set action, moved the owner's revision and triggered a save.
test("committing the cell's own editor text makes no action and keeps the owner's revision", async () => {
  const { book, root, commitCell } = await start();
  expect(book.revision).toBe(0);

  const res = commitCell(root, { tab: "s1", row: "r1", col: "c1" }, "3");
  expect(res).toEqual({ ok: true, changed: false });
  expect(book.revision).toBe(0);
});

// Bug: the commit wrote textContent directly instead of going through Sap.grid.set's input parser and engine.
test("=A1*3 commits as a formula with its computed result in saved bytes, and '007 commits as text", async () => {
  const { Sap, book, root, commitCell } = await start();

  expect(commitCell(root, { tab: "s1", row: "r2", col: "c2" }, "=A1*3")).toEqual({ ok: true, changed: true });
  expect(commitCell(root, { tab: "s1", row: "r1", col: "c2" }, "'007")).toEqual({ ok: true, changed: true });

  expect(Sap.grid(tableOf("s1")).input("B2")).toBe("=A1*3");
  expect(Sap.grid(tableOf("s1")).get("B2")).toBe(9);
  expect(Sap.grid(tableOf("s1")).get("B1")).toBe("007");
  const bytes = book.serialize({});
  expect(bytes).toContain('f="=A1*3"');
  expect(bytes).toContain(">9<");
  expect(bytes).toContain('t=""');
  expect(bytes).toContain(">007<");
});

// Bug: commitCell swallowed unexpected runtime bugs or let GridRefused crash the editor.
test("a GridRefused error returns refused with the error, and any other error is rethrown", async () => {
  const { root, commitCell } = await start();
  const refused = Object.assign(new Error("read only"), { name: "GridRefused", code: "read_only" });
  window.Sap.grid = () => ({
    input: () => "",
    set: () => {
      throw refused;
    },
  });

  expect(commitCell(root, { tab: "s1", row: "r1", col: "c2" }, "12")).toEqual({
    ok: false,
    why: "refused",
    error: refused,
  });

  window.Sap.grid = () => ({
    input: () => "",
    set: () => {
      throw new TypeError("unexpected");
    },
  });
  expect(() => commitCell(root, { tab: "s1", row: "r1", col: "c2" }, "12")).toThrow(TypeError);
});

// Bug: rowIndex skipped table.tHead and overwrote the frozen header row A1 when committing the first tbody row.
test("a table with a frozen thead row commits to the tbody row, leaving thead untouched", async () => {
  const frozenBook = `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<thead><tr data-id="rh" data-pos="G"><td>Item</td><td>Cost</td></tr></thead>
<tbody><tr data-id="r1" data-pos="V"><td>Rent</td><td n v="1200">1200</td></tr></tbody></table></section>
</div></main>`;
  const { Sap, root, commitCell } = await start(frozenBook);

  expect(commitCell(root, { tab: "s1", row: "r1", col: "c2" }, "1350")).toEqual({ ok: true, changed: true });
  expect(Sap.grid(tableOf("s1")).get("B1")).toBe("Cost");
  expect(Sap.grid(tableOf("s1")).get("B2")).toBe(1350);
});
