/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, expect, jest, test } from "@jest/globals";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

const BOOK = () => `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="3">3</td><td n></td></tr>
<tr data-id="r2" data-pos="l"><td n v="4">4</td><td n></td></tr>
</tbody></table></section>
<section item data-id="s2" data-pos="l"><h2 bind="name">Sheet2</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n f="=Sheet1!A1*2" v="6">6</td><td n></td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit">{"rev":1}</script>
</div>
</main>`;

async function start() {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.Sap;
  delete window.sapPlugins;
  delete window.clayEditMode;
  window.clay = { ready: new Promise(() => {}) };
  document.head.innerHTML = "";
  document.body.innerHTML = BOOK();

  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const { createHistory } = await import("../../../src/sheet/history.js");
  const books = ownWorkbooks({});
  await books.ready;
  Sap.mount();
  await turn();

  const root = document.querySelector("[sheet-workbook]");
  const history = createHistory(root, (table) => Sap.grid(table));
  let mine = true;
  for (const section of root.querySelectorAll("section[item]")) {
    const tab = section.getAttribute("data-id");
    Sap.grid(section.querySelector("table[grid]")).on("change", (event) => {
      if (mine) history.record(tab, event);
    });
  }
  return {
    Sap,
    root,
    history,
    grid: (tab) => Sap.grid(document.querySelector(`section[data-id="${tab}"] table[grid]`)),
    peer(fn) {
      mine = false;
      try {
        return fn();
      } finally {
        mine = true;
      }
    },
  };
}

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  jest.restoreAllMocks();
});

// Bug: undo and redo kept the wrong inverse, so a redo put back a later value or an earlier one.
test("two commits undo one at a time back to the original and redo puts the first back", async () => {
  const { grid, history } = await start();
  grid("s1").set("B2", "5");
  grid("s1").set("B2", "6");

  expect(history.undo("s1").ok).toBe(true);
  expect(grid("s1").get("B2")).toBe(5);
  expect(history.undo("s1").ok).toBe(true);
  expect(grid("s1").get("B2")).toBeNull();
  expect(history.undo("s1")).toEqual({ ok: false, why: "empty" });

  expect(history.redo("s1").ok).toBe(true);
  expect(grid("s1").get("B2")).toBe(5);
});

// Bug: a redo reapplied a step over newer work.
test("a new commit after an undo empties the redo list", async () => {
  const { grid, history } = await start();
  grid("s1").set("B2", "5");
  history.undo("s1");

  grid("s1").set("B2", "7");

  expect(history.canRedo("s1")).toBe(false);
  expect(history.redo("s1")).toEqual({ ok: false, why: "empty" });
  expect(grid("s1").get("B2")).toBe(7);
});

// Bug: an undo overwrote a peer's later value in a cell the action wrote.
test("a peer's write to a cell the action wrote drops the step and the next undo goes to the one before", async () => {
  const { grid, history, peer } = await start();
  grid("s1").set("A1", "1");
  grid("s1").set("B2", "5");
  peer(() => grid("s1").set("B2", "peer"));

  expect(history.undo("s1")).toEqual({ ok: false, why: "changed" });
  expect(grid("s1").get("B2")).toBe("peer");
  expect(history.undo("s1").ok).toBe(true);
  expect(grid("s1").get("A1")).toBe(3);
});

// Bug: an undo wrote into another row after the row under the entry's cell was deleted.
test("a row deleted under the entry's cell makes the undo answer changed", async () => {
  const { grid, history, peer } = await start();
  grid("s1").set("B2", "5");
  peer(() => grid("s1").deleteRows("2:2"));

  expect(history.undo("s1")).toEqual({ ok: false, why: "changed" });
});

// Bug: the done list grew without a limit.
test("201 commits keep only the last 200 entries", async () => {
  const { grid, history } = await start();
  for (let n = 1; n <= 201; n++) grid("s1").set("B2", String(n));

  let undone = 0;
  while (history.undo("s1").ok) undone += 1;

  expect(undone).toBe(200);
  expect(grid("s1").get("B2")).toBe(1);
});

// Bug: the inverse of a workbook step was applied only on this tab, so another tab's formula stayed stale.
test("undoing a value that a formula on another tab reads updates that tab's result too", async () => {
  const { grid, history } = await start();
  grid("s1").set("A1", "5");
  expect(grid("s2").get("A1")).toBe(10);

  history.undo("s1");

  expect(grid("s1").get("A1")).toBe(3);
  expect(grid("s2").get("A1")).toBe(6);
});

// Bug: an undo pushed its own event back onto the list it was replaying.
test("while replaying, a change event is not recorded", async () => {
  const { grid, history } = await start();
  grid("s1").set("B2", "5");

  const res = history.undo("s1");

  expect(res.ok).toBe(true);
  expect(history.canUndo("s1")).toBe(false);
  expect(history.canRedo("s1")).toBe(true);
});

