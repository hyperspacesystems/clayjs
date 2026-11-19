/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { tabTable } from "../../../src/sheet/commit.js";
import { createFindBar, findMatches, parseGoToRef } from "../../../src/sheet/find.js";
import { resolveTheme } from "../../../src/ui/theme.js";

const FIND_BOOK = `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="t"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td>Rent</td><td n v="40">40</td><td>rent due</td></tr>
<tr data-id="r2" data-pos="l"><td colspan="2">RENTAL</td><td hidden></td><td n f="=B1*2" v="80">80</td></tr>
</tbody></table></section>
<section item data-id="s2" data-pos="l"><h2 bind="name">Q1 Plan</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n f="=Budget!B1+5" v="45">45</td><td>Parent</td></tr>
</tbody></table></section></div></main>`;

async function mountFindBook() {
  jest.resetModules();
  delete window.Sap;
  delete window.sapPlugins;
  window.clay = { ready: new Promise(() => {}) };
  document.body.innerHTML = FIND_BOOK;
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const books = ownWorkbooks({});
  await books.ready;
  Sap.mount();
  const root = document.querySelector("[sheet-workbook]");
  const tabs = () => [
    { id: "s1", name: "Budget", grid: Sap.grid(tabTable(root, "s1")) },
    { id: "s2", name: "Q1 Plan", grid: Sap.grid(tabTable(root, "s2")) },
  ];
  return { Sap, root, tabs };
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

describe("sheet find and go-to", () => {
  // Bug: findMatches visited columns before rows, skipped other tabs, matched covered merge cells, or failed case-insensitive matching.
  test("findMatches searches every tab in tab order, then row then column, case-insensitively, skipping covered cells", async () => {
    const { tabs } = await mountFindBook();
    const hits = findMatches(tabs(), { query: "rent", searchFormulas: false });

    expect(hits.map((h) => `${h.tabName}!${h.ref}`)).toEqual([
      "Budget!A1",
      "Budget!C1",
      "Budget!A2",
      "Q1 Plan!B1",
    ]);
  });

  // Bug: Search formulas matched a formula cell's evaluated result instead of its formula text, or missed formulas when enabled.
  test("with searchFormulas enabled, formula cells match their formula text rather than their evaluated shown text", async () => {
    const { tabs } = await mountFindBook();

    expect(findMatches(tabs(), { query: "b1*", searchFormulas: false })).toEqual([]);
    expect(findMatches(tabs(), { query: "b1*", searchFormulas: true }).map((h) => `${h.tabName}!${h.ref}`)).toEqual([
      "Budget!C2",
    ]);
    // C2 evaluates to "80", so searching "80" in formula mode does not match C2's formula "=B1*2".
    expect(findMatches(tabs(), { query: "80", searchFormulas: false }).map((h) => h.ref)).toEqual(["C2"]);
    expect(findMatches(tabs(), { query: "80", searchFormulas: true })).toEqual([]);
  });

  // Bug: the find bar failed to step forward/backward with Enter and Shift+Enter, failed to rebuild its match list and count after a Grid change, or failed to return focus on Escape.
  test("createFindBar steps matches across tabs with Enter and Shift+Enter, rebuilds after a Grid change, and returns focus on Escape", async () => {
    const { Sap, root, tabs } = await mountFindBook();
    const container = document.createElement("div");
    const sheetFocus = document.createElement("textarea");
    document.body.append(container, sheetFocus);

    const selected = [];
    let activePos = { tab: "s1", r: 0, c: 0 };
    const bar = createFindBar({
      theme: resolveTheme(),
      container,
      getTabs: tabs,
      getActivePos: () => activePos,
      onSelectMatch: (m) => {
        activePos = { tab: m.tab, r: m.r, c: m.c };
        selected.push(`${m.tab}:${m.ref}`);
      },
      onClose: () => sheetFocus.focus(),
    });

    bar.open();
    bar.input.value = "rent";
    bar.input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(bar.countText.textContent).toBe("1 of 4");
    expect(selected.at(-1)).toBe("s1:A1");

    bar.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(bar.countText.textContent).toBe("2 of 4");
    expect(selected.at(-1)).toBe("s1:C1");

    bar.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    expect(bar.countText.textContent).toBe("1 of 4");
    expect(selected.at(-1)).toBe("s1:A1");

    // Mutate the Grid: add a 5th "rent" match in B1, then refresh() rebuilds the match list!
    Sap.grid(tabTable(root, "s1")).set("B1", "Rentals");
    bar.refresh();
    expect(bar.countText.textContent).toBe("1 of 5");
    expect(bar.matches.map((m) => `${m.tab}:${m.ref}`)).toEqual([
      "s1:A1",
      "s1:B1",
      "s1:C1",
      "s1:A2",
      "s2:B1",
    ]);

    bar.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(bar.isOpen).toBe(false);
    expect(document.activeElement).toBe(sheetFocus);
    bar.dispose();
  });

  // Bug: Enter on any find-bar control stepped to the next match instead of activating that control.
  test("Enter on the Close button closes the find bar instead of stepping to the next match", async () => {
    const { tabs } = await mountFindBook();
    const container = document.createElement("div");
    document.body.append(container);

    const bar = createFindBar({
      theme: resolveTheme(),
      container,
      getTabs: tabs,
      getActivePos: () => ({ tab: "s1", r: 0, c: 0 }),
      onSelectMatch: () => {},
      onClose: () => {},
    });

    bar.open();
    bar.input.value = "rent";
    bar.input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(bar.countText.textContent).toBe("1 of 4");

    const closeBtn = bar.el.querySelector("[data-find-close]");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    closeBtn.dispatchEvent(enter);

    // Enter is left to the button, so the browser's own activation runs and no step happens first.
    expect(enter.defaultPrevented).toBe(false);
    expect(bar.countText.textContent).toBe("1 of 4");
    expect(bar.isOpen).toBe(true);
    closeBtn.click();
    expect(bar.isOpen).toBe(false);
    bar.dispose();
  });

  // Bug: parseGoToRef rejected quoted tab names, reversed ranges or whole-axis refs, or accepted unknown tabs.
  test("parseGoToRef parses cell, range, quoted/unquoted tab and whole-axis references and rejects unknown tabs", () => {
    const tabs = [
      { id: "s1", name: "Budget" },
      { id: "s2", name: "Q1 Plan" },
    ];
    expect(parseGoToRef("B12", tabs, "s1")).toEqual({ tab: "s1", r0: 11, c0: 1, r1: 11, c1: 1, whole: null });
    expect(parseGoToRef("budget!B12", tabs, "s2")).toEqual({ tab: "s1", r0: 11, c0: 1, r1: 11, c1: 1, whole: null });
    expect(parseGoToRef("'Q1 Plan'!C4:A1", tabs, "s1")).toEqual({ tab: "s2", r0: 0, c0: 0, r1: 3, c1: 2, whole: null });
    expect(parseGoToRef("B:D", tabs, "s1")).toEqual({ tab: "s1", r0: 0, c0: 1, r1: null, c1: 3, whole: "cols" });
    expect(parseGoToRef("2:5", tabs, "s1")).toEqual({ tab: "s1", r0: 1, c0: 0, r1: 4, c1: null, whole: "rows" });
    expect(parseGoToRef("Missing!A1", tabs, "s1")).toBeNull();
    expect(parseGoToRef("not a ref", tabs, "s1")).toBeNull();
  });
});
