/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { openCsvMenu } from "../../../src/sheet/csv.js";
import { applyImport, buildWorkbook, checkFormula, importXlsxFile, lossLines, planImport, serialOf } from "../../../src/sheet/xlsx.js";
import { resolveTheme } from "../../../src/ui/theme.js";

globalThis.self ??= globalThis;
const ExcelJS = (await import("../../../src/vendor/exceljs.vendor.js")).default;
const CORPUS = new URL("../../fixtures/sheet/wb01.xlsx", import.meta.url);

const BOOK = `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody><tr data-id="r1" data-pos="V"><td>7</td><td></td></tr><tr data-id="r2" data-pos="l"><td></td><td></td></tr></tbody></table></section></div></main>`;

async function mountBook() {
  jest.resetModules();
  delete window.Sap;
  window.clay = { ready: new Promise(() => {}) };
  document.body.innerHTML = BOOK;
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  await ownWorkbooks({}).ready;
  Sap.mount();
  const root = document.querySelector("[sheet-workbook]");
  const notices = [];
  const dialogs = [];
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
    chrome: { theme: resolveTheme(), topRoot: document.body, showNotice: (m) => notices.push(m), hideNotice: () => {} },
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
    showDialog: (tab, handle) => dialogs.push(Object.assign(handle, { tab })),
    clearDialog: () => {},
  };
  const gridOfTab = (name) => ctx.gridOf(tabs.list().find((t) => t.name === name)?.table);
  return { Sap, root, ctx, tabs, notices, dialogs, gridOfTab };
}

async function bytesOf(book) {
  return new Uint8Array(await book.xlsx.writeBuffer());
}

async function load(bytes) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return book;
}

async function planOf(book, existingTabs) {
  const bytes = await bytesOf(book);
  return planImport(await load(bytes), bytes, { tokenize: window.Sap.grid.tokenize, existingTabs });
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

// Bug: a cell type, the 1900 or 1904 date rule, an error result, a merge, the freeze, a width or a
// style was dropped or changed on the way in or out, so a workbook does not survive import and export.
test("a workbook made in ExcelJS survives import into new tabs and export back", async () => {
  const { ctx, tabs, gridOfTab } = await mountBook();
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet("Data");
  ws.getCell("A1").value = 5;
  ws.getCell("B1").value = "=not a formula";
  ws.getCell("C1").value = true;
  ws.getCell("A2").value = { formula: "A1*2", result: 10 };
  ws.getCell("B2").value = { formula: "1/0", result: "#DIV/0!" };
  ws.getCell("C2").value = { error: "#N/A" };
  for (const [ref, serial] of [["A3", 59], ["B3", 61], ["C3", 45658]]) {
    ws.getCell(ref).value = serial;
    ws.getCell(ref).numFmt = "yyyy-mm-dd";
  }
  ws.getCell("A4").value = 1234.5;
  ws.getCell("A4").numFmt = "#,##0.00";
  ws.getCell("A4").font = { bold: true, color: { argb: "FF336699" } };
  ws.getCell("A4").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFEE88" } };
  ws.getCell("A4").border = { bottom: { style: "medium", color: { argb: "FF112233" } } };
  ws.getCell("B4").value = "wide";
  ws.mergeCells("B4:C5");
  ws.getColumn(2).width = 20;
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 2 }];

  const plan = await planOf(book, tabs.list());
  expect(lossLines(plan)).toEqual([]);
  applyImport(ctx, plan);
  const grid = gridOfTab("Data");
  expect(grid.cell("A1").content).toBe(5);
  expect(grid.cell("B1").content).toBe("=not a formula");
  expect(grid.cell("C1").content).toBe(true);
  expect(grid.cell("A2")).toMatchObject({ content: { f: "=A1*2" }, value: 10 });
  expect(grid.cell("B2")).toMatchObject({ content: { f: "=1/0" }, value: "#DIV/0!" });
  expect(grid.cell("C2")).toMatchObject({ content: { f: "=#N/A" }, value: "#N/A" });
  expect(grid.cell("A3")).toMatchObject({ content: 60, text: "1900-02-28" });
  expect(grid.cell("B3")).toMatchObject({ content: 61, text: "1900-03-01" });
  expect(grid.cell("C3")).toMatchObject({ content: 45658, text: "2025-01-01" });
  expect(grid.cell("A4")).toMatchObject({ fmt: "#,##0.00" });
  expect(grid.cell("A4").style).toBe("font-weight:bold;color:#336699;background-color:#ffee88;border-bottom:2px solid #112233");
  expect(grid.cell("B4").span).toBeTruthy();
  expect(grid.cell("C5").covered).toBe(true);
  const table = tabs.list().find((t) => t.name === "Data").table;
  expect(table.tHead.rows.length).toBe(2);
  expect(table.getAttribute("freeze-cols")).toBe("1");
  expect(table.querySelectorAll(":scope > colgroup > col")[1].style.width).toBe("145px");

  const out = await load(await bytesOf(buildWorkbook(ExcelJS, tabs.list(), ctx.gridOf, { fmtKind: window.Sap.grid.fmtKind, tokenize: window.Sap.grid.tokenize })));
  const back = out.getWorksheet("Data");
  expect(back.getCell("A1").value).toBe(5);
  expect(back.getCell("B1").value).toBe("=not a formula");
  expect(back.getCell("A2").value).toEqual({ formula: "A1*2", result: 10 });
  expect(back.getCell("B2").value).toEqual({ formula: "1/0", result: { error: "#DIV/0!" } });
  // Excel stores 1900-02-28 as day 59, which ExcelJS reads linearly as 1900-02-27.
  expect(back.getCell("A3").value.toISOString().slice(0, 10)).toBe("1900-02-27");
  expect(serialOf(back.getCell("A3").value, "yyyy-mm-dd")).toBe(60);
  expect(serialOf(back.getCell("B3").value, "yyyy-mm-dd")).toBe(61);
  expect(back.getCell("A4").numFmt).toBe("#,##0.00");
  expect(back.getCell("A4").font).toMatchObject({ bold: true, color: { argb: "FF336699" } });
  expect(back.getCell("A4").fill).toMatchObject({ pattern: "solid", fgColor: { argb: "FFFFEE88" } });
  expect(back.getCell("A4").border.bottom).toMatchObject({ style: "medium", color: { argb: "FF112233" } });
  expect(back.model.merges).toContain("B4:C5");
  expect(back.views[0]).toMatchObject({ state: "frozen", xSplit: 1, ySplit: 2 });
  expect(back.getColumn(2).width).toBeCloseTo(20, 5);
  expect(out.worksheets.map((s) => s.name)).toEqual(["Budget", "Data"]);
});

