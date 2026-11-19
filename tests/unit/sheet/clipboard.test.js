/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, expect, jest, test } from "@jest/globals";
import { copyParts, fillBlock, fillFormula, pasteBlock } from "../../../src/sheet/clipboard.js";
import { a1 } from "../../../src/sheet/commit.js";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

const BOOK = () => `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="l"><col data-id="c4" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="3">3</td><td n></td><td n></td><td n></td></tr>
<tr data-id="r2" data-pos="l"><td n></td><td n f="=A1*2" v="6" fmt="0.00">6.00</td><td n></td><td n></td></tr>
<tr data-id="r3" data-pos="l"><td n></td><td n></td><td n></td><td n></td></tr>
<tr data-id="r4" data-pos="l"><td n></td><td n></td><td n></td><td n></td></tr>
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
  const books = ownWorkbooks({});
  await books.ready;
  Sap.mount();
  await turn();
  const root = document.querySelector("[sheet-workbook]");
  return { Sap, grid: Sap.grid(root.querySelector("table[grid]")) };
}

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  jest.restoreAllMocks();
});

// Bug: a copied formula landed unmoved, or its format was lost.
test("a copy pasted elsewhere keeps contents and formats with formulas moved", async () => {
  const { grid } = await start();
  grid.set("A1", "3");

  const { html, text } = copyParts(grid, { top: 0, left: 0, bottom: 1, right: 1 }, a1);
  expect(text).toBe("3\t\r\n\t6.00");

  const res = pasteBlock(html, { r: 2, c: 2 });

  expect(res.kind).toBe("ours");
  expect(res.block[0][0].content).toBe(3);
  expect(res.block[0][0].fmt).toBeNull();
  expect(res.block[1][1].content).toEqual({ f: "=C3*2" });
  expect(res.block[1][1].fmt).toBe("0.00");
});

// Bug: our data attributes were trusted on a foreign table.
test("a foreign table pastes its shown texts", () => {
  const res = pasteBlock("<meta><table><tr><td>1,234</td><td>x</td></tr></table>", { r: 0, c: 0 });

  expect(res).toEqual({ kind: "foreign", block: [["1,234", "x"]] });
  expect(pasteBlock('<table data-sheet-origin=","><tr><td>1</td></tr></table>', { r: 0, c: 0 })).toEqual({ kind: "foreign", block: [["1"]] });
  expect(pasteBlock('<table data-sheet-origin="-1,0"><tr><td>1</td></tr></table>', { r: 0, c: 0 })).toEqual({ kind: "foreign", block: [["1"]] });
});

// Bug: a page's layout tables pasted.
test("two top-level tables or none give null", () => {
  expect(pasteBlock("<table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>", { r: 0, c: 0 })).toBeNull();
  expect(pasteBlock("<p>no table</p>", { r: 0, c: 0 })).toBeNull();
  expect(pasteBlock("", { r: 0, c: 0 })).toBeNull();
  expect(pasteBlock("<table><tr></tr></table>", { r: 0, c: 0 })).toBeNull();
});

// Bug: clipboard HTML was put into the page, so a cell's markup ran as script.
test("markup in a cell's text lands as that text and nothing is added to the page", () => {
  const markup = '<img src=x onerror=alert(1)>';
  const fake = {
    cell: () => ({ content: markup, text: markup, value: markup, fmt: null, effectiveFmt: null }),
    toDelimited: () => markup,
  };
  const { html } = copyParts(fake, { top: 0, left: 0, bottom: 0, right: 0 }, a1);
  const parse = jest.spyOn(DOMParser.prototype, "parseFromString");
  const before = document.body.innerHTML;

  const res = pasteBlock(html, { r: 0, c: 0 });

  expect(parse).toHaveBeenCalled();
  expect(res.block[0][0].content).toBe(markup);
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.innerHTML).toBe(before);
  expect(pasteBlock(`${markup}<table><tr><td>${markup}ok</td></tr></table>`, { r: 0, c: 0 })).toEqual({ kind: "foreign", block: [["ok"]] });
  expect(document.querySelector("img")).toBeNull();
  expect(document.body.innerHTML).toBe(before);
});

// Bug: values-only pasted a formula instead of its result.
test("valuesOnly gives the results of formulas, not the formulas", async () => {
  const { grid } = await start();
  grid.set("A1", "3");
  grid.set("B2", "=A1*2");

  const { html } = copyParts(grid, { top: 1, left: 1, bottom: 1, right: 1 }, a1);
  const res = pasteBlock(html, { r: 0, c: 0 }, { valuesOnly: true });

  expect(res.block[0][0]).toBe(6);
});

// Bug: the same formula was written into every cell of a larger selection.
test("a one-cell formula over a larger selection moves per cell", async () => {
  const { grid } = await start();
  grid.set("B1", "=A1");

  const { html } = copyParts(grid, { top: 0, left: 1, bottom: 0, right: 1 }, a1);
  const res = pasteBlock(html, { r: 0, c: 1 });
  const item = res.block[0][0];
  const dr = 0 - res.origin.r;
  const dc = 1 - res.origin.c;
  const filled = fillFormula(item.content.f, item.fmt, dr, dc, 2, 2);

  expect(filled.map((row) => row.map((cell) => cell.content.f))).toEqual([
    ["=A1", "=B1"],
    ["=A2", "=B2"],
  ]);
});

// Bug: a one-cell paste did not fill a larger selection.
test("fillBlock repeats one item over every cell of the selection", () => {
  expect(fillBlock([[42]], 2, 2)).toEqual([
    [42, 42],
    [42, 42],
  ]);
  expect(fillBlock([[42]], 1, 1)).toEqual([[42]]);
});

// Bug: a copied cell carried its own format, not the one its column gives it, so the paste lost it.
test("a cell's shown column format travels with the copy and shows after the paste", async () => {
  const { grid } = await start();
  grid.format("D:D", { fmt: "0.00" });
  grid.set("D1", "5");

  const { html } = copyParts(grid, { top: 0, left: 3, bottom: 0, right: 3 }, a1);
  expect(html).toContain('data-fmt="0.00"');

  const res = pasteBlock(html, { r: 0, c: 0 });
  grid.setRange("A1", res.block, { grow: true });

  expect(grid.cell("A1").text).toBe("5.00");
});

// Bug: an empty cell copied as two quote marks, so a paste into another app showed "".
test("an empty cell copies as empty text", async () => {
  const { grid } = await start();
  grid.set("A1", "3");

  const { text } = copyParts(grid, { top: 0, left: 2, bottom: 0, right: 2 }, a1);

  expect(text).toBe("");
});

// Bug: an unformatted cell pasted as undefined kept the format of the cell it landed on.
test("an unformatted cell pasted over a percent cell clears its format", async () => {
  const { grid } = await start();
  grid.format("C1", { fmt: "0%" });
  expect(grid.cell("C1").fmt).toBe("0%");

  const res = pasteBlock('<table data-sheet-origin="0,0"><tr><td data-content="3">3</td></tr></table>', { r: 0, c: 2 });

  expect(res.block[0][0].fmt).toBeNull();
  grid.setRange("C1", res.block, { grow: true });
  expect(grid.cell("C1").fmt).toBeNull();
  expect(grid.get("C1")).toBe(3);
});

// Bug: a copied formula moved when it was pasted, so a cut then pasted formula pointed at the wrong cells.
test("a cut table pastes its formulas unmoved while a copy still moves them", async () => {
  const { grid } = await start();
  grid.set("B1", "=A1*3");

  const copy = copyParts(grid, { top: 0, left: 1, bottom: 1, right: 1 }, a1);
  expect(copy.html).not.toContain("data-sheet-cut");
  const copied = pasteBlock(copy.html, { r: 5, c: 5 });
  expect(copied.block[0][0].content).toEqual({ f: "=E6*3" });
  expect(copied.block[1][0].content).toEqual({ f: "=E6*2" });

  const cut = copyParts(grid, { top: 0, left: 1, bottom: 1, right: 1 }, a1, { cut: true });
  expect(cut.html).toContain("data-sheet-cut");
  const res = pasteBlock(cut.html, { r: 5, c: 5 });
  expect(res.block[0][0].content).toEqual({ f: "=A1*3" });
  expect(res.block[1][0].content).toEqual({ f: "=A1*2" });
  expect(res.origin).toEqual({ r: 5, c: 5 });
});

// Bug: copyParts omitted data-style, or pasteBlock with formatOnly included cell content instead of only fmt and style.
test("copyParts writes data-style and pasteBlock carries style on regular paste and fmt+style only on formatOnly", async () => {
  const { grid } = await start();
  grid.format("A1", {
    fmt: "$#,##0.00",
    style: { "font-weight": "bold", "background-color": "#f0e4cc" },
    border: { preset: "outer", line: "1px solid #5F6368" },
  });

  const { html } = copyParts(grid, { top: 0, left: 0, bottom: 0, right: 1 }, a1);
  expect(html).toContain("data-style=");
  expect(html).toContain("font-weight:bold");

  // Regular paste carries style onto C3 and clears style on D3 when landing over a styled cell.
  grid.format("D3", { style: { "font-style": "italic" } });
  const regular = pasteBlock(html, { r: 2, c: 2 });
  grid.setRange("C3", regular.block, { grow: true });
  expect(grid.cell("C3").text).toBe("$3.00");
  expect(grid.cell("C3").style).toContain("font-weight:bold");
  expect(grid.cell("C3").style).toContain("background-color:#f0e4cc");
  expect(grid.cell("D3").style).toBeNull();

  // formatOnly returns only { fmt, style } with no content property, and leaves foreign tables marked foreign.
  const fmtOnly = pasteBlock(html, { r: 3, c: 0 }, { formatOnly: true });
  expect(fmtOnly.kind).toBe("ours");
  expect("content" in fmtOnly.block[0][0]).toBe(false);
  expect(fmtOnly.block[0][0].fmt).toBe("$#,##0.00");
  expect(fmtOnly.block[0][0].style["font-weight"]).toBe("bold");
  expect(pasteBlock("<table><tr><td>9</td></tr></table>", { r: 0, c: 0 }, { formatOnly: true }).kind).toBe("foreign");
});

// Bug: pasteBlock with transpose failed to swap rows and columns or shifted formulas by the untransposed offset instead of the distance to each transposed cell.
test("pasteBlock with transpose swaps rows and columns and shifts formulas from each source cell to its transposed target cell", async () => {
  const { grid } = await start();
  grid.setRange("A1", [
    [10, "=A1+5", 30],
    [40, 50, "=B2*3"],
  ]);

  // Copy 2x3 A1:C2 and paste transposed at D1 (r: 0, c: 3) -> 3x2 D1:E3.
  const { html } = copyParts(grid, { top: 0, left: 0, bottom: 1, right: 2 }, a1);
  const transposed = pasteBlock(html, { r: 0, c: 3 }, { transpose: true });

  expect(transposed.kind).toBe("ours");
  expect(transposed.block).toHaveLength(3);
  expect(transposed.block[0]).toHaveLength(2);
  // A1 (0,0)->D1 (0,3)=10; A2 (1,0)->E1 (0,4)=40
  expect(transposed.block[0][0].content).toBe(10);
  expect(transposed.block[0][1].content).toBe(40);
  // B1 (0,1) "=A1+5" -> D2 (1,3); A1 went to D1, so the reference follows it.
  expect(transposed.block[1][0].content).toEqual({ f: "=D1+5" });
  expect(transposed.block[1][1].content).toBe(50);
  // C1 (0,2)=30 -> D3 (2,3); C2 (1,2) "=B2*3" -> E3 (2,4); B2 went to E2.
  expect(transposed.block[2][0].content).toBe(30);
  expect(transposed.block[2][1].content).toEqual({ f: "=E2*3" });
});

// Bug: transposed formulas moved by the distance between the cells instead of swapping each
// reference's offset, so a column total pasted as a row read =SUM(#REF!:#REF!).
test("a column with its total pasted transposed keeps the total over the pasted row, and absolute references stay", async () => {
  const { grid } = await start();
  grid.setRange("A1", [[1], [2], ["=SUM(A1:A2)"], ["=$A$1+A2"]]);
  const { html } = copyParts(grid, { top: 0, left: 0, bottom: 3, right: 0 }, a1);
  const transposed = pasteBlock(html, { r: 0, c: 2 }, { transpose: true });
  expect(transposed.block).toHaveLength(1);
  expect(transposed.block[0][2].content).toEqual({ f: "=SUM(C1:D1)" });
  expect(transposed.block[0][3].content).toEqual({ f: "=$A$1+D1" });
});
