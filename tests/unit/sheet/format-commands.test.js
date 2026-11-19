/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { a1, colIndex, rowIndex, tabTable } from "../../../src/sheet/commit.js";
import {
  applyAlign,
  applyBorder,
  applyClearFormatting,
  applyDecimals,
  applyFillColor,
  applyNumberFormat,
  applyStyleToggle,
  applyTextColor,
  cellStyleState,
  formatLabelOf,
  inspectMerge,
  numberFormatMenuItems,
  openCustomFormatDialog,
  runMergeCommand,
} from "../../../src/sheet/format-commands.js";
import { createHistory } from "../../../src/sheet/history.js";
import { openMergeKeepDialog } from "../../../src/sheet/menu.js";
import { createSelection, moveSelection, selectCell, selectCols } from "../../../src/sheet/selection.js";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

const BOOK = () => `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="t"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="12.5">12.5</td><td n v="0.25">0.25</td><td n v="3.4">3.4</td></tr>
<tr data-id="r2" data-pos="l"><td>alpha</td><td>beta</td><td>gamma</td></tr>
<tr data-id="r3" data-pos="t"><td></td><td></td><td></td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit>{"rev":1}</script>
</div></main>`;

const FROZEN_BOOK = () => `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<thead><tr data-id="r1" data-pos="V"><td>Name</td><td>Amount</td></tr></thead>
<tbody>
<tr data-id="r2" data-pos="l"><td>Alice</td><td n v="5">5</td></tr>
<tr data-id="r3" data-pos="t"><td>Bob</td><td n v="6">6</td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit">{"rev":1}</script>
</div></main>`;