// Bug: a 1904 file's dates were read as if day 0 were 1899-12-30, so every date moved four years.
test("a 1904 date system file keeps its dates", async () => {
  const { tabs } = await mountBook();
  const book = new ExcelJS.Workbook();
  book.properties.date1904 = true;
  const ws = book.addWorksheet("Old Mac");
  ws.getCell("A1").value = 0;
  ws.getCell("A1").numFmt = "yyyy-mm-dd";
  const plan = await planOf(book, tabs.list());
  expect(plan.tabs[0].block[0][0]).toEqual({ content: 1462, fmt: "yyyy-mm-dd" });
});

// Bug: a formula calling a function the sheet lacks was written as is and showed #NAME?, or a named
// range was read as two columns, and neither was listed before the import.
test("a formula the sheet cannot compute becomes its saved value and is listed by name", async () => {
  const { ctx, tabs, gridOfTab } = await mountBook();
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet("Calc");
  ws.getCell("A1").value = { formula: "_xlfn.XLOOKUP(1,B1:B2,C1:C2)", result: 3 };
  ws.getCell("A2").value = { formula: "FORECAST.LINEAR(1,B1:B2,C1:C2)", result: 4.5 };
  ws.getCell("A3").value = { formula: "TaxRate*2", result: 0.4 };
  ws.getCell("A4").value = { formula: "NOSUCH(1)", result: "#N/A" };
  ws.getCell("A5").value = { formula: "SUM(B1:B2)", result: 0 };
  const plan = await planOf(book, tabs.list());
  expect(lossLines(plan)).toEqual([
    { key: "functions", label: "Formulas using functions this sheet doesn't have, kept as their saved values (FORECAST.LINEAR, NOSUCH)", count: 2 },
    { key: "names", label: "Formulas using named ranges or other files, kept as their saved values", count: 1 },
  ]);
  applyImport(ctx, plan);
  const grid = gridOfTab("Calc");
  expect(grid.cell("A1").content).toEqual({ f: "=XLOOKUP(1,B1:B2,C1:C2)" });
  expect(grid.cell("A2").content).toBe(4.5);
  expect(grid.cell("A3").content).toBe(0.4);
  expect(grid.cell("A4").content).toEqual({ f: "=NOSUCH(1)" });
  expect(grid.cell("A5").content).toEqual({ f: "=SUM(B1:B2)" });
});

