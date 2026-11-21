/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

const frame = () =>
  new Promise((resolve) => {
    if (typeof window.requestAnimationFrame !== "function") {
      setTimeout(resolve, 0);
      return;
    }
    window.requestAnimationFrame(() => setTimeout(resolve, 0));
  });

const BOOK = () => `<main sap plugins="grid"><div id="scroller" style="position:relative;overflow:auto"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="t"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="3">3</td><td n v="30">30</td><td></td></tr>
<tr data-id="r2" data-pos="l"><td n v="4">4</td><td n v="8">8</td><td n v="9">9</td></tr>
<tr data-id="r3" data-pos="t"><td>Note</td><td></td><td></td></tr>
</tbody></table></section>
<section item data-id="s2" data-pos="l"><h2 bind="name">Totals</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n f="=Budget!A1*2" v="6">6</td><td></td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit>{"rev":1}</script>
</div></div></main>`;

const SLICE_BOOK = () => `<main sap plugins="grid"><div id="scroller" style="position:relative;overflow:auto"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="l"><col data-id="c4" data-pos="l"><col data-id="c5" data-pos="l"><col data-id="c6" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="1">1</td><td n v="2">2</td><td n></td><td n></td><td n></td><td n></td></tr>
<tr data-id="r2" data-pos="l"><td n></td><td n v="3">3</td><td n v="4">4</td><td n></td><td n></td><td n></td></tr>
<tr data-id="r3" data-pos="l"><td n></td><td n v="5">5</td><td n f="=B3*2" v="10">10</td><td n></td><td n></td><td n></td></tr>
<tr data-id="r4" data-pos="l"><td n></td><td n></td><td n></td><td n></td><td n></td><td n></td></tr>
<tr data-id="r5" data-pos="l"><td n></td><td n></td><td n></td><td n></td><td n></td><td n></td></tr>
<tr data-id="r6" data-pos="l"><td n></td><td n></td><td n></td><td n></td><td n></td><td n></td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit>{"rev":1}</script>
</div></div></main>`;

const SORT_BOOK = () => `<main sap plugins="grid"><div id="scroller" style="position:relative;overflow:auto"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Plain</h2><table grid><colgroup><col data-id="c1" data-pos="F"><col data-id="c2" data-pos="P"><col data-id="c3" data-pos="Z"></colgroup>
<tbody>
<tr data-id="r1" data-pos="F"><td>k2</td><td n v="20">20</td><td>x</td></tr>
<tr data-id="r2" data-pos="P"><td>k1</td><td n v="5">5</td><td>y</td></tr>
<tr data-id="r3" data-pos="Z"><td>k3</td><td n v="15">15</td><td>z</td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit>{"rev":1}</script>
</div></div></main>`;

function installAdoptedStyleSheets() {
  let adopted = [];
  window.CSSStyleSheet = class {
    constructor() {
      this.text = "";
    }
    replaceSync(text) {
      this.text = text;
    }
  };
  Object.defineProperty(document, "adoptedStyleSheets", {
    configurable: true,
    get: () => adopted,
    set: (next) => {
      adopted = next;
    },
  });
  return () => adopted;
}

async function start(body = BOOK()) {
  jest.resetModules();
  window.sessionStorage.clear();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.Sap;
  delete window.sapPlugins;
  delete window.clayEditMode;
  window.clay = { ready: new Promise(() => {}) };
  document.head.innerHTML = "";
  document.body.innerHTML = body;
  installAdoptedStyleSheets();

  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { startShell } = await import("../../../src/sheet/shell.js");
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const { startInterface } = await import("../../../src/sheet/interface.js");

  let ui = null;
  const shell = startShell({ windowOptions: { schedule: (fn) => fn() } });
  const books = ownWorkbooks({
    onRebuild: () => {
      shell.restart();
      ui?.restart();
    },
  });
  await books.ready;
  Sap.mount();
  await turn();

  const root = document.querySelector("[sheet-workbook]");
  ui = startInterface({ shell, platform: "MacIntel" });
  const book = books.books.get(root);
  const inst = ui.of(root);
  return { Sap, books, book, root, shell, ui, inst };
}

const tableOf = (id) => document.querySelector(`section[data-id="${id}"] table[grid]`);

function press(field, key, init = {}) {
  field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init }));
}

function pointerEvent(type, init = {}) {
  const Ctor = typeof window.PointerEvent === "function" ? window.PointerEvent : window.Event;
  const event = new Ctor(type, { bubbles: true, cancelable: true, composed: true });
  for (const [key, value] of Object.entries({ pointerType: "touch", isPrimary: true, ...init })) {
    Object.defineProperty(event, key, { configurable: true, get: () => value });
  }
  return event;
}

function clickCell(cell, pointerType) {
  cell.dispatchEvent(pointerEvent("pointerdown", { pointerType, clientX: 10, clientY: 10 }));
  cell.dispatchEvent(pointerEvent("pointerup", { pointerType, clientX: 10, clientY: 10 }));
  cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: 10, clientY: 10 }));
  cell.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: 10, clientY: 10 }));
  cell.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1, clientX: 10, clientY: 10 }));
}

