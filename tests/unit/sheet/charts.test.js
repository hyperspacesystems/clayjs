/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, expect, jest, test } from "@jest/globals";
import {
  boundRange,
  COL_DEFAULT,
  readBox,
  readTexts,
  ROW_ESTIMATE,
  rowOutOfSight,
  setFilteredRows,
  tableMetrics,
  tableParts,
  tableNamed,
} from "../../../src/sheet/geometry.js";
import { canAdopt, scopeOf } from "../../../src/sheet/row-window.js";
import { chartModel, createCharts } from "../../../src/sheet/charts.js";
import { chartSvg } from "../../../src/lib/chart-svg.js";

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
<tr data-id="pr1" data-pos="V"><td>Month</td><td n v="10">10</td></tr>
<tr data-id="pr2" data-pos="l"><td>Jan</td><td n v="12">12</td></tr>
<tr data-id="pr3" data-pos="t"><td>Feb</td><td n v="4242">4242</td></tr>
<tr data-id="pr4" data-pos="v"><td>Mar</td><td n v="16">16</td></tr>
</tbody></table></section>
<section item data-id="s2" data-pos="l"><h2 bind="name">B</h2><table grid><colgroup><col data-id="q1" data-pos="V"></colgroup>
<tbody>
<tr data-id="qr1" data-pos="V"><td n v="1">1</td></tr>
<tr data-id="qr2" data-pos="l"><td n v="2">2</td></tr>
<tr data-id="qr3" data-pos="t"><td n v="3">3</td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit>{"rev":1}</script>
</div></main>`;

const FROZEN_BOOK = () => `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sales</h2><table grid><colgroup><col data-id="p1" data-pos="V" style="width:140px"><col data-id="p2" data-pos="l" style="width:90px"></colgroup>
<thead><tr data-id="ph1" data-pos="V" style="height:40px"><td>Month</td><td>Sales</td></tr></thead>
<tbody>
<tr data-id="pr1" data-pos="l" style="height:30px"><td>Jan</td><td n v="10">10</td></tr>
<tr data-id="pr2" data-pos="t"><td>Feb</td><td n v="12">12</td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit">{"rev":1}</script>
</div></main>`;

// A tab of 100 rows whose first 12 hold data.
const LONG_BOOK = () => {
  const rows = [];
  const letters = (n) => String.fromCharCode(65 + Math.floor((n - 1) / 26), 65 + ((n - 1) % 26));
  for (let i = 1; i <= 100; i++) {
    const filled = i <= 12;
    rows.push(
      `<tr data-id="pr${i}" data-pos="${letters(i)}"><td>${filled ? `Item ${i}` : ""}</td><td n v="${filled ? i : ""}">${filled ? i : ""}</td></tr>`,
    );
  }
  return `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Long</h2><table grid><colgroup><col data-id="p1" data-pos="V"><col data-id="p2" data-pos="l"></colgroup>
