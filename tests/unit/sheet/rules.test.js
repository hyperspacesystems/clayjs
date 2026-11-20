/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, expect, jest, test } from "@jest/globals";
import { allowedInList, boundRange, inputRuleAt, isEmpty, listItems, matchKey, parseRuleStyle, readBox, readTexts } from "../../../src/sheet/geometry.js";
import { canAdopt, scopeOf } from "../../../src/sheet/row-window.js";
import { createRules } from "../../../src/sheet/rules.js";

const { evaluate, holds, paintRules, parseStyle, ruleCss, scaleColor, scaleStats } = createRules({
  boundRange,
  isEmpty,
  listItems,
  matchKey,
  parseStyle: parseRuleStyle,
  readBox,
  readTexts,
  canAdopt,
  scopeOf,
});

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

const BOOK = () => `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Picks</h2><table grid><colgroup><col data-id="p1" data-pos="V"><col data-id="p2" data-pos="l"></colgroup>
<tbody>
<tr data-id="pr1" data-pos="V"><td n v="1">1</td><td>Blue</td></tr>
<tr data-id="pr2" data-pos="l"><td n v="2">2</td><td>purple</td></tr>
<tr data-id="pr3" data-pos="t"><td n v="3">3</td><td n></td></tr>
<tr data-id="pr4" data-pos="v"><td n v="4">4</td><td>red</td></tr>
</tbody></table></section>
<section item data-id="s2" data-pos="l"><h2 bind="name">Lists</h2><table grid><colgroup><col data-id="q1" data-pos="V"></colgroup>
<tbody>
<tr data-id="qr1" data-pos="V"><td>Red</td></tr>
<tr data-id="qr2" data-pos="l"><td>Green</td></tr>
<tr data-id="qr3" data-pos="t"><td>red</td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit">{"rev":1}</script>
</div></main>`;

async function start() {
  page(BOOK());
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const books = ownWorkbooks({ onRebuild: () => {} });
  await books.ready;
  Sap.mount();
  await turn();
  return { Sap, root: document.querySelector("[sheet-workbook]") };
}

const tableOf = (id) => document.querySelector(`section[data-id="${id}"] table[grid]`);

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  jest.restoreAllMocks();
});

// Bug: an open-ended range's missing end passed through as NaN, which grid.get refuses.
test("boundRange clips an open-ended range to the sheet and returns null outside it", () => {
  const size = { rows: 10, cols: 5 };
  expect(boundRange("C2:C", size)).toEqual({ r0: 1, c0: 2, r1: 9, c1: 2 });
  expect(boundRange("A:A", size)).toEqual({ r0: 0, c0: 0, r1: 9, c1: 0 });
  expect(boundRange("2:3", size)).toEqual({ r0: 1, c0: 0, r1: 2, c1: 4 });
  expect(boundRange("B3", size)).toEqual({ r0: 2, c0: 1, r1: 2, c1: 1 });
  expect(boundRange("C20:C30", size)).toBeNull();
  expect(boundRange("F:F", size)).toBeNull();
  expect(boundRange("nonsense", size)).toBeNull();
  expect(boundRange("C0:C5", size)).toBeNull();
  expect(boundRange("C0", size)).toBeNull();
});

// Bug: a later conditional format overwrote an earlier one's property instead of losing it.
test("evaluate lets an earlier rule win a property both set and the later rule still set the others", () => {
  const rules = [
    { id: "a", pos: "V", kind: "when", range: "A1:A2", test: "filled", style: "background-color:#ffeeee;color:#aa0000" },
    { id: "b", pos: "l", kind: "when", range: "A1:A2", test: "filled", style: "color:#0000aa;font-weight:bold" },
  ];
  const cells = evaluate(rules, { rows: 2, cols: 1 }, () => [["x"], ["y"]], () => []);
  const style = cells.get("0,0").style;
  expect(style.get("background-color")).toBe("#ffeeee");
  expect(style.get("color")).toBe("#aa0000");
  expect(style.get("font-weight")).toBe("bold");
});

