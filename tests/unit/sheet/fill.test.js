/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { a1 } from "../../../src/sheet/commit.js";
import {
  buildFillWrite,
  dragFillTarget,
  executeFill,
  fillLine,
  findAutoFillEndRow,
  sourceStyleMap,
} from "../../../src/sheet/fill.js";

const MERGE_HTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="t"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="10">10</td><td n v="20">20</td><td n v="30">30</td></tr>
<tr data-id="r2" data-pos="l"><td n v="11">11</td><td n v="21">21</td><td n v="31">31</td></tr>
<tr data-id="r3" data-pos="t"><td colspan="2" rowspan="2">Whole</td><td hidden></td><td></td></tr>
<tr data-id="r4" data-pos="x"><td hidden></td><td hidden></td><td></td></tr>
<tr data-id="r5" data-pos="y"><td></td><td colspan="2">Cut</td><td hidden></td></tr>
</tbody></table></section></div></main>`;

const GAP_HTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="t"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td>Name</td><td>Amount</td><td>Tax</td></tr>
<tr data-id="r2" data-pos="l"><td>Rent</td><td n v="100">100</td><td n f="=B2*0.1" v="10">10</td></tr>
<tr data-id="r3" data-pos="t"><td>Food</td><td n v="50">50</td><td></td></tr>
<tr data-id="r4" data-pos="x"><td></td><td></td><td></td></tr>
<tr data-id="r5" data-pos="y"><td>Expenses</td><td>Note</td><td>Keep me</td></tr>
<tr data-id="r6" data-pos="z"><td>Car</td><td n v="7">7</td><td>Keep me too</td></tr>
</tbody></table></section></div></main>`;

