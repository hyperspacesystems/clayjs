/**
 * @jest-environment node
 */
import { expect, test } from "@jest/globals";
import {
  buildRangeSortAction,
  buildSheetSortAction,
  compareSortValues,
  sortRowOrder,
} from "../../../src/sheet/sort.js";

// Bug: ascending order ranked types as JS strings or put booleans and errors ahead of numbers and text.
test("ascending order places numbers by value, then text, then booleans FALSE before TRUE, then errors, then empties", () => {
  const entries = [
    { id: "empty-null", value: null },
    { id: "err-val", value: "#VALUE!" },
    { id: "bool-true", value: true },
    { id: "text-z", value: "zeta" },
    { id: "num-date", value: 46000 },
    { id: "bool-false", value: false },
    { id: "err-div", value: "#DIV/0!" },
    { id: "num-neg", value: -12.5 },
    { id: "text-a", value: "apple" },
    { id: "num-zero", value: 0 },
    { id: "num-pos", value: 2.5 },
    { id: "err-obj", value: { error: "#REF!" } },
  ];

  expect(sortRowOrder(entries, "asc")).toEqual([
    "num-neg",
    "num-zero",
    "num-pos",
    "num-date",
    "text-a",
    "text-z",
    "bool-false",
    "bool-true",
    "err-div",
    "err-obj",
    "err-val",
    "empty-null",
  ]);
});

// Bug: text comparison used code-unit order instead of base-sensitivity numeric collation, putting "item10" before "item2" or separating uppercase from lowercase.
test("text comparison orders embedded numbers numerically and ignores case differences", () => {
  const entries = [
    { id: "r1", value: "item10" },
    { id: "r2", value: "Banana" },
    { id: "r3", value: "item2" },
    { id: "r4", value: "apple" },
    { id: "r5", value: "Item100" },
  ];

  expect(sortRowOrder(entries, "asc")).toEqual(["r4", "r2", "r3", "r1", "r5"]);
  expect(sortRowOrder(entries, "desc")).toEqual(["r5", "r1", "r3", "r2", "r4"]);
  expect(compareSortValues("Apple", "apple", "asc")).toBe(0);
});

// Bug: descending order reversed empty cells to the top instead of reversing non-empty values while keeping empties last.
test("descending order reverses errors, booleans, text and numbers while keeping empty cells last", () => {
  const entries = [
    { id: "n10", value: 10 },
    { id: "e1", value: null },
    { id: "txt", value: "apple" },
    { id: "bf", value: false },
    { id: "err", value: "#DIV/0!" },
    { id: "n30", value: 30 },
    { id: "e2", value: "" },
    { id: "bt", value: true },
    { id: "e3", value: undefined },
  ];

  expect(sortRowOrder(entries, "desc")).toEqual([
    "err",
    "bt",
    "bf",
    "txt",
    "n30",
    "n10",
    "e1",
    "e2",
    "e3",
  ]);
});

// Bug: ties flipped order in descending sort because equal values did not compare as 0 or were reversed.
test("ties in numbers, case-equal text, booleans, errors and empties keep their original row order in both directions", () => {
  const entries = [
    { id: "blank-1", value: null },
    { id: "num-1", value: 10 },
    { id: "txt-1", value: "Apple" },
    { id: "bool-1", value: true },
    { id: "err-1", value: "#N/A" },
    { id: "blank-2", value: "" },
    { id: "num-2", value: 10 },
    { id: "txt-2", value: "apple" },
    { id: "bool-2", value: true },
    { id: "err-2", value: "#N/A" },
  ];

  expect(sortRowOrder(entries, "asc")).toEqual([
    "num-1",
    "num-2",
    "txt-1",
    "txt-2",
    "bool-1",
    "bool-2",
    "err-1",
    "err-2",
    "blank-1",
    "blank-2",
  ]);

  expect(sortRowOrder(entries, "desc")).toEqual([
    "err-1",
    "err-2",
    "bool-1",
    "bool-2",
    "txt-1",
    "txt-2",
    "num-1",
    "num-2",
    "blank-1",
    "blank-2",
  ]);
});

// Bug: buildSheetSortAction and buildRangeSortAction included frozen rows in sheet sort or sent column ids instead of null for a full-width range sort.
test("buildSheetSortAction skips frozen rows with cols null and buildRangeSortAction uses active column with cols null only across all columns", () => {
  const values = new Map([
    ["A1", "Header A"],
    ["B1", "Header B"],
    ["A2", "b"],
    ["B2", 30],
    ["A3", "a"],
    ["B3", 10],
    ["A4", "c"],
    ["B4", 20],
  ]);
  const grid = { cell: (ref) => ({ value: values.get(ref) ?? null }) };
  const view = { rows: ["r1", "r2", "r3", "r4"], cols: ["c1", "c2", "c3"] };

  expect(
    buildSheetSortAction(grid, view, { sheet: "s1", col: 1, frozenRows: 1, direction: "asc" }),
  ).toEqual({
    v: 1,
    t: "sort",
    sheet: "s1",
    rows: ["r3", "r4", "r2"],
    cols: null,
  });

  expect(
    buildSheetSortAction(grid, view, { sheet: "s1", col: 1, frozenRows: 3, direction: "asc" }),
  ).toBeNull();

  expect(
    buildRangeSortAction(grid, view, {
      sheet: "s1",
      box: { top: 1, bottom: 3, left: 0, right: 1, active: { r: 1, c: 1 } },
      direction: "desc",
    }),
  ).toEqual({
    v: 1,
    t: "sort",
    sheet: "s1",
    rows: ["r2", "r4", "r3"],
    cols: ["c1", "c2"],
  });

  expect(
    buildRangeSortAction(grid, view, {
      sheet: "s1",
      box: { top: 1, bottom: 2, left: 0, right: 2, active: { r: 1, c: 0 } },
      direction: "asc",
    }),
  ).toEqual({
    v: 1,
    t: "sort",
    sheet: "s1",
    rows: ["r3", "r2"],
    cols: null,
  });

  expect(
    buildRangeSortAction(grid, view, {
      sheet: "s1",
      box: { top: 1, bottom: 1, left: 0, right: 1, active: { r: 1, c: 0 } },
      direction: "asc",
    }),
  ).toBeNull();
});

// Bug: sorting rows already in order recorded an undo step that changed nothing, so the next Ctrl+Z did nothing.
test("a sort that moves no row builds no action", () => {
  const view = { rows: ["r1", "r2", "r3"], cols: ["c1"] };
  const values = { A1: 1, A2: 2, A3: 3 };
  const grid = { cell: (ref) => ({ value: values[ref] ?? null }) };
  expect(buildSheetSortAction(grid, view, { sheet: "s1", col: 0, direction: "asc" })).toBeNull();
  const box = { top: 0, bottom: 2, left: 0, right: 0, active: { r: 0, c: 0 } };
  expect(buildRangeSortAction(grid, view, { sheet: "s1", box, direction: "asc" })).toBeNull();
  expect(buildSheetSortAction(grid, view, { sheet: "s1", col: 0, direction: "desc" })?.rows).toEqual(["r3", "r2", "r1"]);
});