async function setup(body = BOOK()) {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.Sap;
  delete window.sapPlugins;
  delete window.clayEditMode;
  window.clay = { ready: new Promise(() => {}) };
  document.head.innerHTML = "";
  document.body.innerHTML = body;

  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const books = ownWorkbooks({});
  await books.ready;
  Sap.mount();
  await turn();

  const root = document.querySelector("[sheet-workbook]");
  const table = tabTable(root, "s1");
  const grid = Sap.grid(table);
  const history = createHistory(root, (t) => Sap.grid(t));
  grid.on("change", (ev) => history.record("s1", ev));

  const view = () => {
    const t = tabTable(root, "s1");
    const rows = [...t.querySelectorAll("tr")].map((tr) => tr.getAttribute("data-id"));
    const cols = [...t.querySelectorAll("col")].map((col) => col.getAttribute("data-id"));
    return {
      rows,
      cols,
      rowHidden: () => false,
      colHidden: () => false,
      cell: (r, c) => Sap.grid(t).cell(a1(r, c)),
    };
  };

  return { Sap, root, table, grid, history, view, rowIndex, colIndex };
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

// Bug: style toggles checked every cell instead of the active cell, or underline and strikethrough overwrote each other instead of combining as "underline line-through".
test("style toggles follow the active cell's state across a selection, combine underline and strikethrough, and undo cleanly", async () => {
  const { grid, history, view } = await setup();
  grid.format("B1", { style: { "font-weight": "bold" } });
  history.undo("s1");
  grid.format("B1", { style: { "font-weight": "bold" } });

  // Select A1:B2 with active cell A1 (not bold, while B1 is bold).
  let sel = createSelection(view(), "s1");
  sel = moveSelection(view(), sel, { dr: 1, dc: 1, extend: true });

  // Active cell A1 is not bold -> sets bold on whole selection A1:B2.
  applyStyleToggle(grid, view(), sel, history, "bold");
  expect(cellStyleState(grid.cell("A1")).bold).toBe(true);
  expect(cellStyleState(grid.cell("B1")).bold).toBe(true);
  expect(cellStyleState(grid.cell("B2")).bold).toBe(true);

  // Active cell A1 is now bold -> removes bold from whole selection A1:B2.
  applyStyleToggle(grid, view(), sel, history, "bold");
  expect(cellStyleState(grid.cell("A1")).bold).toBe(false);
  expect(cellStyleState(grid.cell("B1")).bold).toBe(false);
  expect(cellStyleState(grid.cell("B2")).bold).toBe(false);

  // Undo restores bold on A1:B2.
  expect(history.undo("s1").ok).toBe(true);
  expect(cellStyleState(grid.cell("A1")).bold).toBe(true);
  expect(cellStyleState(grid.cell("B2")).bold).toBe(true);

  // Combine underline and strikethrough on A2:B2 where B2 already has line-through.
  let lineSel = selectCell(view(), sel, 1, 0);
  applyStyleToggle(grid, view(), selectCell(view(), sel, 1, 1), history, "strikethrough");
  lineSel = moveSelection(view(), lineSel, { dr: 0, dc: 1, extend: true });

  applyStyleToggle(grid, view(), lineSel, history, "underline");
  expect(grid.cell("A2").style).toContain("text-decoration:underline");
  expect(grid.cell("B2").style).toContain("text-decoration:underline line-through");

  // Toggle underline off from active cell A2: A2 loses decoration, B2 keeps line-through.
  applyStyleToggle(grid, view(), lineSel, history, "underline");
  expect(cellStyleState(grid.cell("A2")).underline).toBe(false);
  expect(cellStyleState(grid.cell("B2")).underline).toBe(false);
  expect(cellStyleState(grid.cell("B2")).strikethrough).toBe(true);

  // Active cell bold while another selected cell is not: the toggle removes bold from both.
  grid.format("B2", { style: { "font-weight": null } });
  const mixed = moveSelection(view(), selectCell(view(), sel, 0, 0), { dr: 1, dc: 1, extend: true });
  applyStyleToggle(grid, view(), mixed, history, "bold");
  expect(cellStyleState(grid.cell("A1")).bold).toBe(false);
  expect(cellStyleState(grid.cell("B1")).bold).toBe(false);
  expect(cellStyleState(grid.cell("B2")).bold).toBe(false);

  // Italic and wrap toggles set and clear their properties.
  const single = selectCell(view(), sel, 0, 0);
  applyStyleToggle(grid, view(), single, history, "italic");
  applyStyleToggle(grid, view(), single, history, "wrap");
  expect(cellStyleState(grid.cell("A1")).italic).toBe(true);
  expect(cellStyleState(grid.cell("A1")).wrap).toBe(true);
  applyStyleToggle(grid, view(), single, history, "wrap");
  expect(cellStyleState(grid.cell("A1")).wrap).toBe(false);
});

// Bug: align, color, border, whole-column number format or clear-formatting sent a shape sapjs refused or left old styles behind.
test("align, colors with Reset, borders, number formats on cells and whole columns, and clear formatting each apply and undo", async () => {
  const { Sap, table, grid, history, view } = await setup();
  const selA1 = createSelection(view(), "s1");

  applyAlign(grid, view(), selA1, "center");
  applyTextColor(grid, view(), selA1, "#8F6310");
  applyFillColor(grid, view(), selA1, "#F0E4CC");
  applyBorder(grid, view(), selA1, "outer");
  applyNumberFormat(grid, view(), selA1, "$#,##0.00");

  expect(cellStyleState(grid.cell("A1"))).toMatchObject({
    align: "center",
    color: "#8f6310",
    fillColor: "#f0e4cc",
    formatLabel: "Currency",
  });
  expect(grid.cell("A1").text).toBe("$12.50");
  expect(grid.cell("A1").style).toContain("1px solid #5F6368");

  // Menu items show samples in Sap.grid.formatValue and label unknown formats as Custom.
  const items = numberFormatMenuItems({
    activeValue: 12.5,
    activeFmt: "$#,##0.00",
    formatValue: Sap.grid.formatValue,
    onPick: () => {},
  });
  expect(items.find((it) => it.id === "currency")).toMatchObject({ checked: true, detail: "$12.50" });
  expect(items.find((it) => it.id === "percent")?.detail).toBe("1250.00%");
  expect(formatLabelOf("0.000")).toBe("Custom");

  // Reset colors removes color and background-color; Undo restores fill color.
  applyFillColor(grid, view(), selA1, null);
  expect(cellStyleState(grid.cell("A1")).fillColor).toBeNull();
  expect(history.undo("s1").ok).toBe(true);
  expect(cellStyleState(grid.cell("A1")).fillColor).toBe("#f0e4cc");

  // Clear formatting removes fmt, style and borders in one undoable step.
  applyClearFormatting(grid, view(), selA1, history);
  expect(grid.cell("A1").fmt).toBeNull();
  expect(grid.cell("A1").style).toBeNull();
  expect(grid.cell("A1").text).toBe("12.5");
  expect(history.undo("s1").ok).toBe(true);
  expect(grid.cell("A1").text).toBe("$12.50");
  expect(grid.cell("A1").style).toContain("text-align:center");

  // Whole-column selection sets the column's default fmt on <col>.
  const colSel = selectCols(view(), selectCell(view(), selA1, 0, 1));
  applyNumberFormat(grid, view(), colSel, "0.00%");
  expect(table.querySelectorAll("col")[1].getAttribute("fmt")).toBe("0.00%");
  expect(grid.cell("B1").text).toBe("25.00%");
  expect(history.undo("s1").ok).toBe(true);
  expect(table.querySelectorAll("col")[1].getAttribute("fmt")).toBeNull();
});

// Bug: adjusting decimals applied one cell's format across the whole selection, turning a percent cell into currency, or recorded multiple undo steps.
test("adjusting decimals updates each distinct format in the selection inside one history group", async () => {
  const { Sap, grid, history, view } = await setup();
  let sel = createSelection(view(), "s1");
  applyNumberFormat(grid, view(), sel, "$#,##0.00");
  applyNumberFormat(grid, view(), selectCell(view(), sel, 0, 1), "0.00%");

  // Select A1:C1 ($#,##0.00 on A1, 0.00% on B1, Automatic 3.4 on C1).
  sel = moveSelection(view(), sel, { dr: 0, dc: 2, extend: true });
  const spy = jest.spyOn(grid, "format");

  applyDecimals(grid, view(), sel, history, 1, Sap.grid.adjustDecimals);

  expect(spy).toHaveBeenCalledTimes(3);
  expect(grid.cell("A1").text).toBe("$12.500");
  expect(grid.cell("B1").text).toBe("25.000%");
  expect(grid.cell("C1").text).toBe("3.40");

  // One undo restores all three cells to their prior formats.
  expect(history.undo("s1").ok).toBe(true);
  expect(grid.cell("A1").text).toBe("$12.50");
  expect(grid.cell("B1").text).toBe("25.00%");
  expect(grid.cell("C1").text).toBe("3.4");
});

// Bug: merging multiple filled cells discarded values silently or recorded separate undo steps for set, clear and merge.
test("merging multiple filled cells opens the Bevel keep dialog (up to 5 plus more), merges as one undo entry, and unmerges when selected", async () => {
  const { grid, history, view } = await setup();
  grid.setRange("A1", [
    ["one", "two", "three"],
    ["four", "five", "six"],
  ]);

  let sel = createSelection(view(), "s1");
  sel = moveSelection(view(), moveSelection(view(), sel, { dr: 1, dc: 0, extend: true }), {
    dr: 0,
    dc: 2,
    extend: true,
  });

  const beforeUndoCount = () => {
    let dialogHandle = null;
    runMergeCommand({
      grid,
      view: view(),
      sel,
      history,
      runWrite: (fn) => {
        fn();
        return true;
      },
      promptKeep: (filled, onChoose) => {
        dialogHandle = openMergeKeepDialog({
          doc: document,
          items: filled,
          totalCount: filled.length,
          onConfirm: onChoose,
        });
      },
    });
    return dialogHandle;
  };

  const handle = beforeUndoCount();
  expect(handle).not.toBeNull();
  const choices = [...handle.shell.panel.querySelectorAll('[role="radio"]')];
  expect(choices).toHaveLength(5);
  expect(handle.shell.panel.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  expect(choices[0].getAttribute("aria-checked")).toBe("true");
  expect(handle.shell.panel.querySelector("[data-merge-more]")?.textContent).toBe("and 1 more");

  // Choose the 2nd filled cell (B1 = "two") and submit the form.
  choices[1].click();
  expect(choices[1].getAttribute("aria-checked")).toBe("true");
  handle.shell.panel.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

  expect(grid.cell("A1").span).toEqual({ rows: 2, cols: 3 });
  expect(grid.get("A1")).toBe("two");
  expect(inspectMerge(grid, view(), sel).isSingleMerge).toBe(true);

  // One undo unmerges and restores all 6 values!
  expect(history.undo("s1").ok).toBe(true);
  expect(grid.cell("A1").span).toBeNull();
  expect(grid.get("A1:C2")).toEqual([
    ["one", "two", "three"],
    ["four", "five", "six"],
  ]);

  // Redo puts the merge back, and runMergeCommand on the single merge unmerges it.
  expect(history.redo("s1").ok).toBe(true);
  expect(grid.cell("A1").span).toEqual({ rows: 2, cols: 3 });

  runMergeCommand({
    grid,
    view: view(),
    sel,
    history,
    runWrite: (fn) => {
      fn();
      return true;
    },
    promptKeep: () => {
      throw new Error("should not prompt on unmerge");
    },
  });
  expect(grid.cell("A1").span).toBeNull();
  expect(grid.get("A1")).toBe("two");
});

// Bug: a merge refused by the Grid had already written the kept value over the top-left and cleared the other cells.
test("a merge refused at the frozen line leaves both cells as they were", async () => {
  const { grid, history, view } = await setup(FROZEN_BOOK());
  let sel = createSelection(view(), "s1");
  sel = moveSelection(view(), sel, { dr: 1, extend: true });
  let notice = null;

  runMergeCommand({
    grid,
    view: view(),
    sel,
    history,
    runWrite: (fn) => {
      try {
        fn();
        return true;
      } catch (error) {
        if (error?.name !== "GridRefused") throw error;
        notice = error.message;
        return false;
      }
    },
    promptKeep: (filled, onChoose) => onChoose(filled[1]),
  });

  expect(notice).toEqual(expect.any(String));
  expect(grid.get("A1")).toBe("Name");
  expect(grid.get("A2")).toBe("Alice");
  expect(grid.cell("A1").span).toBeNull();
});

// Bug: merging a range whose one filled cell was not the top-left left the merged cell empty.
test("merging a range with one filled cell keeps that value wherever it sits, in one undoable step", async () => {
  const { grid, history, view } = await setup();
  grid.clear("A2");

  let sel = selectCell(view(), createSelection(view(), "s1"), 1, 0);
  sel = moveSelection(view(), sel, { dc: 1, extend: true });
  let prompted = false;

  runMergeCommand({
    grid,
    view: view(),
    sel,
    history,
    runWrite: (fn) => {
      fn();
      return true;
    },
    promptKeep: () => {
      prompted = true;
    },
  });

  expect(prompted).toBe(false);
  expect(grid.cell("A2").span).toEqual({ rows: 1, cols: 2 });
  expect(grid.get("A2")).toBe("beta");

  expect(history.undo("s1").ok).toBe(true);
  expect(grid.cell("A2").span).toBeNull();
  expect(grid.get("A2:B2")).toEqual([[null, "beta"]]);
});

// Bug: numberFormatMenuItems omitted Custom format... at the end, or openCustomFormatDialog failed to prefill, show Loading formats... while grid-formats loaded, disable Apply on an unknown code, or apply across a selection in one undo step.
test("Custom format... opens a Bevel dialog prefilled with the active code, loads grid-formats for custom codes, disables Apply on invalid codes, and writes in one undo step", async () => {
  const { Sap, grid, history, view } = await setup();
  let customOpened = 0;
  const items = numberFormatMenuItems({
    activeValue: 12.5,
    activeFmt: "$#,##0.00",
    formatValue: Sap.grid.formatValue,
    onPick: () => {},
    onCustom: () => {
      customOpened += 1;
    },
  });
  const last = items.at(-1);
  expect(last).toMatchObject({ id: "custom-format", label: "Custom format..." });
  last.onSelect();
  expect(customOpened).toBe(1);

  // Hold grid-formats download open so we can observe "Loading formats..." before it settles.
  const formatsMod = await import("../../../src/vendor/sap-grid-formats.vendor.js");
  let releaseFormats;
  const heldDownload = new Promise((resolve) => {
    releaseFormats = () => resolve(formatsMod);
  });
  Sap.plugins.loader = (name) => (name === "grid-formats" ? heldDownload : undefined);

  let sel = createSelection(view(), "s1");
  sel = moveSelection(view(), sel, { dr: 0, dc: 1, extend: true });
  let appliedFmt = undefined;

  const container = document.createElement("div");
  document.body.append(container);
  const dlg = openCustomFormatDialog({
    doc: document,
    win: window,
    container,
    initialFmt: "$#,##0.00",
    activeValue: 12.5,
    onConfirm: (fmt) => {
      appliedFmt = fmt;
      applyNumberFormat(grid, view(), sel, fmt);
    },
  });

  const input = dlg.shell.panel.querySelector("[data-custom-format-input]");
  const sample = dlg.shell.panel.querySelector("[data-custom-format-sample]");
  expect(input.value).toBe("$#,##0.00");
  expect(sample.textContent).toBe("$12.50");
  expect(dlg.confirmBtn.isDisabled()).toBe(false);
  expect(dlg.confirmBtn.getAttribute("aria-disabled")).toBeNull();

  // Type custom format requiring grid-formats: shows "Loading formats..." and blocks submit until loaded.
  input.value = '0.00 "kg"';
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(sample.textContent).toBe("Loading formats...");
  expect(dlg.confirmBtn.getAttribute("aria-disabled")).toBe("true");
  dlg.shell.panel.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(appliedFmt).toBeUndefined();

  releaseFormats();
  await turn();
  await turn();
  expect(Sap.plugins.has("grid-formats")).toBe(true);
  expect(sample.textContent).toBe("12.50 kg");
  expect(dlg.confirmBtn.getAttribute("aria-disabled")).toBeNull();

  // Invalid format code even with grid-formats installed: disables Apply and shows exact unknown message.
  input.value = "[not-a-format";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(sample.textContent).toBe("That code isn't a number format Sheets knows.");
  expect(dlg.confirmBtn.getAttribute("aria-disabled")).toBe("true");

  // Restore valid custom code and Apply: formats A1:B1 in one undo step.
  input.value = '0.00 "kg"';
  input.dispatchEvent(new Event("input", { bubbles: true }));
  expect(dlg.confirmBtn.getAttribute("aria-disabled")).toBeNull();
  dlg.shell.panel.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

  expect(appliedFmt).toBe('0.00 "kg"');
  expect(grid.cell("A1").text).toBe("12.50 kg");
  expect(grid.cell("B1").text).toBe("0.25 kg");

  expect(history.undo("s1").ok).toBe(true);
  expect(grid.cell("A1").text).toBe("12.5");
  expect(grid.cell("B1").text).toBe("0.25");
});