// Bug: numbers were compared as text, so "10" lost to "9", and a number was compared with text.
test("holds compares numbers by size, text case-blind, and never a number with text", () => {
  const none = new Map();
  expect(holds({ test: "gt", a: "9" }, 10, none)).toBe(true);
  expect(holds({ test: "gt", a: "9" }, 9, none)).toBe(false);
  expect(holds({ test: "gt", a: "9" }, "1abc", none)).toBe(false);
  expect(holds({ test: "gt", a: "abc" }, 5, none)).toBe(false);
  // A text cell compares as text, so a ZIP code stays a ZIP code and never becomes 2134.
  expect(holds({ test: "eq", a: "02134" }, "02134", none)).toBe(true);
  expect(holds({ test: "eq", a: "02134" }, "0213", none)).toBe(false);
  expect(holds({ test: "gt", a: "9" }, "10", none)).toBe(false);
  expect(holds({ test: "contains", a: "AN" }, "Banana", none)).toBe(true);
  expect(holds({ test: "between", a: "2", b: "10" }, 2, none)).toBe(true);
  expect(holds({ test: "between", a: "2", b: "10" }, 10, none)).toBe(true);
  expect(holds({ test: "between", a: "2", b: "10" }, 11, none)).toBe(false);
  expect(holds({ test: "ne", a: "x" }, null, none)).toBe(true);
  expect(holds({ test: "ne", a: "" }, null, none)).toBe(false);
  // A number cell still compares by size with a value typed as text.
  expect(holds({ test: "eq", a: "02134" }, 2134, none)).toBe(true);
  const counts = new Map([
    ["ab", 2],
    ["cd", 1],
  ]);
  expect(holds({ test: "duplicate" }, "AB", counts)).toBe(true);
  expect(holds({ test: "duplicate" }, "cd", counts)).toBe(false);
  expect(holds({ test: "unique" }, "Cd", counts)).toBe(true);
  expect(holds({ test: "unique" }, "ab", counts)).toBe(false);
});

// Bug: the scale put mid halfway between the smallest and largest instead of at the median.
test("scaleColor puts low at the smallest, mid at the median and high at the largest", () => {
  const stats = scaleStats([1, 5, 9]);
  expect(scaleColor({ low: "#000000", high: "#ffffff" }, 1, stats)).toBe("#000000");
  expect(scaleColor({ low: "#000000", high: "#ffffff" }, 9, stats)).toBe("#ffffff");
  const withMid = { low: "#000000", mid: "#00ff00", high: "#ffffff" };
  const wide = scaleStats([1, 3, 20]);
  expect(scaleColor(withMid, 1, wide)).toBe("#000000");
  expect(scaleColor(withMid, 3, wide)).toBe("#00ff00");
  expect(scaleColor(withMid, 20, wide)).toBe("#ffffff");
  expect(scaleColor(withMid, 11, wide)).not.toBe("#00ff00");
});

// Bug: a heading row inside a whole-column check range was drawn as an unticked box and hidden.
test("a heading inside a check range gets no box and shows as itself", () => {
  const grid = ruleGrid(
    [["Heading", 1], [null, 2]],
    { rules: [] },
  );
  const rule = { id: "k1", pos: "V", kind: "check", range: "A1:A2" };
  const cells = evaluate([rule], grid.size, (box) => readBox(grid, box), () => []);
  expect(cells.get("0,0").check).toBeUndefined();
  expect(cells.get("1,0").check).toBe(false);
});

// Bug: a dropdown holding a number or a date in another form marked a picked "50%" as outside its list.
test("a dropdown cell matches the text it shows, so a stored 0.5 is its item 50%", () => {
  const grid = ruleGrid([[0.5]], { rules: [] }, [["50%"]]);
  const rule = { id: "k1", pos: "V", kind: "list", range: "A1", items: ["25%", "50%"] };
  const cells = evaluate([rule], grid.size, (box) => readBox(grid, box), () => ["25%", "50%"], (box) => readTexts(grid, box));
  expect(cells.get("0,0").list).toBe("ok");
});

// Bug: a row id holding a line break ended the CSS string and let the id inject rules.
test("a row id holding a line break cannot end the CSS string", () => {
  const cells = new Map([["0,0", { style: new Map([["color", "#111111"]]) }]]);
  const css = ruleCss(cells, "table[grid]", ['r1\n}html{display:none}']);
  expect(css).not.toContain("\n");
  expect(css.split('"')).toHaveLength(3);
});

