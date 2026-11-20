/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { tabTable } from "../../../src/sheet/commit.js";
import { createFindBar, findMatches, isValidFormula, parseGoToRef } from "../../../src/sheet/find.js";
import { createHistory } from "../../../src/sheet/history.js";
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

    // Bug: Find selected a different cell than the match, because rows out of sight stayed in the list.
    const [budget] = tabs();
    const hidden = findMatches([{ ...budget, rowHidden: (r) => r === 1 }], { query: "rent", searchFormulas: false });
    expect(hidden.map((h) => h.ref)).toEqual(["A1", "C1"]);
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

  // Bug: the replace check read a row range as a column range, so Replace all wrote =SUM(A1:$2)
  // (sapjs's #ERROR!) over a working formula and refused the valid open-ended =AVERAGE(A1:A).
  test("isValidFormula agrees with sapjs's own parser on ranges", async () => {
    const { Sap, root } = await mountFindBook();
    const s1 = Sap.grid(tabTable(root, "s1"));
    const cases = ["=SUM(A1:$2)", "=AVERAGE(A1:A)", "=SUM(A:A1)", "=SUM(2:3)", "=SUM(A:B)", "=SUM(A1:B2)", "=SUM(1:B)", "=A1+"];
    for (const f of cases) {
      s1.set("C1", f);
      const sapjsAccepts = s1.cell("C1").text !== "#ERROR!";
      expect([f, isValidFormula(f, Sap.grid.tokenize)]).toEqual([f, sapjsAccepts]);
    }
  });

  // Bug: every cell Replace all wrote announced a change that made the open bar search every tab
  // again, so a large Replace all froze the tab; it must search once, after the writes.
  test("Replace all searches the tabs again once, not once per replaced cell", async () => {
    const { Sap, root, tabs } = await mountFindBook();
    const s1 = Sap.grid(tabTable(root, "s1"));
    const container = document.createElement("div");
    document.body.append(container);
    let searches = 0;
    const bar = createFindBar({
      theme: resolveTheme(),
      container,
      getTabs: () => (searches++, tabs()),
      getActiveTab: () => "s1",
      getActivePos: () => ({ tab: "s1", r: 0, c: 0 }),
      getTokenize: () => Sap.grid.tokenize,
      onSelectMatch: () => {},
      onNotice: () => {},
      onClose: () => {},
    });
    s1.on("change", () => bar.refresh());
    bar.open({ replace: true });
    bar.input.value = "rent";
    bar.input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(bar.replaceAllBtn.textContent).toBe("Replace all (3)");
    bar.replaceInput.value = "fee";
    searches = 0;
    bar.replaceAllBtn.click();
    expect(s1.get("C1")).toBe("fee due");
    expect(searches).toBeLessThanOrEqual(2);
    bar.dispose();
  });

  // Bug: Replace all modified matches on inactive tabs, recorded multiple undo steps, wrote numeric replacements as strings, or failed to show the active tab's match count.
  test("Replace steps to the next match and Replace all edits typed text on the active tab only in one undo step, turning numeric text into numbers", async () => {
    const { Sap, root, tabs } = await mountFindBook();
    const s1 = Sap.grid(tabTable(root, "s1"));
    const s2 = Sap.grid(tabTable(root, "s2"));
    const history = createHistory(root, (t) => Sap.grid(t));
    s1.on("change", (ev) => history.record("s1", ev));
    s2.on("change", (ev) => history.record("s2", ev));

    const container = document.createElement("div");
    document.body.append(container);
    let activeTab = "s1";
    let activePos = { tab: "s1", r: 0, c: 0 };
    const notices = [];
    const selected = [];

    const bar = createFindBar({
      theme: resolveTheme(),
      container,
      getTabs: tabs,
      getActiveTab: () => activeTab,
      getActivePos: () => activePos,
      history,
      getTokenize: () => Sap.grid.tokenize,
      onSelectMatch: (m) => {
        activeTab = m.tab;
        activePos = { tab: m.tab, r: m.r, c: m.c };
        selected.push(`${m.tab}:${m.ref}`);
      },
      onNotice: (msg) => notices.push(msg),
      onClose: () => {},
    });

    // open() hides replaceRow; open({ replace: true }) shows it.
    bar.open();
    expect(bar.replaceRow.hidden).toBe(true);
    // Ctrl+H typed inside the bar shows the replace row instead of the browser's history.
    const ctrlH = new KeyboardEvent("keydown", { key: "h", ctrlKey: true, bubbles: true, cancelable: true });
    bar.input.dispatchEvent(ctrlH);
    expect(ctrlH.defaultPrevented).toBe(true);
    expect(bar.replaceRow.hidden).toBe(false);
    bar.open();
    expect(bar.replaceRow.hidden).toBe(true);
    bar.open({ replace: true });
    expect(bar.replaceRow.hidden).toBe(false);

    // "rent" matches 3 cells on s1 (A1="Rent", C1="rent due", A2="RENTAL") and 1 on s2 (B1="Parent").
    bar.input.value = "rent";
    bar.input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(bar.countText.textContent).toBe("1 of 4");
    expect(bar.replaceAllBtn.textContent).toBe("Replace all (3)");

    // Single Replace on A1 ("Rent" -> "10") writes typed input so "10" becomes number 10 and moves to next match C1.
    bar.replaceInput.value = "10";
    bar.replaceBtn.click();
    expect(s1.get("A1")).toBe(10);
    expect(typeof s1.get("A1")).toBe("number");
    expect(selected.at(-1)).toBe("s1:C1");
    expect(bar.replaceAllBtn.textContent).toBe("Replace all (2)");

    // Replacing inside a formatted/plain number keeps it a number ("40" -> "90").
    activePos = { tab: "s1", r: 0, c: 0 };
    bar.input.value = "4";
    bar.input.dispatchEvent(new Event("input", { bubbles: true }));
    bar.replaceInput.value = "9";
    bar.replaceBtn.click();
    expect(s1.get("B1")).toBe(90);
    expect(typeof s1.get("B1")).toBe("number");

    // Replace all on s1 for "rent" -> "lease" replaces C1 and A2 on s1 in ONE undo step and leaves s2!B1 ("Parent") untouched.
    activeTab = "s1";
    activePos = { tab: "s1", r: 0, c: 0 };
    bar.input.value = "rent";
    bar.input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(bar.replaceAllBtn.textContent).toBe("Replace all (2)");
    bar.replaceInput.value = "lease";
    bar.replaceAllBtn.click();

    expect(s1.get("C1")).toBe("lease due");
    expect(s1.get("A2")).toBe("leaseAL");
    expect(s1.cell("B2").covered).toBe(true);
    expect(s2.get("B1")).toBe("Parent");
    expect(notices.at(-1)).toBe("Replaced 2 cells.");

    // One undo step restores BOTH C1 and A2 on s1.
    expect(history.undo("s1").ok).toBe(true);
    expect(s1.get("C1")).toBe("rent due");
    expect(s1.get("A2")).toBe("RENTAL");

    // The person clicks back to s1 while the current match is on s2: Replace shows s2 before
    // writing, so Ctrl+Z (the shown tab's undo) undoes this replace.
    bar.input.value = "parent";
    bar.input.dispatchEvent(new Event("input", { bubbles: true }));
    activeTab = "s1";
    let shownAtWrite = null;
    const off = s2.on("change", () => (shownAtWrite ??= activeTab));
    bar.replaceInput.value = "Child";
    bar.replaceBtn.click();
    off();
    expect(s2.get("B1")).toBe("Child");
    expect(shownAtWrite).toBe("s2");

    bar.dispose();
  });

  // Bug: Replace modified a formula cell's shown value when Search formulas was off, or overwrote a formula with invalid syntax instead of skipping and counting it.
  test("formula cells are replaced only when Search formulas is checked, and invalid formulas are left alone and counted in the notice", async () => {
    const { Sap, root, tabs } = await mountFindBook();
    const s1 = Sap.grid(tabTable(root, "s1"));
    s1.set("A1", "=B1+80");
    // B1=40 => A1 evaluates to 120, C2 has formula "=B1*2" which evaluates to 80.
    expect(s1.cell("C2").text).toBe("80");

    const container = document.createElement("div");
    document.body.append(container);
    const notices = [];
    const bar = createFindBar({
      theme: resolveTheme(),
      container,
      getTabs: tabs,
      getActiveTab: () => "s1",
      getActivePos: () => ({ tab: "s1", r: 0, c: 0 }),
      getTokenize: () => Sap.grid.tokenize,
      onSelectMatch: () => {},
      onNotice: (msg) => notices.push(msg),
      onClose: () => {},
    });

    // With Search formulas unchecked, "80" matches C2's shown text ("80"), NOT A1's formula, and Replace all skips formula cell C2.
    bar.open({ replace: true });
    bar.input.value = "80";
    bar.input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(bar.matches.map((m) => m.ref)).toEqual(["C2"]);
    bar.replaceInput.value = "99";
    // A formula's result is not counted as something Replace all can change.
    expect(bar.replaceAllBtn.textContent).toBe("Replace all");
    expect(bar.replaceAllBtn.getAttribute("aria-disabled")).toBe("true");
    bar.replaceBtn.click();
    expect(s1.input("C2")).toBe("=B1*2");
    expect(s1.get("C2")).toBe(80);
    expect(notices.at(-1)).toBe("That match is a formula's result. Turn on Search formulas to change the formula.");

    // Turn Search formulas ON: replacing "B1" with "(" breaks "=B1+80" -> "=(+80" (unclosed paren), while replacing "+80" in A1 or valid ref works.
    // Put a plain text cell C1="B1 note" alongside formulas A1="=B1+80" and C2="=B1*2".
    s1.set("C1", "B1 note");
    bar.formulaCheck.checked = true;
    bar.formulaCheck.dispatchEvent(new Event("change", { bubbles: true }));

    // Replace "B1" with "B1+" -> C1 becomes "B1+ note" (valid text), while A1 ("=B1++80" -> unary + is valid? Wait: use "B1*" so "=B1**2" and "=B1*+80": wait, "B1)" makes "=B1)+80" and "=B1)*2", both invalid unmatched ')'!).
    bar.input.value = "B1";
    bar.input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(bar.replaceAllBtn.textContent).toBe("Replace all (3)");
    bar.replaceInput.value = "B1)";
    bar.replaceAllBtn.click();

    expect(s1.get("C1")).toBe("B1) note");
    expect(s1.input("A1")).toBe("=B1+80");
    expect(s1.input("C2")).toBe("=B1*2");
    expect(notices.at(-1)).toBe("Replaced 1 cell. 2 formulas would not be valid and were left alone.");

    // Valid formula replacement with Search formulas ON updates both formula cells.
    bar.input.value = "B1";
    bar.input.dispatchEvent(new Event("input", { bubbles: true }));
    bar.replaceInput.value = "20";
    bar.replaceAllBtn.click();
    expect(s1.input("A1")).toBe("=20+80");
    expect(s1.get("A1")).toBe(100);
    expect(s1.input("C2")).toBe("=20*2");
    expect(s1.get("C2")).toBe(40);

    bar.dispose();
  });
});
