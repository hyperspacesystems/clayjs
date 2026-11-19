/**
 * @jest-environment node
 */
import { describe, expect, test } from "@jest/globals";
import {
  clipSelection,
  createSelection,
  edgeSelection,
  moveSelection,
  pageSelection,
  readSelection,
  rowEdgeSelection,
  selectAll,
  selectCell,
  selectCols,
  selectionArea,
  selectionBox,
  selectRows,
  sheetCornerSelection,
  writeSelection,
} from "../../../src/sheet/selection.js";

function makeView(rowCount, colCount, { filled = new Set(), merges = [], hiddenRows = [], hiddenCols = [] } = {}) {
  const rows = Array.from({ length: rowCount }, (_, i) => `r${i}`);
  const cols = Array.from({ length: colCount }, (_, i) => `c${i}`);
  const map = new Map();
  for (const key of filled) map.set(key, { content: "x", text: "x", span: null, covered: false });
  for (const { r, c, rs, cs } of merges) {
    for (let rr = r; rr < r + rs; rr++) {
      for (let cc = c; cc < c + cs; cc++) {
        if (rr === r && cc === c) {
          map.set(`${rr},${cc}`, { content: "merged", text: "merged", span: { rows: rs, cols: cs }, covered: false });
        } else {
          map.set(`${rr},${cc}`, { content: null, text: "", span: null, covered: true });
        }
      }
    }
  }
  const hidden = (list) => {
    const set = new Set(list);
    return (i) => set.has(i);
  };
  return {
    rows,
    cols,
    rowHidden: hidden(hiddenRows),
    colHidden: hidden(hiddenCols),
    cell: (r, c) => map.get(`${r},${c}`) ?? { content: null, text: "", span: null, covered: false },
  };
}