// Bug: a dropdown marked a blank or a differently-cased item as outside its list.
test("a list rule marks a value outside its items bad and a blank or another case ok", async () => {
  const { Sap } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  const rule = { id: "k1", pos: "V", kind: "list", range: "B1:B4", items: ["Blue", "Red"] };
  const cells = evaluate([rule], grid.size, (box) => readBox(grid, box), (r) => listItems(table, r));

  expect(cells.get("0,1").list).toBe("ok");
  expect(cells.get("1,1").list).toBe("bad");
  expect(cells.get("2,1").list).toBe("ok");
  expect(cells.get("3,1").list).toBe("ok");
});

// Bug: a dropdown's source range named another tab and read the wrong table, or kept duplicates.
test("listItems reads a source range on another tab by its name and allowedInList refuses an outside value", async () => {
  const { Sap } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  const rule = { id: "k2", pos: "l", kind: "list", range: "A1:A4", source: "Lists!A2:A" };

  expect(listItems(table, rule)).toEqual(["Green", "red"]);
  expect(allowedInList(table, rule, "GREEN")).toBe(true);
  expect(allowedInList(table, rule, "Blue")).toBe(false);
  expect(allowedInList(table, rule, "")).toBe(true);
  expect(allowedInList(table, rule, "=A1")).toBe(true);
  expect(allowedInList(table, { ...rule, open: true }, "Blue")).toBe(true);

  grid.setRules({ set: [rule] });
  expect(inputRuleAt(grid, 1, 0)?.id).toBe("k2");
  expect(inputRuleAt(grid, 1, 1)).toBeNull();
});

// Bug: a source naming its tab in another case found no items, so the dropdown refused every value.
test("listItems finds lists!A2:A on a tab named Lists", async () => {
  const { Sap } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  const rule = { id: "k3", pos: "t", kind: "list", range: "A1:A4", source: "lists!A2:A" };
  expect(listItems(table, rule)).toEqual(["Green", "red"]);
});

// Bug: a file's rule value holding "}" or "url(" reached the stylesheet and injected CSS.
test("parseStyle drops a value that could break out of its declaration", () => {
  expect(parseStyle("color:red;background-color:url(https://example.com/a.png);font-weight:bold}")).toEqual([["color", "red"]]);
  expect(parseStyle("background-color:#ffeeee; color : #111111 ; border:1px solid red")).toEqual([
    ["background-color", "#ffeeee"],
    ["color", "#111111"],
  ]);
  expect(parseStyle("")).toEqual([]);
  expect(parseStyle("background-color:url(x.png);color:red(")).toEqual([]);
});

