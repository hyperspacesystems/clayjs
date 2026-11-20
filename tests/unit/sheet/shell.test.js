import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { EARLY } from "../../../src/sheet/row-window.js";
import { startShell } from "../../../src/sheet/shell.js";

const fakeSheet = () => ({ text: "", replaceSync(text) { this.text = text; } });
const windowOptions = () => ({ sheet: fakeSheet(), adopt: () => {}, drop: () => {}, schedule: (fn) => fn() });

// A Grid stand-in: it records every listener a table gets, since a sheet table now has both
// its row window and its rules following its changes.
const fakeGrid = (listeners) => (table) => ({
  on: (type, fn) => {
    if (!listeners.has(table)) listeners.set(table, []);
    const entry = { type, fn };
    listeners.get(table).push(entry);
    return () => {
      const rest = (listeners.get(table) ?? []).filter((each) => each !== entry);
      if (rest.length > 0) listeners.set(table, rest);
      else listeners.delete(table);
    };
  },
});

const tab = (id) => `<section item data-id="${id}" data-pos="V"><h2 bind="name">${id}</h2><table grid><colgroup><col></colgroup><tbody><tr data-id="${id}r1"></tr></tbody></table></section>`;

describe("the sheet shell", () => {
  let adopted;

  beforeEach(() => {
    adopted = [];
    Object.defineProperty(document, "adoptedStyleSheets", { configurable: true, get: () => adopted, set: (list) => { adopted = list; } });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    window.Sap?.unmount?.();
    delete window.CSSStyleSheet;
    delete document.adoptedStyleSheets;
    delete window[EARLY];
    delete window.requestIdleCallback;
    delete window.cancelIdleCallback;
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
    window.Sap = { grid: fakeGrid(listeners) };
    window.clay = { ready: Promise.resolve() };

    const { windows, followed } = startShell({ windowOptions: windowOptions() });
    const [table, win] = [...windows][0];
    const booted = win.geometry;
    await followed;

    // The mount has painted, so the window reads its table again once.
    expect(win.geometry).not.toBe(booted);
    const entries = listeners.get(table);
    expect(entries.map((each) => each.type)).toEqual(["change", "change"]);
    expect(entries.map((each) => each.fn)).toContain(win.follow);
    const before = win.geometry;
    table.insertAdjacentHTML("beforeend", '<tbody><tr data-id="new"></tr></tbody>');
    for (const { fn } of entries) fn({ structure: true, rows: { added: ["new"], removed: [], changed: [] }, cells: [] });
    expect(win.geometry).not.toBe(before);
    expect(win.geometry.rowCount).toBe(2);
  });

  test("restart puts a window on a table that replaced the old one and keeps the window of a table that stayed", async () => {
    document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>${tab("s1")}${tab("s2")}</div></main>`;
    const listeners = new Map();
    window.Sap = { grid: fakeGrid(listeners) };
    window.clay = { ready: Promise.resolve() };

    let drops = 0;
    const { windows, followed, restart } = startShell({ windowOptions: { ...windowOptions(), drop: () => { drops += 1; } } });
    await followed;
    const stayed = document.querySelector('section[data-id="s1"] table[grid]');
    const gone = document.querySelector('section[data-id="s2"] table[grid]');
    const kept = windows.get(stayed);

    const fresh = document.createElement("table");
    fresh.setAttribute("grid", "");
    fresh.innerHTML = '<tbody><tr data-id="s2r1"></tr></tbody>';
    gone.replaceWith(fresh);

    // A rebuild makes new Grids: nothing listens to them until restart subscribes.
    listeners.clear();
    restart();

    expect([...windows.keys()]).toEqual([stayed, fresh]);
    expect(windows.get(stayed)).toBe(kept);
    expect(windows.get(fresh).table).toBe(fresh);
    expect(listeners.get(fresh).map((each) => each.fn)).toContain(windows.get(fresh).follow);
    expect(listeners.has(gone)).toBe(false);
    expect(listeners.get(stayed).map((each) => each.fn)).toContain(kept.follow);
    expect(drops).toBe(1);
  });

  test("a grid that arrives after the mount is still followed", async () => {
    document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>${tab("s1")}</div></main>`;
    const listeners = new Map();
    const grid = fakeGrid(listeners);
    window.Sap = { plugins: { load: async (name) => { if (name === "grid") window.Sap.grid = grid; } } };
    window.clay = { ready: Promise.resolve() };

    const { windows, followed } = startShell({ windowOptions: windowOptions() });
    await followed;

    const [table, win] = [...windows][0];
    expect(listeners.get(table).map((each) => each.fn)).toContain(win.follow);
  });

  // Bug: shell loaded grid-functions eagerly at open instead of waiting 3 s plus requestIdleCallback({ timeout: 5000 }), forgot to cancel on dispose, or failed to catch a rejected load.
  test("schedules grid-functions after a 3 s timer and requestIdleCallback({ timeout: 5000 }), cancels on dispose, and logs errors cleanly", async () => {
    jest.useFakeTimers();
    document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>${tab("s1")}</div></main>`;

    const idleQueue = [];
    window.requestIdleCallback = jest.fn((cb, opts) => {
      const id = idleQueue.length + 1;
      idleQueue.push({ id, cb, opts, cancelled: false });
      return id;
    });
    window.cancelIdleCallback = jest.fn((id) => {
      const entry = idleQueue.find((it) => it.id === id);
      if (entry) entry.cancelled = true;
    });

    const loadCalls = [];
    window.Sap = {
      grid: () => ({ on: () => () => {} }),
      plugins: {
        has: () => false,
        load: jest.fn((name) => {
          loadCalls.push(name);
          return Promise.resolve();
        }),
      },
    };
    window.clay = { ready: Promise.resolve() };

    const shell = startShell({ windowOptions: windowOptions() });
    await shell.followed;

    jest.advanceTimersByTime(2999);
    expect(window.requestIdleCallback).not.toHaveBeenCalled();
    expect(loadCalls).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(window.requestIdleCallback).toHaveBeenCalledTimes(1);
    expect(idleQueue[0].opts).toEqual({ timeout: 5000 });
    expect(loadCalls).toEqual([]);

    idleQueue[0].cb();
    expect(loadCalls).toEqual(["grid-functions"]);
    shell.dispose();

    // Dispose before the idle callback runs cancels both pending 3s timer and pending idle callback.
    loadCalls.length = 0;
    const shellEarly = startShell({ windowOptions: windowOptions() });
    await shellEarly.followed;
    jest.advanceTimersByTime(1500);
    shellEarly.dispose();
    jest.advanceTimersByTime(5000);
    expect(loadCalls).toEqual([]);

    const shellIdle = startShell({ windowOptions: windowOptions() });
    await shellIdle.followed;
    jest.advanceTimersByTime(3000);
    expect(idleQueue).toHaveLength(2);
    shellIdle.dispose();
    expect(window.cancelIdleCallback).toHaveBeenCalledWith(idleQueue[1].id);

    // Without requestIdleCallback, plain setTimeout loads after 3 s and logs any failure via console.error.
    delete window.requestIdleCallback;
    delete window.cancelIdleCallback;
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    window.Sap.plugins.load = jest.fn(() => Promise.reject(new Error("network down")));
    const shellFallback = startShell({ windowOptions: windowOptions() });
    await shellFallback.followed;
    jest.advanceTimersByTime(3000);
    await Promise.resolve();
    await Promise.resolve();
    expect(window.Sap.plugins.load).toHaveBeenCalledWith("grid-functions");
    expect(errSpy).toHaveBeenCalled();
    shellFallback.dispose();
  });

  // Bug: opening a sheet with =STDEV(B2:B4) wiped its saved value before grid-functions arrived, or recomputing after the idle load marked the workbook unsaved.
  test("a saved =STDEV(B2:B4) cell keeps its saved value at open, computes once grid-functions loads on idle, and never moves book.revision or grid.revision", async () => {
    jest.resetModules();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>
      <section item data-id="s1" data-pos="V"><h2 bind="name">Stats</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
      <tbody>
        <tr data-id="r1" data-pos="V"><td n f="=STDEV(B2:B4)" v="1">1</td><td n></td></tr>
        <tr data-id="r2" data-pos="l"><td n></td><td n v="2">2</td></tr>
        <tr data-id="r3" data-pos="t"><td n></td><td n v="4">4</td></tr>
        <tr data-id="r4" data-pos="x"><td n></td><td n v="6">6</td></tr>
      </tbody></table></section>
      <script type="application/json" sheet-commit>{"rev":1}</script>
    </div></main>`;

    let idleFn = null;
    window.requestIdleCallback = (cb) => {
      idleFn = cb;
      return 1;
    };
    window.clay = { ready: Promise.resolve() };
    window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;

    const derive = await import("../../../src/plugins/derive.js");
    await derive.ready;
    const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
    const books = ownWorkbooks({});
    await books.ready;
    window.Sap.mount();

    jest.useFakeTimers();
    const { startShell: freshShell } = await import("../../../src/sheet/shell.js");
    const shell = freshShell({ windowOptions: windowOptions() });
    await shell.followed;

    const root = document.querySelector("[sheet-workbook]");
    const book = books.books.get(root);
    const grid = window.Sap.grid(root.querySelector("table[grid]"));

    expect(window.Sap.plugins.has("grid-functions")).toBe(false);
    expect(grid.cell("A1").text).toBe("1");
    expect(grid.get("A1")).toBe(1);
    expect(grid.revision).toBe(0);
    expect(book.revision).toBe(0);

    jest.advanceTimersByTime(3000);
    expect(typeof idleFn).toBe("function");
    jest.useRealTimers();
    idleFn();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(window.Sap.plugins.has("grid-functions")).toBe(true);
    expect(grid.get("A1")).toBe(2);
    expect(grid.cell("A1").text).toBe("2");
    expect(grid.revision).toBe(0);
    expect(book.revision).toBe(0);

    shell.dispose();
  });

  // Bug: shell loaded grid-formats on built-in codes ($#,##0.00), or failed to load grid-formats on an unknown code at open or after a Grid change.
  test("loads grid-formats once when the workbook holds an unknown fmt at open or gains one on a Grid change, and never loads it for built-in formats", async () => {
    jest.resetModules();
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});

    // 1. Built-in format at open: grid-formats is NOT loaded; formatting a cell with an unknown code triggers it once.
    document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>
      <section item data-id="s1" data-pos="V"><h2 bind="name">Weights</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
      <tbody>
        <tr data-id="r1" data-pos="V"><td n v="12.5" fmt="$#,##0.00">$12.50</td><td n v="7.5">7.5</td></tr>
      </tbody></table></section>
      <script type="application/json" sheet-commit>{"rev":1}</script>
    </div></main>`;
    window.clay = { ready: Promise.resolve() };
    window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;

    const derive = await import("../../../src/plugins/derive.js");
    await derive.ready;
    const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
    const books = ownWorkbooks({});
    await books.ready;
    window.Sap.mount();

    const loadSpy = jest.spyOn(window.Sap.plugins, "load");
    const { startShell: freshShell } = await import("../../../src/sheet/shell.js");
    const shell = freshShell({ windowOptions: windowOptions() });
    await shell.followed;

    expect(loadSpy).not.toHaveBeenCalledWith("grid-formats");
    expect(window.Sap.plugins.has("grid-formats")).toBe(false);

    const grid = window.Sap.grid(document.querySelector("table[grid]"));
    grid.format("B1", { fmt: '0.00 "kg"' });
    expect(loadSpy).toHaveBeenCalledWith("grid-formats");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(window.Sap.plugins.has("grid-formats")).toBe(true);
    expect(grid.cell("B1").text).toBe("7.50 kg");
    shell.dispose();

    // 2. Unknown format already in the workbook at open (stale table): one querySelectorAll scan loads grid-formats and draws the cell without moving book.revision.
    window.Sap.unmount();
    delete window.Sap;
    delete window.sapPlugins;
    jest.resetModules();
    document.body.innerHTML = `<main sap plugins="grid"><div items="sheets" sheet-workbook>
      <section item data-id="s1" data-pos="V"><h2 bind="name">Weights</h2><table grid stale><colgroup><col data-id="c1" data-pos="V"></colgroup>
      <tbody>
        <tr data-id="r1" data-pos="V"><td n fmt='0.00 "kg"'>12.5</td></tr>
      </tbody></table></section>
      <script type="application/json" sheet-commit>{"rev":1}</script>
    </div></main>`;
    window.clay = { ready: Promise.resolve() };
    window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;

    const derive2 = await import("../../../src/plugins/derive.js");
    await derive2.ready;
    const { ownWorkbooks: own2 } = await import("../../../src/sheet/workbook.js");
    const books2 = own2({});
    await books2.ready;
    window.Sap.mount();

    const qsaSpy = jest.spyOn(document, "querySelectorAll");
    const { startShell: freshShell2 } = await import("../../../src/sheet/shell.js");
    const shell2 = freshShell2({ windowOptions: windowOptions() });
    await shell2.followed;

    const fmtScans = qsaSpy.mock.calls.filter(([sel]) => String(sel).includes("[fmt]"));
    expect(fmtScans).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 20));
    const root2 = document.querySelector("[sheet-workbook]");
    const grid2 = window.Sap.grid(root2.querySelector("table[grid]"));
    expect(window.Sap.plugins.has("grid-formats")).toBe(true);
    expect(grid2.cell("A1").text).toBe("12.50 kg");
    expect(grid2.revision).toBe(0);
    expect(books2.books.get(root2).revision).toBe(0);
    shell2.dispose();
  });
});
