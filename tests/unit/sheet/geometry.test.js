import { describe, expect, test } from "@jest/globals";
import { COL_DEFAULT, createGeometry, ROW_ESTIMATE } from "../../../src/sheet/geometry.js";

// A <table grid> with the given <col> widths ("" for none) and groups of row counts.
function tableOf(widths, groups, { hidden = [] } = {}) {
  const cols = widths.map((w) => (w === "" ? "<col>" : `<col style="width:${w}px">`)).join("");
  let n = 0;
  const bodies = groups.map((count) => {
    let rows = "";
    for (let i = 0; i < count; i++, n++) rows += `<tr data-id="r${n}"${hidden.includes(n) ? " hidden" : ""}></tr>`;
    return `<tbody>${rows}</tbody>`;
  }).join("");
  document.body.innerHTML = `<table grid><colgroup>${cols}</colgroup><thead><tr data-id="h"></tr></thead>${bodies}</table>`;
  return document.querySelector("table");
}

describe("sheet geometry", () => {
  test("columns sit at the sum of the widths before them, 100 px when a col has none", () => {
    const g = createGeometry(tableOf([180, 110, ""], [1]));
    expect([0, 1, 2].map(g.colLeft)).toEqual([0, 180, 290]);
    expect(g.width).toBe(390);
    expect([0, 179, 180, 289, 290, 5000].map(g.colAt)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  test("rows sit at the sum of the estimates before them, groups as the table cut them", () => {
    const g = createGeometry(tableOf([], [50, 50, 20]));
    expect(g.rowCount).toBe(120);
    expect(g.groupHeights()).toEqual([1300, 1300, 520]);
    expect(g.rowTop(50)).toBe(1300);
    expect([0, 1299, 1300, 3119, 99999].map(g.rowAt)).toEqual([0, 49, 50, 119, 119]);
    expect(g.groupTop(2)).toBe(2600);
    expect(g.groupOfRow(119)).toBe(2);
    expect(g.groupRows(1)).toEqual([50, 100]);
  });

  test("a measured row moves every row after it and is kept by id", () => {
    const table = tableOf([], [50, 50]);
    const measured = new Map();
    const g = createGeometry(table, { measured });
    expect(g.setRowHeight(10, 40)).toBe(14);
    expect(g.rowTop(11)).toBe(11 * ROW_ESTIMATE + 14);
    expect(g.groupHeights()).toEqual([1314, 1300]);
    expect(g.setRowHeight(10, 40)).toBe(0);
    const again = createGeometry(table, { measured });
    expect(again.rowHeight(10)).toBe(40);
    expect(again.indexOf("r10")).toBe(10);
  });

  test("rows with no id yet are not kept, so one tall row does not become every row's height", () => {
    const table = tableOf([], [50, 50]);
    for (const tr of table.tBodies[1].rows) tr.removeAttribute("data-id");
    const measured = new Map();
    const g = createGeometry(table, { measured });
    g.setRowHeight(99, 104);
    expect(createGeometry(table, { measured }).groupHeights()).toEqual([1300, 1300]);
  });

  test("a hidden row takes no height", () => {
    const g = createGeometry(tableOf([], [3], { hidden: [1] }));
    expect([0, 1, 2].map(g.rowTop)).toEqual([0, 26, 26]);
    expect(g.rowAt(26)).toBe(2);
  });

  test("a chart's box past the last row or column keeps going at the estimate and default", () => {
    const g = createGeometry(tableOf([120, 80], [2]));
    expect(g.rowTop(5)).toBe(g.rowTop(2) + 3 * ROW_ESTIMATE);
    expect(g.rowHeight(5)).toBe(ROW_ESTIMATE);
    expect(g.colLeft(4)).toBe(g.width + 2 * COL_DEFAULT);
    expect(g.colWidth(4)).toBe(COL_DEFAULT);
  });

  test("the index matches a plain sum over 1,000 random changes", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const g = createGeometry(tableOf([], [50, 50, 50, 50, 50, 37]));
    const plain = Array.from({ length: g.rowCount }, () => ROW_ESTIMATE);
    for (let step = 0; step < 1000; step++) {
      const i = Math.floor(random() * plain.length);
      const h = Math.floor(random() * 60);
      expect(g.setRowHeight(i, h)).toBe(h - plain[i]);
      plain[i] = h;
      const at = Math.floor(random() * plain.length);
      const top = plain.slice(0, at).reduce((a, b) => a + b, 0);
      expect(g.rowTop(at)).toBe(top);
      const y = random() * plain.reduce((a, b) => a + b, 0);
      let row = 0;
      let sum = 0;
      while (row < plain.length - 1 && sum + plain[row] <= y) sum += plain[row++];
      expect(g.rowAt(y)).toBe(row);
    }
  });
});