function typeInto(field, text) {
  field.focus();
  field.value = text;
  field.setSelectionRange(text.length, text.length);
  field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

// Records every action's kind that reaches a Grid through dispatch, and still applies it.
function watch(grid, seen) {
  const original = grid.dispatch.bind(grid);
  grid.dispatch = (action) => {
    seen.push(action?.action?.t ?? action?.t);
    return original(action);
  };
  return grid;
}

const openFilterPanel = async (inst, col) => {
  inst.overlays.shadow.querySelector(`[data-filter-col="${col}"]`).click();
  await turn();
  await turn();
  return inst.chrome.topShadow.querySelector("[data-filter-panel]");
};

const toolbarFilter = (inst) => inst.chrome.topShadow.querySelector('[data-command="filter"]');

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.CSSStyleSheet;
  delete document.adoptedStyleSheets;
  delete window.Sap;
  delete window.clay;
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  jest.restoreAllMocks();
});

// Bug: a typed value reached the Grid through apply instead of dispatch, so a live room never saw it.
test("typing in a cell ends in grid.dispatch", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const seen = [];
  watch(Sap.grid(tableOf("s1")), seen);

  typeInto(inst.editor.textarea, "42");
  press(inst.editor.textarea, "Enter");
  await turn();

  expect(Sap.grid(tableOf("s1")).get("A1")).toBe(42);
  expect(seen).toContain("set");

  ui.dispose();
});

// Bug: a checkbox tick reached the Grid through apply instead of dispatch.
test("a checkbox toggle ends in grid.dispatch", async () => {
  const { Sap, ui, inst } = await start();
  const table = tableOf("s1");
  const grid = Sap.grid(table);
  grid.setRules({ set: [{ id: "k1", pos: "V", kind: "check", range: "B1:B3" }] });
  grid.set("B2", "TRUE");
  const seen = [];
  watch(grid, seen);

  clickCell(table.rows[1].cells[1], "mouse");
  await frame();

  expect(String(grid.get("B2")).toUpperCase()).toBe("FALSE");
  expect(seen).toContain("set");

  ui.dispose();
});

// Bug: a clear over rows a filter hides reached the Grid through apply instead of dispatch.
test("a Delete over partially filtered rows ends in grid.dispatch", async () => {
  const { Sap, shell, ui, inst } = await start(SLICE_BOOK());
  const { setFilteredRows } = await import("../../../src/sheet/geometry.js");
  const table = tableOf("s1");
  setFilteredRows(table, new Set(["r2"]));
  shell.windowOf(table).refresh();
  await turn();

  const grid = Sap.grid(table);
  const seen = [];
  watch(grid, seen);

  const textarea = inst.editor.textarea;
  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown", { shiftKey: true });
  press(textarea, "ArrowDown", { shiftKey: true });
  press(textarea, "ArrowDown", { shiftKey: true });
  press(textarea, "ArrowRight", { shiftKey: true });

  press(textarea, "Delete");

  expect(grid.get("B2")).toBe(3);
  expect(grid.get("B1")).toBeNull();
  expect(seen).toContain("set");

  ui.dispose();
});

// Bug: a range sort reached the Grid through apply instead of dispatch.
test("a range sort ends in grid.dispatch", async () => {
  const { Sap, ui, inst } = await start(SORT_BOOK());
  const seen = [];
  watch(Sap.grid(tableOf("s1")), seen);

  inst.overlays.shadow
    .querySelector('[data-col="1"]')
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 140, clientY: 10 }));
  await turn();
  const item = inst.chrome.topShadow.querySelector('[data-menu-item="sort-range-asc"]');
  expect(item).not.toBeNull();
  item.click();

  expect(Sap.grid(tableOf("s1")).get("A1:C3")).toEqual([
    ["k2", 5, "x"],
    ["k1", 15, "y"],
    ["k3", 20, "z"],
  ]);
  expect(seen).toContain("sort");

  ui.dispose();
});

// Bug: the filter header's sort reached the Grid through apply instead of dispatch.
test("a sort from the filter panel ends in grid.dispatch", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const grid = Sap.grid(tableOf("s1"));
  grid.set("B2", 9);
  grid.set("B3", 5);
  await turn();
  const seen = [];
  watch(grid, seen);

  const textarea = inst.editor.textarea;
  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown");
  toolbarFilter(inst).click();
  await turn();
  await turn();
  const panel = await openFilterPanel(inst, 1);
  panel.querySelector("[data-filter-sort-asc]").click();
  await turn();
  await turn();

  expect(grid.get("B2")).toBe(5);
  expect(grid.get("B3")).toBe(9);
  expect(seen).toContain("sort");

  ui.dispose();
});