<tbody>${rows.join("")}</tbody></table></section>
<script type="application/json" sheet-commit">{"rev":1}</script>
</div></main>`;
};

async function start(body = BOOK()) {
  page(body);
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

const chartsOf = (Sap, onRedrawn = null, chartSvgTool = null) =>
  createCharts({
    boundRange, COL_DEFAULT, readBox, readTexts, ROW_ESTIMATE, rowOutOfSight, tableMetrics, tableParts,
    tableNamed, scopeOf, canAdopt,
    gridOf: Sap.grid,
    onRedrawn,
    ...(chartSvgTool ? { chartSvg: chartSvgTool } : {}),
  });

// The page's adopted charts stylesheet, as text.
function adoptedChartsSheet() {
  return document.adoptedStyleSheets.map((sheet) => sheet.text ?? "").join("\n");
}

// A page that adopts its stylesheet the way a browser does, with layout standing in for the
// browser's: a figure is measured at its shift, or at the user agent's margins and the static
// stacking below the table while the sheet holds no absolute rule for it.
function installLayout() {
  let sheets = [];
  Object.defineProperty(document, "adoptedStyleSheets", {
    configurable: true,
    get: () => sheets,
    set: (list) => {
      sheets = list;
    },
  });
  window.CSSStyleSheet = class {
    replaceSync(text) {
      this.text = text;
    }
  };
  const rect = (left, top) => ({ left, top, width: 0, height: 0, right: left, bottom: top });
  jest.spyOn(Element.prototype, "getClientRects").mockImplementation(function () {
    return this.localName === "figure" ? [{ left: 0, top: 0, width: 0, height: 0 }] : [];
  });
  jest.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
    if (this.localName !== "figure") return rect(0, 0);
    const text = adoptedChartsSheet();
    if (!text.includes("position:absolute")) {
      const stacked = [...this.parentElement.querySelectorAll(":scope > figure[chart]")].indexOf(this);
      return rect(40, 16 + stacked * 396);
    }
    const at = text.match(new RegExp(`figure\\\[chart="${this.getAttribute("chart")}"\\]\\{translate:(-?\\d+)px (-?\\d+)px`));
    return rect(at ? Number(at[1]) : 0, at ? Number(at[2]) : 0);
  });
  return () => sheets;
}

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  jest.restoreAllMocks();
});

const chartRule = (over = {}) => ({ id: "c1", pos: "V", kind: "chart", range: "A1:B4", source: "A1:B4", type: "column", ...over });

const figuresOf = (table) => [...table.parentElement.querySelectorAll(":scope > figure[chart]")];

// Bug: header detection read the label column's first cell, so a label over blank series cells
// dropped that row as a name row.
test("chartModel reads names, categories and numbers, and leaves out what is not a number", () => {
  const named = chartModel(
    { type: "column" },
    [["Month", "Sales"], ["Jan", 5], ["Feb", 7]],
    [["Month", "Sales"], ["Jan", "5"], ["Feb", "7"]],
  );
  expect(named.series).toEqual([{ name: "Sales", values: [5, 7] }]);
  expect(named.categories).toEqual(["Jan", "Feb"]);

  const plain = chartModel({ type: "column" }, [[4], [5], [6]], [["4"], ["5"], ["6"]]);
  expect(plain.series).toEqual([{ name: "Series 1", values: [4, 5, 6] }]);
  expect(plain.categories).toEqual(["1", "2", "3"]);

  const across = chartModel({ type: "column" }, [["a", 1, 2], ["b", 3, 4]], [["a", "1", "2"], ["b", "3", "4"]]);
  expect(across.series).toEqual([{ name: "Series 1", values: [1, 3] }, { name: "Series 2", values: [2, 4] }]);
  expect(across.categories).toEqual(["a", "b"]);
  // With series="rows", rows read as columns: the first row holds the categories, the first column the names.
  const down = chartModel(
    { type: "column", series: "rows" },
    [["", "Jan", "Feb"], ["North", 1, 2], ["South", 3, 4]],
    [["", "Jan", "Feb"], ["North", "1", "2"], ["South", "3", "4"]],
  );
  expect(down.series).toEqual([{ name: "North", values: [1, 2] }, { name: "South", values: [3, 4] }]);
  expect(down.categories).toEqual(["Jan", "Feb"]);

  const scatter = chartModel({ type: "scatter" }, [[1, 10], [2, 20]], [["1", "10"], ["2", "20"]]);
  expect(scatter.xs).toEqual([1, 2]);
  expect(scatter.series).toEqual([{ name: "Series 1", values: [10, 20] }]);

  const blankHead = chartModel({ type: "column" }, [["Name", null], ["a", 1], ["b", 2]], [["Name", ""], ["a", "1"], ["b", "2"]]);
  expect(blankHead.categories).toEqual(["Name", "a", "b"]);
  expect(blankHead.series).toEqual([{ name: "Series 1", values: [null, 1, 2] }]);

  const mixed = chartModel({ type: "column" }, [["x", "Sales"], ["a", true], ["b", "nope"]], [["x", "Sales"], ["a", "TRUE"], ["b", "nope"]]);
  expect(mixed.series).toEqual([{ name: "Sales", values: [null, null] }]);
});

// Bug: the drawing was written on a timer, so the save an edit starts held the drawing before it.
test("a chart rule gets one figure right after its table, and a change redraws it in the same turn", async () => {
  const { Sap } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({ set: [chartRule()] });
  chartsOf(Sap).watch(table, grid, () => null);

  const figures = figuresOf(table);
  expect(figures).toHaveLength(1);
  const figure = figures[0];
  expect(table.nextElementSibling).toBe(figure);
  expect(figure.getAttribute("sap-ignore")).toBe("");
  expect(figure.querySelector("svg")).not.toBeNull();
  expect(Sap.grid.drawingProblem(figure.innerHTML)).toBeNull();

  const before = figure.innerHTML;
  grid.set("B2", 99);
  expect(figure.innerHTML).not.toBe(before);
  expect(Sap.grid.drawingProblem(figure.innerHTML)).toBeNull();
});

// Bug: a figure whose rule went stayed behind, and a figure no rule names was kept.
test("figures follow the chart rules in order, and a figure no rule names goes", async () => {
  const { Sap } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({ set: [chartRule({ id: "c1" }), chartRule({ id: "c2", type: "line" })] });
  chartsOf(Sap).watch(table, grid, () => null);

  expect(figuresOf(table).map((figure) => figure.getAttribute("chart"))).toEqual(["c1", "c2"]);
  expect(table.nextElementSibling).toBe(figuresOf(table)[0]);

  const stray = document.createElement("figure");
  stray.setAttribute("chart", "nope");
  stray.setAttribute("sap-ignore", "");
  table.after(stray);

  grid.setRules({ remove: ["c1"] });
  expect(figuresOf(table).map((figure) => figure.getAttribute("chart"))).toEqual(["c2"]);
  expect(table.nextElementSibling).toBe(figuresOf(table)[0]);
});

// Bug: a chart reading another tab's range kept the drawing it had when it was first drawn.
test("a chart whose source names another tab redraws when that tab changes", async () => {
  const { Sap } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({ set: [chartRule({ id: "c1", range: "A1:B3", source: "B!A1:A3", type: "column" })] });
  const charts = chartsOf(Sap);
  charts.watch(table, grid, () => null);

  const figure = figuresOf(table)[0];
  const before = figure.innerHTML;
  expect(before).toContain("1");

  charts.watch(tableOf("s2"), Sap.grid(tableOf("s2")));
  Sap.grid(tableOf("s2")).set("A2", "777");
  expect(figure.innerHTML).toContain("777");
  expect(figure.innerHTML).not.toBe(before);
});

// Bug: a row this viewer filtered out stayed in the drawing, so a filtered chart showed it.
test("a row filtered out is left out of the drawing after the next change", async () => {
  const { Sap } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({ set: [chartRule({ id: "c1", range: "A1:B4", source: "A1:B4", type: "column" })] });
  chartsOf(Sap).watch(table, grid, () => null);

  const figure = figuresOf(table)[0];
  expect(figure.innerHTML).toContain("4242");

  setFilteredRows(table, new Set(["pr3"]));
  grid.set("B1", 11);
  expect(figure.innerHTML).not.toContain("4242");
  setFilteredRows(table, null);
});

// Bug: a drawing the module wrote on open counted as an edit every time it redrew, or never
// counted at all, so a file whose drawings were old never got them back.
test("a first drawing that differs from the saved one counts once, and an equal one never", async () => {
  const { Sap } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({ set: [chartRule()] });

  // The file holds a drawing from an older version of the drawer.
  const oldDrawing = () => {
    const figure = document.createElement("figure");
    figure.setAttribute("chart", "c1");
    figure.setAttribute("sap-ignore", "");
    figure.innerHTML = "<svg></svg>";
    return figure;
  };
  table.after(oldDrawing());

  const counted = jest.fn();
  chartsOf(Sap, counted).watch(table, grid, () => null);
  const drawn = figuresOf(table)[0].innerHTML;
  expect(drawn).not.toBe("<svg></svg>");
  expect(counted).toHaveBeenCalledTimes(1);

  // The same drawing again is no change.
  const same = jest.fn();
  chartsOf(Sap, same).watch(table, grid, () => null);
  expect(same).not.toHaveBeenCalled();
  grid.set("B2", 123);
  expect(same).not.toHaveBeenCalled();

  // A merge rebuilt the table and left an older drawing in the section: that peer's drawing is
  // not our change.
  const rebuilt = document.createElement("table");
  rebuilt.setAttribute("grid", "");
  rebuilt.innerHTML = table.innerHTML;
  table.replaceWith(rebuilt);
  rebuilt.after(oldDrawing());
  const again = jest.fn();
  chartsOf(Sap, again).watch(rebuilt, grid, () => null);
  expect(again).not.toHaveBeenCalled();
});

// Bug: the module wrote a style or an attribute on the figure, and a saved figure must hold
// nothing but its content.
test("nothing is set on a figure but its content", async () => {
  const { Sap } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({ set: [chartRule()] });
  chartsOf(Sap).watch(table, grid, () => null);

  grid.set("B2", 99);
  const figure = figuresOf(table)[0];
  expect([...figure.attributes].map((attribute) => attribute.name).sort()).toEqual(["chart", "sap-ignore"]);
  expect(figure.getAttribute("style")).toBeNull();
});

// Bug: chartAt returned the earlier overlapping chart instead of the last in rules order, or matched outside the chart's box.
test("chartRect gives a chart's box and chartAt picks the last overlapping chart in rules order", async () => {
  const { Sap } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({
    set: [
      chartRule({ id: "c1", pos: "V", range: "A1:B3" }),
      chartRule({ id: "c2", pos: "l", range: "B2:D5", type: "line" }),
    ],
  });
  const charts = chartsOf(Sap);
  charts.watch(table, grid, () => null);

  expect(charts.chartRect(table, "c1")).toEqual({ left: 0, top: 0, width: 200, height: 78 });
  expect(charts.chartRect(table, "nope")).toBeNull();
  expect(charts.chartAt(50, 10)?.rule.id).toBe("c1");
  expect(charts.chartAt(150, 40)?.rule.id).toBe("c2");
  expect(charts.chartAt(500, 500)).toBeNull();
});

// Bug: a Date or Year column of numbers was drawn as a series, crushing the real series flat.
test("chartModel reads a numeric first column as the categories' shown text", () => {
  const model = chartModel(
    { type: "column" },
    [[46327, 120], [46328, 130]],
    [["11/1/2026", "120"], ["11/2/2026", "130"]],
  );
  expect(model.categories).toEqual(["11/1/2026", "11/2/2026"]);
  expect(model.series).toEqual([{ name: "Series 1", values: [120, 130] }]);
});

// Bug: the drawing's size came from layout, so a hidden tab drew a smaller drawing and the next
// open of an unchanged file counted it as a change.
test("a chart on a hidden tab draws the size the document saves, and a second open draws the same", async () => {
  const { Sap } = await start(FROZEN_BOOK());
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({ set: [chartRule({ range: "A1:B3", source: "A1:B3" })] });
  const root = document.querySelector("[sheet-workbook]");
  root.style.display = "none";

  chartsOf(Sap).watch(table, grid, () => null);
  const figure = figuresOf(table)[0];
  const svg = figure.querySelector("svg");
  // Two columns of 140 and 90 px, and a 40 px frozen row over a 30 px row and a 26 px one.
  expect([svg.getAttribute("width"), svg.getAttribute("height")]).toEqual(["230", "96"]);

  const drawn = figure.innerHTML;
  root.style.display = "";
  const again = jest.fn();
  chartsOf(Sap, again).watch(table, grid, () => null);
  expect(figure.innerHTML).toBe(drawn);
  expect(again).not.toHaveBeenCalled();
});

// Bug: the first place() measured the figure before the base rule gave it position: absolute, so
// each chart after the first landed on the one before it.
test("each chart on a tab is placed from its own top-left cell on the first place()", async () => {
  const { Sap } = await start();
  installLayout();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({
    set: [
      chartRule({ id: "c1", range: "A1:B4", source: "A1:B4" }),
      chartRule({ id: "c2", range: "B3:C6", source: "A1:B4", type: "line" }),
    ],
  });
  chartsOf(Sap).watch(table, grid, () => null);
  await new Promise((resolve) => setTimeout(resolve, 30));

  const text = adoptedChartsSheet();
  expect(text).toContain('figure[chart="c1"]{translate:0px 0px;width:200px;height:104px}');
  expect(text).toContain('figure[chart="c2"]{translate:100px 52px;width:200px;height:104px}');
});

// Bug: an edit anywhere on a tab redrew every chart of it, so typing on a big sheet stalled.
test("an edit away from a chart's source reads nothing of it", async () => {
  const { Sap } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({ set: [chartRule({ range: "A1:B3", source: "A1:B3" })] });
  const reads = [];
  const charts = createCharts({
    boundRange, COL_DEFAULT, readBox: (g, box) => {
      reads.push(box);
      return readBox(g, box);
    },
    readTexts, ROW_ESTIMATE, rowOutOfSight, tableMetrics, tableParts, tableNamed, scopeOf, canAdopt,
    gridOf: Sap.grid,
  });
  charts.watch(table, grid, () => null);
  expect(reads).toHaveLength(1);

  grid.set("A2", 99);
  expect(reads).toHaveLength(2);
  grid.set("B4", 1);
  expect(reads).toHaveLength(2);
});

// Bug: an open-ended source read every blank row to the tab's end, squeezing the real bars flat.
test("an open-ended source stops at its last row that holds something", async () => {
  const { Sap } = await start(LONG_BOOK());
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({ set: [chartRule({ range: "D1:I15", source: "A:B" })] });
  const drawn = [];
  chartsOf(Sap, null, (model, size) => {
    drawn.push(model);
    return chartSvg(model, size);
  }).watch(table, grid, () => null);
  expect(drawn[0].categories).toHaveLength(12);
});

// Bug: a column the file hides was still plotted.
test("a hidden source column is left out of the drawing", async () => {
  const { Sap } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({ set: [chartRule({ range: "A1:B4", source: "A1:B4" })] });
  table.querySelector(':scope > colgroup > col[data-id="p1"]').hidden = true;
  const drawn = [];
  chartsOf(Sap, null, (model, size) => {
    drawn.push(model);
    return chartSvg(model, size);
  }).watch(table, grid, () => null);
  expect(drawn[0].categories).toEqual(["1", "2", "3", "4"]);
  expect(drawn[0].series).toEqual([{ name: "Series 1", values: [10, 12, 4242, 16] }]);
});

// Bug: the chart module loaded on one tab never heard the first edit of the tab another tab's
// chart reads.
test("a chart on a later tab redraws on the first edit of the tab it reads", async () => {
  const { Sap } = await start();
  window.clay.ready = Promise.resolve();
  const { startShell } = await import("../../../src/sheet/shell.js");
  const shell = startShell({
    windowOptions: { sheet: { replaceSync() {} }, adopt: () => {}, drop: () => {}, schedule: (fn) => fn() },
  });
  await shell.followed;

  const dash = tableOf("s2");
  const data = tableOf("s1");
  Sap.grid(dash).setRules({ set: [chartRule({ id: "c1", range: "A1:B3", source: "Picks!A1:B3" })] });
  for (let i = 0; i < 4; i++) await turn();
  const figure = figuresOf(dash)[0];
  expect(figure).toBeDefined();
  expect(figure.innerHTML).not.toContain("777");

  Sap.grid(data).set("B2", 777);
  await turn();
  expect(figure.innerHTML).toContain("777");
  shell.dispose();
});
