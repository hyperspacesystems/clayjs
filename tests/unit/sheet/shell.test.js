import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { EARLY } from "../../../src/sheet/row-window.js";
import { startShell } from "../../../src/sheet/shell.js";

const fakeSheet = () => ({ text: "", replaceSync(text) { this.text = text; } });
const windowOptions = () => ({ sheet: fakeSheet(), adopt: () => {}, drop: () => {}, schedule: (fn) => fn() });

const tab = (id) => `<section item data-id="${id}" data-pos="V"><h2 bind="name">${id}</h2><table grid><colgroup><col></colgroup><tbody><tr data-id="${id}r1"></tr></tbody></table></section>`;

describe("the sheet shell", () => {
  let adopted;

  beforeEach(() => {
    adopted = [];
    Object.defineProperty(document, "adoptedStyleSheets", { configurable: true, get: () => adopted, set: (list) => { adopted = list; } });
  });

  afterEach(() => {
    delete window.CSSStyleSheet;
    delete document.adoptedStyleSheets;
    delete window[EARLY];
    delete window.clay;
    delete window.Sap;
    document.body.innerHTML = "";
  });

  test("every tab adopts its own rule, and the page's early rule comes off once they all have one", () => {
    document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>${tab("s1")}${tab("s2")}</div></main>`;
    window.CSSStyleSheet = class { replaceSync(text) { this.text = text; } };
    const early = fakeSheet();
    adopted = [early];
    window[EARLY] = early;

    const { windows } = startShell({ windowOptions: { schedule: (fn) => fn() } });

    expect([...windows.keys()]).toEqual([...document.querySelectorAll("table")]);
    expect(adopted).toHaveLength(2);
    expect(adopted[0].text).toContain('section[data-id="s1"]>table[grid]');
    expect(adopted[1].text).toContain('section[data-id="s2"]>table[grid]');
    expect(window[EARLY]).toBeUndefined();
  });

  test("two bare tables get no window, since one rule would hide the other's rows", () => {
    document.body.innerHTML = `<main sap plugins="grid"><table grid><tbody><tr data-id="a"></tr></tbody></table><table grid><tbody><tr data-id="b"></tr></tbody></table></main>`;
    expect(startShell({ windowOptions: windowOptions() }).windows.size).toBe(0);
  });

  test("once the engine has mounted, each window follows its table's Grid", async () => {
    document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>${tab("s1")}</div></main>`;
    const listeners = new Map();
    window.Sap = { grid: (table) => ({ on: (type, fn) => listeners.set(table, { type, fn }) }) };
    window.clay = { ready: Promise.resolve() };

    const { windows, followed } = startShell({ windowOptions: windowOptions() });
    const [table, win] = [...windows][0];
    const booted = win.geometry;
    await followed;

    // The mount has painted, so the window reads its table again once.
    expect(win.geometry).not.toBe(booted);
    expect(listeners.get(table).type).toBe("change");
    const before = win.geometry;
    table.insertAdjacentHTML("beforeend", '<tbody><tr data-id="new"></tr></tbody>');
    listeners.get(table).fn({ structure: true, rows: { added: ["new"], removed: [], changed: [] }, cells: [] });
    expect(win.geometry).not.toBe(before);
    expect(win.geometry.rowCount).toBe(2);
  });

  test("a grid that arrives after the mount is still followed", async () => {
    document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>${tab("s1")}</div></main>`;
    const listeners = new Map();
    const grid = (table) => ({ on: (type, fn) => listeners.set(table, fn) });
    window.Sap = { plugins: { load: async (name) => { if (name === "grid") window.Sap.grid = grid; } } };
    window.clay = { ready: Promise.resolve() };

    const { windows, followed } = startShell({ windowOptions: windowOptions() });
    await followed;

    const [table, win] = [...windows][0];
    expect(listeners.get(table)).toBe(win.follow);
  });
});