const STYLE_HTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="1" style="background:#DCEBE7">1</td><td n v="9">9</td></tr>
<tr data-id="r2" data-pos="l"><td n v="2" style="background-color:#FFE9A8">2</td><td n v="8">8</td></tr>
<tr data-id="r3" data-pos="t"><td></td><td></td></tr>
</tbody></table></section></div></main>`;

async function mountGrid(html = MERGE_HTML) {
  jest.resetModules();
  delete window.Sap;
  delete window.sapPlugins;
  window.clay = { ready: new Promise(() => {}) };
  document.body.innerHTML = html;
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const books = ownWorkbooks({});
  await books.ready;
  Sap.mount();
  const table = document.querySelector("table[grid]");
  const grid = Sap.grid(table);
  const view = {
    rows: [...table.querySelectorAll("tr")].map((tr) => tr.getAttribute("data-id") ?? ""),
    cols: [...table.querySelectorAll("col")].map((col) => col.getAttribute("data-id") ?? ""),
    rowHidden: () => false,
    colHidden: () => false,
    cell: (r, c) => grid.cell(a1(r, c)),
  };
  return { Sap, grid, view };
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  document.body.innerHTML = "";
  jest.restoreAllMocks();
});

describe("sheet fill series and merge rules", () => {
  // Bug: one number stepped instead of copying, non-constant runs extrapolated, or float noise broke 10-sig-digit constant steps and backwards fill.
  test("numbers copy when alone, continue a constant step (rounded to 10 sig digits) forward and backward, and repeat when non-constant", () => {
    expect(fillLine([{ content: 5 }], 3, 1).map((x) => x.content)).toEqual([5, 5, 5]);
    expect(fillLine([{ content: 5 }], 2, -1).map((x) => x.content)).toEqual([5, 5]);

    expect(fillLine([{ content: 1 }, { content: 2 }], 3, 1).map((x) => x.content)).toEqual([3, 4, 5]);
    expect(fillLine([{ content: 1 }, { content: 2 }], 2, -1).map((x) => x.content)).toEqual([-1, 0]);

    // 0.3 - 0.2 !== 0.2 - 0.1 in raw IEEE-754 without 10-significant-digit rounding.
    expect(fillLine([{ content: 0.1 }, { content: 0.2 }, { content: 0.3 }], 2, 1).map((x) => x.content)).toEqual([0.4, 0.5]);
    expect(fillLine([{ content: 0.1 }, { content: 0.2 }, { content: 0.3 }], 2, -1).map((x) => x.content)).toEqual([-0.1, 0]);

    expect(fillLine([{ content: 1 }, { content: 2 }, { content: 4 }], 4, 1).map((x) => x.content)).toEqual([1, 2, 4, 1]);
    expect(fillLine([{ content: 1 }, { content: 2 }, { content: 4 }], 2, -1).map((x) => x.content)).toEqual([2, 4]);
  });

  // Bug: a single date copied instead of stepping one day, or multi-date series failed forward/backward or stepped on uneven intervals.
  test("dates step 1 day when alone, continue constant steps forward and backward, and repeat when non-constant", () => {
    const fmtKind = (f) => (f === "m/d/yyyy" ? "date" : f === "m/d/yyyy h:mm" ? "datetime" : "auto");

    expect(
      fillLine([{ content: 46024, effectiveFmt: "m/d/yyyy" }], 3, 1, { fmtKind }).map((x) => x.content),
    ).toEqual([46025, 46026, 46027]);
    expect(
      fillLine([{ content: 46024, effectiveFmt: "m/d/yyyy h:mm" }], 2, -1, { fmtKind }).map((x) => x.content),
    ).toEqual([46022, 46023]);

    expect(
      fillLine(
        [
          { content: 46024, effectiveFmt: "m/d/yyyy" },
          { content: 46031, effectiveFmt: "m/d/yyyy" },
        ],
        2,
        1,
        { fmtKind },
      ).map((x) => x.content),
    ).toEqual([46038, 46045]);
    expect(
      fillLine(
        [
          { content: 46024, effectiveFmt: "m/d/yyyy" },
          { content: 46031, effectiveFmt: "m/d/yyyy" },
        ],
        1,
        -1,
        { fmtKind },
      ).map((x) => x.content),
    ).toEqual([46017]);

    expect(
      fillLine(
        [
          { content: 46024, effectiveFmt: "m/d/yyyy" },
          { content: 46025, effectiveFmt: "m/d/yyyy" },
          { content: 46030, effectiveFmt: "m/d/yyyy" },
        ],
        2,
        1,
        { fmtKind },
      ).map((x) => x.content),
    ).toEqual([46024, 46025]);
  });

  // Bug: text ending in a whole number failed to step alone, dropped leading-zero width on A007, padded Item 9/Item 10 backwards as Item 08, or stepped across mismatched prefixes.
  test("text ending in a whole number steps by 1 alone, preserves leading-zero width, continues matching prefixes forward and backward, and repeats on mismatch", () => {
    expect(fillLine([{ content: "Item 7" }], 2, 1).map((x) => x.content)).toEqual(["Item 8", "Item 9"]);
    expect(fillLine([{ content: "Item 7" }], 2, -1).map((x) => x.content)).toEqual(["Item 5", "Item 6"]);

    expect(fillLine([{ content: "A007" }], 3, 1).map((x) => x.content)).toEqual(["A008", "A009", "A010"]);
    expect(fillLine([{ content: "A099" }, { content: "A100" }], 1, -1).map((x) => x.content)).toEqual(["A098"]);
    expect(fillLine([{ content: "Item 9" }, { content: "Item 10" }], 1, -1).map((x) => x.content)).toEqual(["Item 8"]);
    expect(fillLine([{ content: "Q1" }, { content: "Q3" }], 2, 1).map((x) => x.content)).toEqual(["Q5", "Q7"]);

    expect(fillLine([{ content: "Q1" }, { content: "R2" }], 3, 1).map((x) => x.content)).toEqual(["Q1", "R2", "Q1"]);
  });

  // Bug: formulas did not shift relative references by distance from their source cell, dropped formats/styles, or series:false still generated a series.
  test("formulas shift relative references forward, backward and horizontally while copying formats and styles, and series:false copies without stepping", async () => {
    const { Sap } = await mountGrid();
    const tokenize = Sap.grid.tokenize;

    const down = fillLine(
      [{ content: { f: "=B2+$A$1" }, effectiveFmt: "$#,##0.00", style: "font-weight:bold;color:#1D5B79" }],
      2,
      1,
      { axis: "vertical", tokenize },
    );
    expect(down.map((x) => x.content)).toEqual([{ f: "=B3+$A$1" }, { f: "=B4+$A$1" }]);
    expect(down[0].fmt).toBe("$#,##0.00");
    expect(down[0].style["font-weight"]).toBe("bold");
    expect(down[0].style.color).toBe("#1D5B79");

    const up = fillLine([{ content: { f: "=B3*2" } }], 2, -1, { axis: "vertical", tokenize });
    expect(up.map((x) => x.content)).toEqual([{ f: "=B1*2" }, { f: "=B2*2" }]);

    const right = fillLine([{ content: { f: "=B2*2" } }], 2, 1, { axis: "horizontal", tokenize });
    expect(right.map((x) => x.content)).toEqual([{ f: "=C2*2" }, { f: "=D2*2" }]);

    expect(fillLine([{ content: "Q1" }], 2, 1, { series: false }).map((x) => x.content)).toEqual(["Q1", "Q1"]);
    expect(fillLine([{ content: 1 }, { content: 2 }], 2, 1, { series: false }).map((x) => x.content)).toEqual([1, 2]);
  });

  // Bug: fill wrote onto covered cells of a merge whole inside the target, or failed to refuse with sapjs's covered_cell message when the target cut a merge, or dragFillTarget failed to lock axis.
  test("fill skips covered cells of a whole merge in the target, refuses with sapjs's message when the target cuts a merge, and locks drag target to the dominant axis", async () => {
    const { grid, view } = await mountGrid();

    // Whole merge A3:B4 filled from A1:B2 (10,11 and 20,21) -> writes anchor A3 = 12 without touching covered cells.
    executeFill(grid, view, { top: 0, bottom: 1, left: 0, right: 1 }, { top: 2, bottom: 3, left: 0, right: 1 });
    expect(grid.get("A3")).toBe(12);
    expect(grid.cell("B3").covered).toBe(true);
    expect(grid.cell("A4").covered).toBe(true);

    // Target B5 (from B1:B2 -> B5 alone) cuts horizontal merge B5:C5 -> refused with the fill notice and no write.
    const setRange = jest.spyOn(grid, "setRange");
    expect(() =>
      executeFill(grid, view, { top: 0, bottom: 1, left: 1, right: 1 }, { top: 4, bottom: 4, left: 1, right: 1 }),
    ).toThrow("Fill can't cover only part of a merged cell. Unmerge it, or fill a range that holds all of it.");
    expect(buildFillWrite(grid, view, { top: 0, bottom: 1, left: 1, right: 1 }, { top: 4, bottom: 4, left: 1, right: 1 }).cut).toBe(
      true,
    );
    expect(setRange).not.toHaveBeenCalled();
    expect(grid.get("B5")).toBe("Cut");
    expect(grid.get("C5")).toBeNull();
    setRange.mockRestore();

    // Axis locking and auto-fill end row lookup.
    expect(dragFillTarget({ top: 1, bottom: 2, left: 1, right: 1 }, { r: 5, c: 2 }, { dx: 20, dy: 90 })).toEqual({
      top: 3,
      bottom: 5,
      left: 1,
      right: 1,
    });
    expect(dragFillTarget({ top: 1, bottom: 2, left: 1, right: 1 }, { r: 5, c: 3 }, { dx: 120, dy: 30 })).toEqual({
      top: 1,
      bottom: 2,
      left: 2,
      right: 3,
    });
    expect(findAutoFillEndRow(view, { top: 0, bottom: 0, left: 2, right: 2 })).toBe(4);
  });

  // Bug: double-click fill ran down the neighbouring column's last filled row, skipping the blank row that ends its run.
  test("double-click fill stops at the end of the neighbouring column's unbroken run", async () => {
    const { grid, view } = await mountGrid(GAP_HTML);
    const source = { top: 1, bottom: 1, left: 2, right: 2 };
    expect(findAutoFillEndRow(view, source)).toBe(2);

    executeFill(grid, view, source, { top: 2, bottom: findAutoFillEndRow(view, source), left: 2, right: 2 });
    expect(grid.get("C3")).toBe(5);
    expect(grid.input("C3")).toBe("=B3*0.1");
    expect(grid.get("C5")).toBe("Keep me");
    expect(grid.get("C6")).toBe("Keep me too");
  });

  // Bug: a raw 17-digit step leaked IEEE-754 noise into 5-digit decimal series.
  test("a series of five-digit decimals continues with exact tenths", () => {
    expect(fillLine([{ content: 10000.1 }, { content: 10000.2 }], 2, 1).map((x) => x.content)).toEqual([10000.3, 10000.4]);
  });

  // Bug: a line mixing a date serial with a plain number stepped by the date serial difference.
  test("a line mixing a date cell and a currency cell repeats the pair instead of stepping", async () => {
    const { Sap } = await mountGrid();
    const fmtKind = Sap.grid.fmtKind;
    expect(fmtKind("m/d/yyyy")).toBe("date");
    expect(
      fillLine([{ content: 46037, effectiveFmt: "m/d/yyyy" }, { content: 50, effectiveFmt: "$#,##0.00" }], 2, 1, {
        axis: "horizontal",
        fmtKind,
      }).map((x) => x.content),
    ).toEqual([46037, 50]);
  });

  // Bug: a background: declaration emitted background then background-color:null, stripping the source colour on a fill.
  test("a background: source style fills as background-color and keeps the source colour on a coloured cell", async () => {
    const mapped = sourceStyleMap("background:#DCEBE7");
    expect(mapped["background-color"]).toBe("#DCEBE7");
    expect(mapped).not.toHaveProperty("background");

    const { grid, view } = await mountGrid(STYLE_HTML);
    const styleOf = (ref) => String(grid.cell(ref).style ?? "").toLowerCase();
    expect(styleOf("A2")).toContain("#ffe9a8");
    executeFill(grid, view, { top: 0, bottom: 0, left: 0, right: 0 }, { top: 1, bottom: 1, left: 0, right: 0 });
    expect(styleOf("A2")).toContain("#dcebe7");
    expect(styleOf("A2")).not.toContain("#ffe9a8");
  });

  // Bug: dragging the fill handle sideways from a tall selection returned null, and a drag onto a merge owner cut the merge.
  test("dragging sideways from a tall selection targets its column and a drag onto a merge owner targets the whole merge", async () => {
    expect(dragFillTarget({ top: 1, bottom: 19, left: 1, right: 1 }, { r: 9, c: 2 }, { dx: 80, dy: -120 })).toEqual({
      top: 1,
      bottom: 19,
      left: 2,
      right: 2,
    });

    const { view } = await mountGrid();
    expect(
      dragFillTarget({ top: 0, bottom: 1, left: 0, right: 1 }, { r: 2, c: 0 }, { dx: 0, dy: 100, view }),
    ).toEqual({ top: 2, bottom: 3, left: 0, right: 1 });
  });
});