describe("sheet selection model", () => {
  // Bug: arrow movement wrapped around or went out of bounds into undefined row/col ids.
  test("arrows clip at the top, left, bottom and right edges, and Home/End/Ctrl+Home/Ctrl+End reach row and sheet corners", () => {
    const view = makeView(4, 3);
    let sel = createSelection(view, "s1");
    expect(sel).toEqual({ tab: "s1", anchor: { row: "r0", col: "c0" }, focus: { row: "r0", col: "c0" } });

    sel = moveSelection(view, sel, { dr: -1, dc: 0 });
    sel = moveSelection(view, sel, { dr: 0, dc: -1 });
    expect(sel.anchor).toEqual({ row: "r0", col: "c0" });

    sel = sheetCornerSelection(view, sel, { end: true });
    expect(sel.anchor).toEqual({ row: "r3", col: "c2" });

    sel = moveSelection(view, sel, { dr: 1, dc: 0 });
    sel = moveSelection(view, sel, { dr: 0, dc: 1 });
    expect(sel.anchor).toEqual({ row: "r3", col: "c2" });

    sel = rowEdgeSelection(view, sel, { end: false });
    expect(sel.anchor).toEqual({ row: "r3", col: "c0" });
    sel = rowEdgeSelection(view, sel, { end: true });
    expect(sel.anchor).toEqual({ row: "r3", col: "c2" });
    sel = sheetCornerSelection(view, sel, { end: false });
    expect(sel.anchor).toEqual({ row: "r0", col: "c0" });
  });

  // Bug: Ctrl+arrow stopped on the immediate neighbor, jumped to the sheet edge across filled cells, or went out of bounds.
  test("Ctrl+arrow follows the Sheets data-edge rule across a filled run, across a blank gap, and to the sheet edge", () => {
    const filled = new Set(["0,0", "0,1", "0,2", "0,5", "0,6"]);
    const view = makeView(2, 10, { filled });
    let sel = createSelection(view, "s1");

    // Case 1: from a filled cell with a filled neighbor -> last filled cell before a blank.
    sel = edgeSelection(view, sel, { dc: 1 });
    expect(sel.anchor).toEqual({ row: "r0", col: "c2" });

    // Case 2: from the end of a filled run before a blank -> next filled cell across the gap.
    sel = edgeSelection(view, sel, { dc: 1 });
    expect(sel.anchor).toEqual({ row: "r0", col: "c5" });

    sel = edgeSelection(view, sel, { dc: 1 });
    expect(sel.anchor).toEqual({ row: "r0", col: "c6" });

    // Case 3: no more filled cells ahead -> sheet edge.
    sel = edgeSelection(view, sel, { dc: 1 });
    expect(sel.anchor).toEqual({ row: "r0", col: "c9" });

    // Reverse from blank edge -> next filled cell going left, then start of that run.
    sel = edgeSelection(view, sel, { dc: -1 });
    expect(sel.anchor).toEqual({ row: "r0", col: "c6" });
    sel = edgeSelection(view, sel, { dc: -1 });
    expect(sel.anchor).toEqual({ row: "r0", col: "c5" });
  });

  // Bug: Shift+arrow moved the anchor instead of extending focus from the anchor.
  test("Shift extends the range from the anchor while keeping the anchor as the active cell", () => {
    const view = makeView(5, 5);
    let sel = selectCell(view, createSelection(view, "s1"), 1, 1);
    sel = moveSelection(view, sel, { dr: 2, dc: 0, extend: true });
    sel = moveSelection(view, sel, { dr: 0, dc: 2, extend: true });

    expect(sel.anchor).toEqual({ row: "r1", col: "c1" });
    expect(sel.focus).toEqual({ row: "r3", col: "c3" });
    expect(selectionArea(view, sel)).toBe("B2:D4");
  });

  // Bug: moving onto a covered cell left the active cell on a hidden covered td, or trapped arrows inside a merge.
  test("a move onto a covered cell lands on the merge's own cell, and moving out steps past the merge", () => {
    const view = makeView(5, 5, { merges: [{ r: 1, c: 1, rs: 2, cs: 2 }] });
    let sel = selectCell(view, createSelection(view, "s1"), 2, 0);

    // Moving right from A3 into covered B3 lands on merge owner B2 (r1, c1).
    sel = moveSelection(view, sel, { dr: 0, dc: 1 });
    expect(sel.anchor).toEqual({ row: "r1", col: "c1" });
    expect(sel.focus).toEqual({ row: "r1", col: "c1" });

    // Moving right again from B2 (2x2 merge) steps past C2 to D2 (r1, c3).
    sel = moveSelection(view, sel, { dr: 0, dc: 1 });
    expect(sel.anchor).toEqual({ row: "r1", col: "c3" });
  });

  // Bug: extending a selection into one cell of a merge selected only half of the merge.
  test("a selection touching part of a merge grows to hold the entire merge", () => {
    const view = makeView(5, 5, { merges: [{ r: 1, c: 1, rs: 2, cs: 2 }] });
    let sel = selectCell(view, createSelection(view, "s1"), 2, 0);
    sel = moveSelection(view, sel, { dr: 0, dc: 1, extend: true });

    expect(selectionBox(view, sel)).toMatchObject({ top: 1, left: 0, bottom: 2, right: 2 });
    expect(selectionArea(view, sel)).toBe("A2:C3");
  });

  // Bug: when selected row or column ids were deleted, selection kept missing ids or reset to A1 instead of clipping at the same index.
  test("ids that left the view clip to the nearest row and column at the same index", () => {
    const before = makeView(4, 4);
    const sel = selectCell(before, createSelection(before, "s1"), 3, 2);
    expect(sel.anchor).toEqual({ row: "r3", col: "c2" });

    // Delete last row r3 and middle col c2 -> rows [r0, r1, r2], cols [r/c0, c1, c3].
    const after = {
      rows: ["r0", "r1", "r2"],
      cols: ["c0", "c1", "c3"],
      cell: () => ({ content: null, text: "", span: null, covered: false }),
    };
    const clipped = clipSelection(after, sel, before);
    expect(clipped.anchor).toEqual({ row: "r2", col: "c3" });
    expect(clipped.focus).toEqual({ row: "r2", col: "c3" });
  });

  // Bug: Ctrl+A, Ctrl+Space and Shift+Space failed to span the full tab, columns or rows.
  test("select all, select columns and select rows span their full axes", () => {
    const view = makeView(6, 4);
    const start = selectCell(view, createSelection(view, "s1"), 2, 1);

    expect(selectionArea(view, selectAll(view, start))).toBe("A1:D6");
    expect(selectionArea(view, selectCols(view, start))).toBe("B1:B6");
    expect(selectionArea(view, selectRows(view, start))).toBe("A3:D3");
  });

  // Bug: Page Down moved by 1 row or ignored pageSize, or failed to clip at the bottom edge.
  test("Page Down and Page Up move by the given page size and clip at the sheet bounds", () => {
    const view = makeView(30, 3);
    let sel = createSelection(view, "s1");

    sel = pageSelection(view, sel, { dir: 1, pageSize: 12 });
    expect(sel.anchor).toEqual({ row: "r12", col: "c0" });

    sel = pageSelection(view, sel, { dir: 1, pageSize: 25 });
    expect(sel.anchor).toEqual({ row: "r29", col: "c0" });

    sel = pageSelection(view, sel, { dir: -1, pageSize: 10 });
    expect(sel.anchor).toEqual({ row: "r19", col: "c0" });
  });

  // Bug: a move stepped onto a hidden row or column, so the person typed into a cell they could not see.
  test("moves, Home/End, Page, Ctrl+arrow and clipped ids never land on a hidden row or column", () => {
    const view = makeView(6, 5, {
      filled: new Set(["0,0", "3,0"]),
      hiddenRows: [1],
      hiddenCols: [2, 4],
    });
    let sel = selectCell(view, createSelection(view, "s1"), 0, 0);

    // Row 2 is hidden: ArrowDown from row 1 lands on row 3.
    sel = moveSelection(view, sel, { dr: 1 });
    expect(sel.anchor).toEqual({ row: "r2", col: "c0" });
    sel = moveSelection(view, sel, { dr: 1 });
    expect(sel.anchor).toEqual({ row: "r3", col: "c0" });
    sel = moveSelection(view, sel, { dr: -1 });
    sel = moveSelection(view, sel, { dr: -1 });
    expect(sel.anchor).toEqual({ row: "r0", col: "c0" });

    // Columns C and E are hidden: End stops on D, and a step right from B lands on D too.
    sel = rowEdgeSelection(view, sel, { end: true });
    expect(sel.anchor).toEqual({ row: "r0", col: "c3" });
    sel = selectCell(view, sel, 0, 1);
    sel = moveSelection(view, sel, { dc: 1 });
    expect(sel.anchor).toEqual({ row: "r0", col: "c3" });

    // Page moves and Ctrl+End skip the hidden row and column.
    sel = selectCell(view, createSelection(view, "s1"), 0, 0);
    sel = pageSelection(view, sel, { dir: 1, pageSize: 1 });
    expect(sel.anchor).toEqual({ row: "r2", col: "c0" });
    sel = sheetCornerSelection(view, sel, { end: true });
    expect(sel.anchor).toEqual({ row: "r5", col: "c3" });

    // Ctrl+arrow steps over the hidden row between A1 and the filled A4.
    sel = selectCell(view, createSelection(view, "s1"), 0, 0);
    sel = edgeSelection(view, sel, { dr: 1 });
    expect(sel.anchor).toEqual({ row: "r3", col: "c0" });

    // Ids that left the view and now sit on a hidden row and column clip to visible ones.
    const clipped = clipSelection(view, { tab: "s1", anchor: { row: "r1", col: "c2" }, focus: { row: "r1", col: "c2" } }, view);
    expect(clipped.anchor).toEqual({ row: "r2", col: "c3" });
  });

  // Bug: selection storage wrote under an unscoped key or crashed on invalid JSON.
  test("sessionStorage persists selection per path and ignores malformed entries", () => {
    const map = new Map();
    const storage = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => map.set(k, v),
    };
    const view = makeView(3, 3);
    const sel = selectCell(view, createSelection(view, "s1"), 1, 2);

    writeSelection(storage, "/budget.html", sel);
    expect(map.has("clay:sheet:selection:/budget.html")).toBe(true);
    expect(readSelection(storage, "/budget.html")).toEqual(sel);

    map.set("clay:sheet:selection:/bad.html", "{not-json");
    expect(readSelection(storage, "/bad.html")).toBeNull();
  });
});