// Bug: cells were named by index rather than by their row's id, or equal declarations were not grouped.
test("ruleCss names a cell by its row id and its column's place, and groups equal declarations", () => {
  const cells = new Map([
    ["0,1", { style: new Map([["color", "#111111"]]) }],
    ["1,1", { style: new Map([["color", "#111111"]]) }],
  ]);
  const css = ruleCss(cells, "section>table[grid]", ["r1", "r2"]);
  expect(css).toContain('section>table[grid]>*>tr[data-id="r1"]>td:nth-child(2)');
  expect(css).toContain('section>table[grid]>*>tr[data-id="r2"]>td:nth-child(2)');
  expect(css).toContain("{color:#111111 !important;print-color-adjust:exact;-webkit-print-color-adjust:exact}");
  // One rule for both cells, not one each.
  expect(css.match(/\{/g)).toHaveLength(1);
});

function fakeDocument() {
  return {
    adoptedStyleSheets: [],
    defaultView: {
      CSSStyleSheet: class {
        constructor() {
          this.text = "";
        }
        replaceSync(text) {
          this.text = text;
        }
      },
    },
  };
}

function ruleTable(parent = document.body) {
  const table = document.createElement("table");
  table.innerHTML = '<colgroup><col data-id="c1"><col data-id="c2"></colgroup><tbody><tr data-id="r1"><td>1</td><td>x</td></tr><tr data-id="r2"><td>2</td><td>y</td></tr></tbody>';
  parent.appendChild(table);
  return table;
}

function ruleGrid(values, state, texts = null) {
  const textAt = (r, c) => texts?.[r]?.[c] ?? String(values[r]?.[c] ?? "");
  return {
    size: { rows: values.length, cols: Math.max(...values.map((row) => row.length)) },
    rules: () => state.rules,
    cell(a1) {
      const letters = a1.match(/^[A-Z]+/)[0];
      return { text: textAt(Number(a1.slice(letters.length)) - 1, lettersIndex(letters)) };
    },
    get(ref) {
      const at = (a1) => {
        const letters = a1.match(/^[A-Z]+/)[0];
        const r = Number(a1.slice(letters.length)) - 1;
        return values[r]?.[lettersIndex(letters)] ?? null;
      };
      const [from, to = from] = ref.split(":");
      if (from === to) return at(from);
      const start = /^([A-Z]+)(\d+)$/.exec(from);
      const end = /^([A-Z]+)(\d+)$/.exec(to);
      const rows = [];
      for (let r = Number(start[2]); r <= Number(end[2]); r++) {
        const row = [];
        for (let c = lettersIndex(start[1]); c <= lettersIndex(end[1]); c++) row.push(at(`${lettersOf(c)}${r}`));
        rows.push(row);
      }
      return rows;
    },
  };
}

const lettersIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const lettersOf = (index) => {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

// Bug: a table with no rules got an empty stylesheet, or a repaint made a second sheet instead of
// replacing the first, or removing the last rule left the old colours drawn.
test("paintRules adopts one sheet per table that has rules, repaints it, and empties it when the rules go", () => {
  const table = ruleTable();
  const state = { rules: [] };
  const grid = ruleGrid(
    [
      [1, "TRUE"],
      [2, "FALSE"],
    ],
    state,
  );
  const doc = fakeDocument();

  paintRules(table, grid, doc);
  expect(doc.adoptedStyleSheets).toHaveLength(0);

  state.rules = [{ id: "k1", pos: "V", kind: "check", range: "B1:B2" }];
  paintRules(table, grid, doc);
  expect(doc.adoptedStyleSheets).toHaveLength(1);
  const sheet = doc.adoptedStyleSheets[0];
  expect(sheet.text).toContain('tr[data-id="r1"]>td:nth-child(2)');
  expect(sheet.text).toContain('tr[data-id="r2"]>td:nth-child(2)');

  state.rules = [{ id: "k2", pos: "V", kind: "when", range: "A1:A2", test: "filled", style: "color:#111111" }];
  paintRules(table, grid, doc);
  expect(doc.adoptedStyleSheets).toHaveLength(1);
  expect(doc.adoptedStyleSheets[0]).toBe(sheet);
  expect(sheet.text).toContain("color:#111111 !important");
  expect(sheet.text).not.toContain("nth-child(2)");

  state.rules = [];
  paintRules(table, grid, doc);
  expect(doc.adoptedStyleSheets).toHaveLength(1);
  expect(sheet.text).toBe("");
});

// Bug: a peer's merged save replaced the table, and the new table got a second sheet while the
// old one stayed adopted and kept painting.
test("paintRules keys its sheet by the tab's scope, so a replaced table repaints the same sheet", () => {
  const section = document.createElement("section");
  section.setAttribute("item", "");
  section.setAttribute("data-id", "s1");
  document.body.appendChild(section);
  const first = ruleTable(section);
  const state = { rules: [{ id: "k1", pos: "V", kind: "check", range: "B1:B2" }] };
  const grid = ruleGrid(
    [
      [1, "TRUE"],
      [2, "FALSE"],
    ],
    state,
  );
  const doc = fakeDocument();

  paintRules(first, grid, doc);
  expect(doc.adoptedStyleSheets).toHaveLength(1);
  const sheet = doc.adoptedStyleSheets[0];
  expect(sheet.text).toContain('section[data-id="s1"]>table[grid]>*>tr[data-id="r2"]>td:nth-child(2)');

  const second = ruleTable(section);
  first.remove();
  paintRules(second, grid, doc);
  expect(doc.adoptedStyleSheets).toHaveLength(1);
  expect(doc.adoptedStyleSheets[0]).toBe(sheet);
  expect(sheet.text).toContain('section[data-id="s1"]>table[grid]>*>tr[data-id="r2"]>td:nth-child(2)');
});