// Bug: adding, duplicating, moving, renaming or deleting a tab reached the Grid through apply.
test("adding, duplicating, moving, renaming and deleting a tab each end in grid.dispatch", async () => {
  const { Sap, ui, inst } = await start();
  const seen = [];
  const watched = new Set();
  const watchAll = () => {
    for (const t of inst.tabs.list()) {
      const table = t.table;
      const grid = table ? Sap.grid(table) : null;
      if (!grid || watched.has(grid)) continue;
      watched.add(grid);
      watch(grid, seen);
    }
  };
  const tabBtns = () => [...inst.chrome.bottomShadow.querySelectorAll('[role="tab"]')];
  const contextOn = (btn) =>
    btn.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 400 }));
  const confirm = () => inst.chrome.topShadow.querySelector('[role="dialog"]').querySelector('button[type="submit"]').click();

  watchAll();
  inst.chrome.bottomShadow.querySelector('[data-command="add-tab"]').click();
  await turn();
  await turn();
  expect(tabBtns()).toHaveLength(3);
  expect(seen).toContain("insertSheet");

  seen.length = 0;
  watchAll();
  contextOn(tabBtns()[0]);
  await turn();
  inst.chrome.topShadow.querySelector('[data-menu-item="duplicate-tab"]').click();
  expect(tabBtns()).toHaveLength(4);
  expect(seen).toContain("insertSheet");

  seen.length = 0;
  watchAll();
  contextOn(tabBtns()[1]);
  await turn();
  inst.chrome.topShadow.querySelector('[data-menu-item="move-tab-right"]').click();
  expect(seen).toContain("moveSheet");

  seen.length = 0;
  watchAll();
  tabBtns()[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  const renameInput = inst.chrome.bottomShadow.querySelector("[data-tab-rename]");
  renameInput.value = "Renamed by hand";
  press(renameInput, "Enter");
  await turn();
  await turn();
  expect(inst.tabs.list()[1].name).toBe("Renamed by hand");
  expect(seen).toContain("renameSheet");

  seen.length = 0;
  watchAll();
  contextOn(tabBtns()[1]);
  await turn();
  inst.chrome.topShadow.querySelector('[data-menu-item="delete-tab"]').click();
  confirm();
  await turn();
  await turn();
  expect(tabBtns()).toHaveLength(3);
  expect(seen).toContain("deleteSheet");

  ui.dispose();
});

// Bug: Insert checkbox's rule and its blank fills reached the Grid through apply.
test("Insert checkbox ends in grid.dispatch", async () => {
  const { Sap, ui, inst } = await start();
  const grid = Sap.grid(tableOf("s1"));
  const seen = [];
  watch(grid, seen);

  const textarea = inst.editor.textarea;
  press(textarea, "ArrowRight");
  press(textarea, "ArrowRight", { shiftKey: true });
  press(textarea, "ArrowDown", { shiftKey: true });
  press(textarea, "ArrowDown", { shiftKey: true });
  expect(inst.chrome.nameBox.textContent).toBe("B1:C3");

  inst.chrome.topShadow.querySelector('[data-command="checkbox"]').click();
  await turn();
  await turn();

  expect(grid.rules()).toHaveLength(1);
  expect(seen).toContain("set");
  expect(seen).toContain("rules");

  ui.dispose();
});

// Bug: a failed xlsx import removed its tabs through apply, so a live room never saw the removal.
test("removing an import's tabs after a failure ends in grid.dispatch", async () => {
  jest.resetModules();
  delete window.Sap;
  window.clay = { ready: new Promise(() => {}) };
  document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody><tr data-id="r1" data-pos="V"><td>7</td><td></td></tr><tr data-id="r2" data-pos="l"><td></td><td></td></tr></tbody></table></section>
</div></main>`;
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const { applyImport } = await import("../../../src/sheet/xlsx.js");
  await ownWorkbooks({}).ready;
  Sap.mount();
  const root = document.querySelector("[sheet-workbook]");

  const tabs = {
    list: () =>
      [...root.querySelectorAll(":scope > section[item]")].map((el) => ({
        id: el.getAttribute("data-id"),
        name: el.querySelector("h2")?.textContent ?? "",
        pos: el.getAttribute("data-pos"),
        table: el.querySelector("table[grid]"),
      })),
    show: () => {},
  };
  const ctx = {
    doc: document,
    win: window,
    workbook: root,
    chrome: { showNotice: () => {}, hideNotice: () => {} },
    editor: { textarea: document.createElement("textarea"), focus: () => {} },
    tabs,
    history: null,
    gridOf: (table) => (table ? Sap.grid(table) : null),
    viewOf: () => ({ rows: ["r"], cols: ["c"] }),
    getSel: () => null,
    setSel: () => {},
    applySelection: () => {},
    withMine: (fn) => fn(),
    subscribeGrids: () => {},
    showDialog: () => {},
    clearDialog: () => {},
  };

  const seen = [];
  watch(ctx.gridOf(tabs.list()[0].table), seen);
  const plan = {
    tabs: [
      { name: "Data", rows: 1, cols: 1, block: [[1]], merges: [], widths: [], heights: [] },
      { name: "Second", rows: 2, cols: 2, block: [[2]], merges: ["A1:B2", "B2:C3"], widths: [], heights: [] },
    ],
  };
  expect(() => applyImport(ctx, plan)).toThrow(expect.objectContaining({ name: "ImportStopped" }));
  expect(tabs.list().map((t) => t.name)).toEqual(["Budget"]);
  expect(seen).toEqual(["insertSheet", "insertSheet", "deleteSheet", "deleteSheet"]);
});