// Bug: undoing a paste that grew the sheet deleted the added column, destroying a peer's later value in it.
test("undoing a paste that grew the sheet keeps a peer's later value in an added column", async () => {
  const { grid, history, peer } = await start();
  grid("s1").importDelimited("10\t20", "C1", { delimiter: "\t" });
  expect(grid("s1").size.cols).toBe(4);
  peer(() => grid("s1").set("D2", "peer work"));

  expect(history.undo("s1")).toEqual({ ok: false, why: "changed" });
  expect(grid("s1").get("D2")).toBe("peer work");
  expect(grid("s1").size.cols).toBe(4);
});

// Bug: undoing a write reset a format a peer set on the same cell after it.
test("undoing a write leaves a peer's later format on the cell", async () => {
  const { grid, history, peer } = await start();
  grid("s1").set("B1", "5");
  peer(() => grid("s1").format("B1", { fmt: "$#,##0.00" }));

  expect(history.undo("s1")).toEqual({ ok: false, why: "changed" });
  expect(grid("s1").cell("B1").fmt).toBe("$#,##0.00");
  expect(grid("s1").get("B1")).toBe(5);
});

// Bug: a whole-column format recorded no cell, so an undo overwrote a coworker's later column format.
test("undoing a column format leaves a coworker's later percent format on that column", async () => {
  const { grid, history, peer } = await start();
  const colFmt = () => document.querySelector('section[data-id="s1"] col[data-id="c2"]').getAttribute("fmt");
  grid("s1").format("B:B", { fmt: "$#,##0.00" });
  expect(colFmt()).toBe("$#,##0.00");
  peer(() => grid("s1").format("B:B", { fmt: "0.00%" }));

  expect(history.undo("s1")).toEqual({ ok: false, why: "changed" });
  expect(colFmt()).toBe("0.00%");
  expect(grid("s1").cell("B1").effectiveFmt).toBe("0.00%");
});

// Bug: undoing a deleted row left another tab's formula cut, because only the action was replayed and
// not the step's restore list.
test("undoing a deleted row puts another tab's formula back from the step's restore", async () => {
  const { grid, history } = await start();
  expect(grid("s2").input("A1")).toBe("=Sheet1!A1*2");

  grid("s1").deleteRows("1:1");
  expect(grid("s2").input("A1")).not.toBe("=Sheet1!A1*2");

  expect(history.undo("s1").ok).toBe(true);

  expect(grid("s2").input("A1")).toBe("=Sheet1!A1*2");
  expect(grid("s2").get("A1")).toBe(6);
});

// Bug: history.group recorded separate undo entries or replayed parts in forward order on undo, leaving intermediate values behind.
test("a history group undoes its parts in reverse order as one entry and redoes them in forward order", async () => {
  const { grid, history } = await start();
  history.group("s1", () => {
    grid("s1").set("B1", "10");
    grid("s1").set("B2", "20");
    grid("s1").merge("B1:B2");
  });

  expect(grid("s1").cell("B1").span).toEqual({ rows: 2, cols: 1 });
  expect(grid("s1").get("B1")).toBe(10);

  const undone = history.undo("s1");
  expect(undone.ok).toBe(true);
  expect(history.canUndo("s1")).toBe(false);
  expect(grid("s1").cell("B1").span).toBeNull();
  expect(grid("s1").get("B1")).toBeNull();
  expect(grid("s1").get("B2")).toBeNull();

  const redone = history.redo("s1");
  expect(redone.ok).toBe(true);
  expect(grid("s1").cell("B1").span).toEqual({ rows: 2, cols: 1 });
  expect(grid("s1").get("B1")).toBe(10);
});

// Bug: undoing a group checked only the last part's cells, so an earlier part's inverse overwrote a peer's later edit.
test("a history group is refused when any part's cell changed after the group ran", async () => {
  const { grid, history, peer } = await start();
  history.group("s1", () => {
    grid("s1").set("B1", "10");
    grid("s1").set("B2", "20");
  });
  peer(() => grid("s1").set("B1", "peer-edit"));

  expect(history.undo("s1")).toEqual({ ok: false, why: "changed" });
  expect(grid("s1").get("B1")).toBe("peer-edit");
  expect(grid("s1").get("B2")).toBe(20);
});

// Bug: the history guard ignored cell.style, so undoing a write or format wiped out a coworker's later style on the cell.
test("a coworker's later style on a cell survives an undo", async () => {
  const { grid, history, peer } = await start();
  grid("s1").format("A1", { style: { "font-weight": "bold" } });
  peer(() => grid("s1").format("A1", { style: { "font-style": "italic" } }));

  expect(history.undo("s1")).toEqual({ ok: false, why: "changed" });
  expect(grid("s1").cell("A1").style).toContain("font-style:italic");
  expect(grid("s1").cell("A1").style).toContain("font-weight:bold");
});
