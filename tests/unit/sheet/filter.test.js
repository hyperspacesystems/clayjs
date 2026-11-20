import { describe, expect, test } from "@jest/globals";
import {
  CONDITIONS,
  cellText,
  currentRegion,
  distinctValues,
  hiddenRowsFor,
  passes,
  rangeRows,
} from "../../../src/sheet/filter.js";

const cell = (text, value = text) => ({ text, value });
const blank = () => cell("", null);

function viewOf(rows, cols = rows[0].map((_, i) => `c${i + 1}`)) {
  return {
    rows: rows.map((_, i) => (i === 0 ? "h" : `r${i}`)),
    cols,
    cell(r, c) {
      if (!rows[r] || !rows[r][c]) return null;
      return rows[r][c];
    },
  };
}

const spec = (criteria = new Map(), cols = ["c1", "c2"]) => ({ header: "h", cols, criteria });

describe("filter criteria", () => {
  test("passes and hiddenRowsFor follow values and conditions", () => {
    const view = viewOf([
      [cell("Name"), cell("Fruit")],
      [cell("10", 10), cell("apple")],
      [cell("9", 9), cell("banana")],
      [blank(), blank()],
      [cell("x"), cell("cherry")],
    ]);

    expect(passes(cell("Apple"), { values: null, condition: { op: "contains", arg: "ap" } })).toBe(true);
    expect(passes(cell("Apple"), { values: null, condition: { op: "notContains", arg: "ap" } })).toBe(false);
    expect(passes(cell("Apple"), { values: null, condition: { op: "startsWith", arg: "ap" } })).toBe(true);
    expect(passes(cell("Apple"), { values: null, condition: { op: "endsWith", arg: "ple" } })).toBe(true);
    expect(passes(cell("Apple"), { values: null, condition: { op: "exactly", arg: "apple" } })).toBe(true);

    expect(passes(blank(), { values: null, condition: { op: "empty" } })).toBe(true);
    expect(passes(blank(), { values: null, condition: { op: "notEmpty" } })).toBe(false);
    expect(passes(cell("a"), { values: null, condition: { op: "notEmpty" } })).toBe(true);

    expect(passes(cell("10", 10), { values: null, condition: { op: "gt", arg: "9" } })).toBe(true);
    expect(passes(cell("9", 9), { values: null, condition: { op: "gt", arg: "9" } })).toBe(false);
    expect(passes(cell("9", 9), { values: null, condition: { op: "gte", arg: "9" } })).toBe(true);
    expect(passes(cell("9", 9), { values: null, condition: { op: "lt", arg: "9" } })).toBe(false);
    expect(passes(cell("9", 9), { values: null, condition: { op: "lte", arg: "9" } })).toBe(true);
    expect(passes(cell("9", 9), { values: null, condition: { op: "eq", arg: "9" } })).toBe(true);
    expect(passes(cell("9", 9), { values: null, condition: { op: "ne", arg: "9" } })).toBe(false);
    expect(passes(cell("x"), { values: null, condition: { op: "gt", arg: "3" } })).toBe(false);
    expect(passes(cell("x"), { values: null, condition: { op: "ne", arg: "3" } })).toBe(true);

    expect(passes(blank(), { values: new Set([""]), condition: null })).toBe(true);
    expect(passes(cell("a"), { values: new Set([""]), condition: null })).toBe(false);

    const hidden = hiddenRowsFor(view, spec(new Map([
      ["c2", { values: new Set(["apple", "banana"]), condition: null }],
      ["c1", { values: null, condition: { op: "gt", arg: "9" } }],
    ])));
    expect([...hidden].sort()).toEqual(["r2", "r3", "r4"]);
  });

  test("distinctValues counts each shown value once, numbers first in numeric order, blanks last", () => {
    const view = viewOf([
      [cell("Value")],
      [cell("10", 10)],
      [cell("9", 9)],
      [cell("b")],
      [blank()],
      [cell("a")],
      [cell("9", 9)],
    ], ["c1"]);
    expect(distinctValues(view, spec(new Map(), ["c1"]), "c1")).toEqual([
      { text: "9", count: 2 },
      { text: "10", count: 1 },
      { text: "a", count: 1 },
      { text: "b", count: 1 },
      { text: "", count: 1 },
    ]);
    expect(cellText(null)).toBe("");
  });

  test("currentRegion grows to the filled block", () => {
    const empty = () => blank();
    const view = viewOf([
      [empty(), empty(), empty(), empty()],
      [empty(), cell("a"), cell("b"), empty()],
      [empty(), cell("c"), cell("d"), empty()],
      [empty(), empty(), empty(), empty()],
      [empty(), empty(), empty(), empty()],
    ]);
    expect(currentRegion(view, { top: 1, left: 1, bottom: 1, right: 1 })).toEqual({ top: 1, left: 1, bottom: 2, right: 2 });
  });

  // Bug: a frozen row was filtered but stayed on screen.
  test("rangeRows never starts inside a frozen row", () => {
    const rows = [[cell("Head")], [cell("a")], [cell("b")]];
    const view = { ...viewOf(rows, ["c1"]), frozenRows: 2 };
    expect(rangeRows(view, spec(new Map(), ["c1"]))).toEqual([2]);
  });

  // Bug: a Total row below an explicit selection was filtered and sorted into the data.
  test("rangeRows stops at the bottom of an explicit selection", () => {
    const view = viewOf(
      [[cell("Head")], [cell("a")], [cell("b")], [cell("c")], [blank()], [cell("total")]],
      ["c1"],
    );
    expect(rangeRows(view, spec(new Map(), ["c1"]))).toEqual([1, 2, 3, 4, 5]);
    expect(rangeRows(view, { ...spec(new Map(), ["c1"]), bottom: "r3" })).toEqual([1, 2, 3]);
  });

  // Bug: blanks counted as 0 under a number condition, and text equality hid every row.
  test("number conditions treat blanks as blank and compare text without case", () => {
    expect(passes(blank(), { values: null, condition: { op: "lt", arg: "5" } })).toBe(false);
    expect(passes(blank(), { values: null, condition: { op: "lte", arg: "5" } })).toBe(false);
    expect(passes(blank(), { values: null, condition: { op: "eq", arg: "0" } })).toBe(false);
    expect(passes(blank(), { values: null, condition: { op: "ne", arg: "5" } })).toBe(true);
    expect(passes(cell("Paid"), { values: null, condition: { op: "eq", arg: "paid" } })).toBe(true);
    expect(passes(cell("Paid"), { values: null, condition: { op: "ne", arg: "paid" } })).toBe(false);
  });

  test("rangeRows runs from the row below the heading to the last filled row", () => {
    const view = viewOf([
      [cell("Head")],
      [cell("a")],
      [blank()],
      [cell("b")],
      [blank()],
    ], ["c1"]);
    expect(rangeRows(view, spec(new Map(), ["c1"]))).toEqual([1, 2, 3]);
    expect(CONDITIONS.map(([op]) => op)).toEqual([
      "none", "empty", "notEmpty", "contains", "notContains", "startsWith", "endsWith", "exactly",
      "eq", "ne", "gt", "gte", "lt", "lte",
    ]);
  });
});