// Bug: the tokenizer reads a defined name as joined coordinates or a bare column word, and the
// check let it through, so the formula silently showed an error after import.
test("checkFormula flags names, other files and unknown tabs, and passes plain formulas", async () => {
  await mountBook();
  const tokenize = window.Sap.grid.tokenize;
  const sheets = new Set(["data", "tab two"]);
  const unreadable = (text) => checkFormula(text, tokenize, sheets).unreadable;
  expect(unreadable("=MyName2+1")).toBe(true);
  expect(unreadable("=Tax*2")).toBe(true);
  expect(unreadable("=X1Y2*3")).toBe(true);
  expect(unreadable("=[1]Data!A1")).toBe(true);
  expect(unreadable("=Missing!A1")).toBe(true);
  expect(unreadable("=SUM(A:A)+SUM(2:3)+'Tab Two'!B1+Data!$C$4")).toBe(false);
  expect(unreadable('=IF(A1>0,"x(",TRUE)')).toBe(false);
});

// Bug: a file tab named like an existing tab was renamed on import, but its formulas still named
// the old tab, so they read the workbook's own tab instead of the imported one.
test("a tab that collides gets a free name and formulas follow it", async () => {
  const { ctx, tabs, gridOfTab } = await mountBook();
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Budget").getCell("A1").value = 40;
  book.addWorksheet("Sum").getCell("A1").value = { formula: "Budget!A1+1", result: 41 };
  const plan = await planOf(book, tabs.list());
  expect(plan.tabs.map((t) => t.name)).toEqual(["Budget (2)", "Sum"]);
  applyImport(ctx, plan);
  expect(gridOfTab("Sum").cell("A1")).toMatchObject({ content: { f: "='Budget (2)'!A1+1" }, value: 41 });
  expect(gridOfTab("Budget").cell("A1").content).toBe(7);
});

// Bug: charts, pictures, comments, hidden tabs, rich text, links or validation were dropped without
// a line in the dialog, so the person importing never learned they were gone.
test("what does not come across is counted before anything is written", async () => {
  const { tabs } = await mountBook();
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet("Notes");
  ws.getCell("A1").value = { richText: [{ text: "bo", font: { bold: true } }, { text: "ld" }] };
  ws.getCell("A2").value = { text: "site", hyperlink: "https://example.com" };
  ws.getCell("A3").note = "remember";
  ws.getCell("A4").dataValidation = { type: "list", formulae: ['"a,b"'] };
  ws.getCell("A5").alignment = { vertical: "middle" };
  ws.getRow(6).hidden = true;
  ws.getCell("A6").value = 1;
  const picture = book.addImage({ base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", extension: "png" });
  ws.addImage(picture, "C1:D2");
  book.addWorksheet("Secret").state = "hidden";
  const plan = await planOf(book, tabs.list());
  const counts = Object.fromEntries(lossLines(plan).map((l) => [l.key, l.count]));
  expect(counts).toEqual({ pictures: 1, comments: 1, validation: 1, hiddenTabs: 1, hiddenLines: 1, richText: 1, links: 1, vertical: 1 });
  expect(plan.tabs[0].block[0][0]).toBe("bold");
  expect(plan.tabs[0].block[1][0]).toBe("site");
});

// Bug: an oversized tab was imported (freezing the page) or refused the whole file instead of
// only itself.
test("a tab over the size limit is refused and the others still import", async () => {
  const { tabs } = await mountBook();
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Huge").getCell("A10001").value = 1;
  book.addWorksheet("Small").getCell("A1").value = 1;
  const plan = await planOf(book, tabs.list());
  expect(plan.refused).toEqual([{ name: "Huge", rows: 10001, cols: 1 }]);
  expect(plan.tabs.map((t) => t.name)).toEqual(["Small"]);
});

// Bug: a write that failed partway left the tabs added before it, half filled.
test("a failure halfway removes every tab the import added", async () => {
  const { ctx, tabs } = await mountBook();
  const book = new ExcelJS.Workbook();
  book.addWorksheet("First").getCell("A1").value = 1;
  book.addWorksheet("Second").getCell("A1").value = 2;
  const plan = await planOf(book, tabs.list());
  plan.tabs[1].merges = ["A1:B2", "B2:C3"];
  expect(() => applyImport(ctx, plan)).toThrow(expect.objectContaining({ name: "ImportStopped" }));
  expect(tabs.list().map((t) => t.name)).toEqual(["Budget"]);
});

// Bug: the dialog wrote before the person chose, or Cancel still added the tabs.
test("the dialog lists the tabs and losses, and Cancel writes nothing", async () => {
  const { ctx, tabs, dialogs } = await mountBook();
  const book = new ExcelJS.Workbook();
  book.addWorksheet("People").getCell("A1").value = { formula: "NOSUCH(1)", result: 2 };
  const bytes = await bytesOf(book);
  await importXlsxFile(ctx, { name: "people.xlsx", bytes }, { loadExcelJS: async () => ExcelJS });
  expect(tabs.list().map((t) => t.name)).toEqual(["Budget"]);
  const [dialog] = dialogs;
  const text = document.body.textContent;
  expect(text).toContain("People: 1 row, 1 column");
  expect(text).toContain("Formulas using functions this sheet doesn't have, kept as their saved values (NOSUCH): 1");
  const cancel = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel");
  cancel.click();
  expect(tabs.list().map((t) => t.name)).toEqual(["Budget"]);
  expect(dialog).toBeTruthy();
});

// Bug: Import in the dialog did nothing, or a file that is not a workbook threw instead of a notice.
test("Import adds the tabs, and a file that is not a workbook gets a notice", async () => {
  const { ctx, tabs, notices } = await mountBook();
  const book = new ExcelJS.Workbook();
  book.addWorksheet("People").getCell("A1").value = "Ada";
  await importXlsxFile(ctx, { name: "people.xlsx", bytes: await bytesOf(book) }, { loadExcelJS: async () => ExcelJS });
  [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Import").click();
  expect(tabs.list().map((t) => t.name)).toEqual(["Budget", "People"]);

  await importXlsxFile(ctx, { name: "notes.xlsx", bytes: new TextEncoder().encode("plain text") }, { loadExcelJS: async () => ExcelJS });
  expect(notices.at(-1)).toBe("This file could not be read as an Excel workbook (.xlsx).");
});

// Bug: the Google Sheets file's error results (plain strings there) were written as text, or one of
// its formulas changed on the way in.
test("the Google Sheets corpus file imports every value and formula", async () => {
  const { ctx, tabs, gridOfTab } = await mountBook();
  const bytes = new Uint8Array(readFileSync(CORPUS));
  const source = await load(bytes);
  const plan = planImport(source, bytes, { tokenize: window.Sap.grid.tokenize, existingTabs: tabs.list() });
  applyImport(ctx, plan);
  const sheet = source.worksheets[0];
  const grid = gridOfTab(plan.tabs[0].name);
  let formulas = 0;
  sheet.eachRow((row, r) => {
    row.eachCell((cell, c) => {
      const ref = `${String.fromCharCode(64 + c)}${r}`;
      const got = grid.cell(ref).content;
      if (cell.formula) {
        formulas += 1;
        expect([ref, got]).toEqual([ref, { f: `=${cell.formula.replace(/_xlfn\./g, "")}` }]);
      } else if (typeof cell.value === "number" || typeof cell.value === "boolean") {
        expect([ref, got]).toEqual([ref, cell.value]);
      } else if (typeof cell.value === "string") {
        expect([ref, got]).toEqual([ref, cell.value]);
      }
    });
  });
  expect(formulas).toBeGreaterThan(50);
  expect(plan.losses.functions + plan.losses.names).toBe(0);
});

// Bug: the Import and export menu lost its .xlsx entries, or a picked file never reached the import
// (the picker must open inside the click, before the .xlsx tools load).
test("the menu's .xlsx entries open a picker and pass the file to the import, and download all tabs", async () => {
  const { ctx } = await mountBook();
  const calls = [];
  const fake = { importXlsxFile: (c, picked) => calls.push(["import", picked.name, picked.bytes.length]), downloadXlsx: () => calls.push(["download"]) };
  ctx.xlsx = (fn) => fn(fake);
  ctx.chrome.getButton = () => null;
  let opened = null;
  openCsvMenu(ctx, { open: (opts) => (opened = opts) });
  const notices = [];
  ctx.chrome.showNotice = (message) => notices.push(message);
  opened.items.find((item) => item.id === "import-xlsx").onSelect();
  const input = document.querySelector("[data-xlsx-file-input]");
  expect(calls).toEqual([]);
  const bytes = new Uint8Array([1, 2, 3]);
  Object.defineProperty(input, "files", { value: [{ name: "q3.xlsx", size: 3, arrayBuffer: async () => bytes.buffer }] });
  input.dispatchEvent(new Event("change"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  opened.items.find((item) => item.id === "export-xlsx").onSelect();
  expect(calls).toEqual([["import", "q3.xlsx", 3], ["download"]]);
  expect(notices).toEqual(["Reading the file..."]);
});

// Bug: the 1900 leap day correction (or a 1904 file's offset) was added to a time of day or a
// duration, so 8:30 in [h]:mm showed 32:30 and pay totals grew by a day.
test("times and durations keep Excel's number, in 1900 and 1904 files", async () => {
  const { tabs } = await mountBook();
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet("Hours");
  for (const [ref, value, fmt] of [["A1", 0.5, "h:mm AM/PM"], ["A2", 1.5, "[h]:mm"], ["A3", 45000.25, "m/d/yyyy h:mm"]]) {
    ws.getCell(ref).value = value;
    ws.getCell(ref).numFmt = fmt;
  }
  const plan = await planOf(book, tabs.list());
  expect(plan.tabs[0].block.map((line) => line[0].content)).toEqual([0.5, 1.5, 45000.25]);

  const old = new ExcelJS.Workbook();
  old.properties.date1904 = true;
  old.addWorksheet("Mac").getCell("A1").value = 0.75;
  old.getWorksheet("Mac").getCell("A1").numFmt = "h:mm";
  expect((await planOf(old, tabs.list())).tabs[0].block[0][0].content).toBeCloseTo(0.75, 9);
});

// Bug: filled formulas were moved with ExcelJS's text rule, which never moves whole columns and
// moves cell-like words inside quotes, so a SUM(B:B) filled across summed column B in every month.
test("filled formulas move like the sheet's own fill", async () => {
  const { tabs } = await mountBook();
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet("Months");
  ws.getCell("B1").value = { formula: "SUM(A:A)", shareType: "shared", ref: "B1:D1", result: 6 };
  ws.getCell("C1").value = { sharedFormula: "B1", result: 60 };
  ws.getCell("D1").value = { sharedFormula: "B1", result: 600 };
  ws.getCell("E2").value = { formula: 'IF(B2="Q1",C2,0)', shareType: "shared", ref: "E2:E3", result: 0 };
  ws.getCell("E3").value = { sharedFormula: "E2", result: 0 };
  const { block } = (await planOf(book, tabs.list())).tabs[0];
  expect([block[0][1], block[0][2], block[0][3]]).toEqual([{ f: "=SUM(A:A)" }, { f: "=SUM(B:B)" }, { f: "=SUM(C:C)" }]);
  expect(block[2][4]).toEqual({ f: '=IF(B3="Q1",C3,0)' });
});

// Bug: array formulas, math on whole ranges and empty arguments passed the function check and
// showed #VALUE! or #ERROR! after import, with no line in the dialog.
test("formulas the engine computes differently keep their saved values and are listed", async () => {
  const { tabs } = await mountBook();
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet("Sales");
  ws.getCell("D1").value = { formula: 'SUMPRODUCT((A1:A3="East")*B1:B3)', result: 12400 };
  ws.getCell("D2").value = { formula: "VLOOKUP(2,A1:B3,2,)", result: 7 };
  ws.getCell("D3").value = { formula: "A1:A2", shareType: "array", ref: "D3:D4", result: 4 };
  ws.getCell("D5").value = { formula: "SUM(A1:A3)*2", result: 0 };
  const plan = await planOf(book, tabs.list());
  expect(plan.tabs[0].block.slice(0, 5).map((line) => line[3])).toEqual([12400, 7, 4, null, { f: "=SUM(A1:A3)*2" }]);
  expect(plan.losses.differs).toBe(3);
});

// Bug: a formula naming a tab that was refused for size read the workbook's own tab of that name.
test("a formula naming a refused tab keeps its saved value", async () => {
  const { tabs } = await mountBook();
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Budget").getCell("A10001").value = 500;
  book.addWorksheet("Sum").getCell("A1").value = { formula: "Budget!A1*2", result: 1000 };
  const plan = await planOf(book, tabs.list());
  expect(plan.tabs[0].block[0][0]).toBe(1000);
  expect(plan.losses.names).toBe(1);
});

// Bug: formatting-only rows counted toward a tab's size, so a log with borders to row 12,000 was
// refused; a merge across the frozen line stopped the whole import; tables and the date format
// Excel types by default changed with no line.
test("a tab is sized by its filled cells, a freeze that cuts a merge is dropped, and tables are listed", async () => {
  const { ctx, tabs, gridOfTab } = await mountBook();
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet("Log");
  ws.getCell("A1").value = "Title";
  ws.mergeCells("A1:A3");
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.getCell("B12000").border = { bottom: { style: "thin" } };
  ws.getCell("B4").value = 45000;
  ws.getCell("B4").numFmt = "mm-dd-yy";
  ws.addTable({ name: "Items", ref: "C4", columns: [{ name: "Item" }], rows: [["pen"]] });
  const plan = await planOf(book, tabs.list());
  expect(plan.tabs[0]).toMatchObject({ rows: 5, cols: 3, freeze: null });
  expect(plan.tabs[0].block[3][1]).toEqual({ content: 45000, fmt: "m/d/yyyy" });
  expect(plan.losses).toMatchObject({ unfrozen: 1, formatPast: 1, tables: 1 });
  applyImport(ctx, plan);
  expect(gridOfTab("Log").cell("A1").content).toBe("Title");
});

// Bug: an import had no cell limit, so a wide export froze the page while it wrote every cell.
test("tabs past the 200,000 cell limit for one import are refused", async () => {
  const { tabs } = await mountBook();
  const book = new ExcelJS.Workbook();
  for (const name of ["One", "Two"]) {
    const ws = book.addWorksheet(name);
    ws.getCell("A1").value = 1;
    ws.getCell("CV1500").value = 2;
  }
  const plan = await planOf(book, tabs.list());
  expect(plan.tabs.map((t) => t.name)).toEqual(["One"]);
  expect(plan.refused).toEqual([{ name: "Two", rows: 1500, cols: 100 }]);
});

// Bug: export left out Excel's _xlfn. prefix (Excel then shows #NAME? for XLOOKUP), or renamed a tab
// for Excel's name rules without the formulas that name it.
test("export writes newer functions and renamed tabs the way Excel reads them", async () => {
  const { ctx, tabs, gridOfTab } = await mountBook();
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Jan").getCell("A1").value = 5;
  book.addWorksheet("Sum").getCell("A1").value = 0;
  applyImport(ctx, await planOf(book, tabs.list()));
  tabs.list().find((t) => t.name === "Jan").table.closest("section").querySelector("h2").textContent = "Jan/Feb";
  gridOfTab("Sum").setRange("A1", [[{ content: { f: "='Jan/Feb'!A1+XLOOKUP(1,B1:B2,C1:C2)+SUM(A2:A3)" } }]], { detect: false });
  const out = await load(await bytesOf(buildWorkbook(ExcelJS, tabs.list(), ctx.gridOf, { tokenize: window.Sap.grid.tokenize })));
  expect(out.worksheets.map((s) => s.name)).toEqual(["Budget", "Jan Feb", "Sum"]);
  expect(out.getWorksheet("Sum").getCell("A1").value.formula).toBe("'Jan Feb'!A1+_xlfn.XLOOKUP(1,B1:B2,C1:C2)+SUM(A2:A3)");
  expect(out.getWorksheet("Sum").properties.defaultColWidth).toBeCloseTo(95 / 7, 5);
});

// Bug: a failed download of the Excel tools told the person their file was not a workbook.
test("a failed load of the Excel tools says so, not that the file is bad", async () => {
  const { ctx, notices } = await mountBook();
  await importXlsxFile(ctx, { name: "q3.xlsx", bytes: new Uint8Array([1]) }, { loadExcelJS: () => Promise.reject(new Error("offline")) });
  expect(notices.at(-1)).toBe("The Excel tools couldn't load. Check your connection and try again.");
});

// Bug: a 3D reference (Q1:Q4!B2), a name past Excel's last column (YTD2025) or a defined name that
// reads as columns (Tax:Cap) passed the check and computed a different number after import.
test("checkFormula flags 3D references and the file's defined names", async () => {
  await mountBook();
  const tokenize = window.Sap.grid.tokenize;
  const sheets = new Set(["q1", "q4"]);
  expect(checkFormula("=SUM(Q1:Q4!B2)", tokenize, sheets).unreadable).toBe(true);
  expect(checkFormula("=YTD2025*2", tokenize, sheets).unreadable).toBe(true);
  expect(checkFormula("=SUM(Tax:Cap)", tokenize, sheets, new Set(["tax", "cap"])).unreadable).toBe(true);
  expect(checkFormula("=SUM(Q1!B2:C3)+Q4!A1", tokenize, sheets).unreadable).toBe(false);
});

// Bug: a row dragged nearly shut or a freeze wider than the new tab stopped the whole import.
test("tiny rows and wide freezes import", async () => {
  const { ctx, tabs } = await mountBook();
  const book = new ExcelJS.Workbook();
  const ws = book.addWorksheet("Report");
  ws.getRow(4).height = 0.25;
  ws.getCell("A4").value = 1;
  ws.views = [{ state: "frozen", xSplit: 28 }];
  const plan = await planOf(book, tabs.list());
  applyImport(ctx, plan);
  expect(tabs.list().find((t) => t.name === "Report").table.getAttribute("freeze-cols")).toBe("28");
});

// Bug: a failed import removed its tabs with a plain delete, which cut formulas on existing tabs
// that the new tab's name had bound (=Data!A1*2 became =#REF!*2).
test("a failed import puts other tabs' formulas back as they were", async () => {
  const { ctx, tabs, gridOfTab } = await mountBook();
  gridOfTab("Budget").setRange("B1", [[{ content: { f: "=Data!A1*2" } }]], { detect: false });
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Data").getCell("A1").value = 4;
  book.addWorksheet("Second").getCell("A1").value = 2;
  const plan = await planOf(book, tabs.list());
  plan.tabs[1].merges = ["A1:B2", "B2:C3"];
  expect(() => applyImport(ctx, plan)).toThrow(expect.objectContaining({ name: "ImportStopped" }));
  expect(tabs.list().map((t) => t.name)).toEqual(["Budget"]);
  expect(gridOfTab("Budget").cell("B1").content).toEqual({ f: "=Data!A1*2" });
});

// Bug: a format set on a whole column was dropped on export, so dates came out as plain numbers.
test("export writes a column's format on its cells", async () => {
  const { ctx, tabs, gridOfTab } = await mountBook();
  const grid = gridOfTab("Budget");
  grid.format("A:A", { fmt: "yyyy-mm-dd" });
  expect(grid.cell("A1")).toMatchObject({ content: 7, fmt: null, effectiveFmt: "yyyy-mm-dd" });
  const out = await load(await bytesOf(buildWorkbook(ExcelJS, tabs.list(), ctx.gridOf, { fmtKind: window.Sap.grid.fmtKind, tokenize: window.Sap.grid.tokenize })));
  const cell = out.getWorksheet("Budget").getCell("A1");
  expect(cell.numFmt).toBe("yyyy-mm-dd");
  expect(serialOf(cell.value, cell.numFmt)).toBe(7);
});

// Bug: the dialog was tied to the open tab, so the function pack arriving (a recalculation there)
// closed it mid-read; or it opened while a cell was being edited.
test("the import dialog belongs to no tab and waits for an edit to finish", async () => {
  const { ctx, dialogs } = await mountBook();
  ctx.getSel = () => ({ tab: "s1" });
  const book = new ExcelJS.Workbook();
  book.addWorksheet("People").getCell("A1").value = "Ada";
  const bytes = await bytesOf(book);
  ctx.ensureReadyForAction = () => false;
  await importXlsxFile(ctx, { name: "people.xlsx", bytes }, { loadExcelJS: async () => ExcelJS });
  expect(dialogs).toEqual([]);
  ctx.ensureReadyForAction = () => true;
  await importXlsxFile(ctx, { name: "people.xlsx", bytes }, { loadExcelJS: async () => ExcelJS });
  expect(dialogs.map((d) => d.tab)).toEqual([""]);
});
