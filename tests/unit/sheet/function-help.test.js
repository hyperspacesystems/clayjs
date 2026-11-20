/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { a1, colIndex, rowIndex, tabTable } from "../../../src/sheet/commit.js";
import { createEditor } from "../../../src/sheet/editor.js";
import {
  argumentHintAt,
  completionAt,
  createFunctionHelp,
  MAX_COMPLETIONS,
  POPUP_WIDTH,
} from "../../../src/sheet/function-help.js";
import { FUNCTION_BY_NAME, FUNCTION_HELP } from "../../../src/sheet/function-help-data.js";
import { addressGridExtensions } from "../../../src/sheet/shell.js";
import { keyIntent } from "../../../src/sheet/keys.js";

const BOOK = () => `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="10">10</td><td n v="20">20</td></tr>
<tr data-id="r2" data-pos="l"><td n v="30">30</td><td n v="40">40</td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit>{"rev":1}</script>
</div></main>`;

let sapPromise = null;
async function ensureSap() {
  if (!sapPromise) {
    sapPromise = (async () => {
      window.clay = {
        ready: Promise.resolve(),
        region: (await import("../../../src/lib/region-policy.js")).regionShape,
      };
      const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
      const derive = await import("../../../src/plugins/derive.js");
      await derive.ready;
      await Sap.plugins.load("grid");
      const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
      return { Sap, ownWorkbooks };
    })();
  }
  return sapPromise;
}

async function setupFormulaHarness() {
  window.innerWidth = 1024;
  window.innerHeight = 768;
  document.body.innerHTML = BOOK();

  const { Sap, ownWorkbooks } = await ensureSap();
  const books = ownWorkbooks({});
  await books.ready;
  Sap.mount();

  const workbook = document.querySelector("[sheet-workbook]");
  const table = tabTable(workbook, "s1");
  const grid = Sap.grid(table);
  const editorSlot = document.createElement("div");
  const formulaInput = document.createElement("input");
  const popupHost = document.createElement("div");
  document.body.append(editorSlot, formulaInput, popupHost);

  let fnHelp = null;
  const editor = createEditor({
    workbook,
    editorSlot,
    formulaInput,
    getActiveCell: () => ({
      tab: "s1",
      row: "r1",
      col: "c1",
      r: rowIndex(table, "r1"),
      c: colIndex(table, "c1"),
      ref: "A1",
      text: grid.cell("A1").text,
      input: grid.input("A1"),
      effectiveFmt: grid.cell("A1").effectiveFmt,
      cell: grid.cell("A1"),
    }),
    getView: () => ({
      rows: ["r1", "r2"],
      cols: ["c1", "c2"],
      rowHidden: () => false,
      colHidden: () => false,
      cell: (r, c) => grid.cell(a1(r, c)),
    }),
    getTabs: () => [{ id: "s1", name: "Sheet1", table }],
    getShownTab: () => "s1",
    showTab: () => {},
    onStateChange: () => fnHelp?.update(),
    onCaretChange: () => fnHelp?.update(),
  });

  let docked = false;
  fnHelp = createFunctionHelp({
    isDocked: () => docked,
    container: popupHost,
    win: window,
    editor,
    overlays: { editorSlot },
    getTokenize: () => Sap.grid.tokenize,
  });

  const dispatchEditorKey = (field, key, init = {}) => {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    if (editor.editing && fnHelp.handleKeyDown(ev)) return ev;
    const intent = keyIntent(ev, {
      platform: "Win32",
      editing: editor.editing,
      picking: editor.canPick({ keyboard: true }),
      composing: editor.composing,
    });
    if (intent?.type === "commit") {
      ev.preventDefault();
      editor.commit();
    } else if (intent?.type === "cancel") {
      ev.preventDefault();
      editor.cancel();
    }
    return ev;
  };

  const typeText = (field, value) => {
    field.focus();
    field.value = value;
    field.setSelectionRange(value.length, value.length);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const setDocked = (next) => {
    docked = next;
  };
  return { Sap, grid, editor, fnHelp, popupHost, dispatchEditorKey, typeText, setDocked };
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  window.Sap?.unmount?.();
  window.innerWidth = 1024;
  document.body.innerHTML = "";
  jest.restoreAllMocks();
});

describe("sheet function help and completion", () => {
  // Bug: FUNCTION_HELP missed one of the 86 core or 26 pack functions, fell out of alphabetical order, used wrong PMT argument names, or included dashes in summaries.
  test("holds all 112 sorted functions with Sheets argument names and plain dash-free one-sentence summaries", () => {
    expect(FUNCTION_HELP).toHaveLength(112);
    const names = FUNCTION_HELP.map((f) => f.name);
    expect(names).toEqual([...names].sort());
    expect(new Set(names).size).toBe(112);

    expect(FUNCTION_BY_NAME.get("PMT")).toEqual({
      name: "PMT",
      args: ["rate", "periods", "present_value", "[future_value]", "[end_or_beginning]"],
      summary: expect.any(String),
    });

    for (const entry of FUNCTION_HELP) {
      expect(Array.isArray(entry.args)).toBe(true);
      expect(typeof entry.summary).toBe("string");
      expect(entry.summary.length).toBeGreaterThan(10);
      expect(entry.summary.endsWith(".")).toBe(true);
      expect(entry.summary).not.toMatch(/[-–—]/);
    }
  });

  // Bug: completionAt matched inside strings or after sheet!, missed dotted names, or argumentHintAt counted commas inside nested calls and strings.
  // Bug: a mistyped or missing name in the help list completes to a function the sheet does not
  // have (#NAME?), or the list drifts from what sapjs and the function pack carry.
  test("every listed name is a function the sheet computes once the function pack is in", async () => {
    const { Sap, grid, fnHelp } = await setupFormulaHarness();
    addressGridExtensions(Sap.plugins);
    await Sap.plugins.load("grid-functions");
    const unknown = FUNCTION_HELP.map((f) => f.name).filter((name) => {
      grid.set("A1", `=${name}()`);
      return grid.cell("A1").text === "#NAME?";
    });
    expect(unknown).toEqual([]);
    fnHelp.dispose();
  });

  test("completionAt filters up to 8 prefix matches at valid name starts and argumentHintAt tracks active arguments across nested calls and strings", async () => {
    const { Sap } = await setupFormulaHarness();
    const tokenize = Sap.grid.tokenize;

    const su = completionAt("=su", 3, { tokenize });
    expect(su.items.map((it) => it.name)).toEqual([
      "SUBSTITUTE",
      "SUBTOTAL",
      "SUM",
      "SUMIF",
      "SUMIFS",
      "SUMPRODUCT",
    ]);

    const cList = completionAt("=c", 2, { tokenize });
    expect(cList.items).toHaveLength(MAX_COMPLETIONS);
    expect(MAX_COMPLETIONS).toBe(8);

    const dotted = completionAt("=1+stdev.", 9, { tokenize });
    expect(dotted.items.map((it) => it.name)).toEqual(["STDEV.P", "STDEV.S"]);

    // Never completes inside strings, quoted sheet names, sheet! qualifiers, or $-locked refs.
    expect(completionAt('="su', 4, { tokenize })).toBeNull();
    expect(completionAt("=Sheet1!su", 10, { tokenize })).toBeNull();
    expect(completionAt("='Q1 su", 7, { tokenize })).toBeNull();
    expect(completionAt("=$su", 4, { tokenize })).toBeNull();
    expect(completionAt("=SUM(", 5, { tokenize })).toBeNull();

    // Argument hint index ignores commas inside nested calls and string literals.
    const pmt2 = argumentHintAt("=PMT(5%,", 8, { tokenize });
    expect(pmt2.entry.name).toBe("PMT");
    expect(pmt2.activeArgIndex).toBe(1);
    expect(pmt2.entry.args[pmt2.activeArgIndex]).toBe("periods");

    const nested = '=IF(SUM(A1, B1) > 0, "x,y,z", ';
    const ifHint = argumentHintAt(nested, nested.length, { tokenize });
    expect(ifHint.entry.name).toBe("IF");
    expect(ifHint.activeArgIndex).toBe(2);
    expect(ifHint.entry.args[ifHint.activeArgIndex]).toBe("[value_if_false]");

    // Variadic repeat pairs (IFS) and trailing variadic arg (SUM).
    const ifsExpr = "=IFS(A1>0, 1, B1>0, ";
    const ifsHint = argumentHintAt(ifsExpr, ifsExpr.length, { tokenize });
    expect(ifsHint.entry.name).toBe("IFS");
    expect(ifsHint.entry.args[ifsHint.activeArgIndex]).toBe("[value2, ...]");

    const sumExpr = "=SUM(A1, B1, C1, ";
    const sumHint = argumentHintAt(sumExpr, sumExpr.length, { tokenize });
    expect(sumHint.entry.args[sumHint.activeArgIndex]).toBe("[value2, ...]");
  });

  // Bug: Tab/Enter/click failed to insert NAME(, Enter committed the unfinished formula while the completion list was open, Escape cancelled editing instead of closing only the list, or typing past a non-letter left the list open.
  test("ArrowDown + Tab or Enter or click inserts NAME( without committing, Escape closes only the list, and non-letters close completion", async () => {
    const { grid, editor, fnHelp, dispatchEditorKey, typeText } = await setupFormulaHarness();
    const textarea = editor.textarea;

    typeText(textarea, "=su");
    expect(fnHelp.isCompletionOpen).toBe(true);
    const items = () => [...fnHelp.listSurface.querySelectorAll("[data-completion-item]")];
    expect(items().map((el) => el.getAttribute("data-completion-item"))).toEqual([
      "SUBSTITUTE",
      "SUBTOTAL",
      "SUM",
      "SUMIF",
      "SUMIFS",
      "SUMPRODUCT",
    ]);

    // Move down twice to SUM and press Tab: inserts SUM( and opens argument hint.
    dispatchEditorKey(textarea, "ArrowDown");
    dispatchEditorKey(textarea, "ArrowDown");
    expect(items()[2].getAttribute("aria-selected")).toBe("true");
    dispatchEditorKey(textarea, "Tab");
    expect(editor.buffer).toBe("=SUM(");
    expect(editor.editing).toBe(true);
    expect(fnHelp.isCompletionOpen).toBe(false);
    expect(fnHelp.isHintOpen).toBe(true);

    // Enter while completion list is shown inserts NAME( and does NOT commit the cell!
    typeText(textarea, "=su");
    expect(fnHelp.isCompletionOpen).toBe(true);
    dispatchEditorKey(textarea, "Enter");
    expect(editor.editing).toBe(true);
    expect(editor.buffer).toBe("=SUBSTITUTE(");
    expect(grid.get("A1")).toBe(10);

    // Escape while completion list is shown closes only the list and keeps the editor open; a second Escape cancels.
    typeText(textarea, "=su");
    expect(fnHelp.isCompletionOpen).toBe(true);
    dispatchEditorKey(textarea, "Escape");
    expect(fnHelp.isCompletionOpen).toBe(false);
    expect(editor.editing).toBe(true);
    expect(editor.buffer).toBe("=su");

    dispatchEditorKey(textarea, "Escape");
    expect(editor.editing).toBe(false);

    // Clicking an item inserts NAME(, and typing past a non-letter closes the list.
    typeText(textarea, "=su");
    expect(fnHelp.isCompletionOpen).toBe(true);
    items()[3].click();
    expect(editor.buffer).toBe("=SUMIF(");

    typeText(textarea, "=su+");
    expect(fnHelp.isCompletionOpen).toBe(false);

    fnHelp.dispose();
  });

  // Bug: the argument hint card failed to bold the current argument in PMT, or popups still rendered on narrow phone viewports (< POPUP_WIDTH).
  test("renders PMT signature with the active argument in bold, keeps the editor focused on a press, follows Up and Down, and hides both popups on narrow phone widths", async () => {
    const { editor, fnHelp, typeText, setDocked } = await setupFormulaHarness();

    typeText(editor.textarea, "=PMT(5%,");
    expect(fnHelp.isHintOpen).toBe(true);
    expect(fnHelp.hintSurface.querySelector("[data-function-signature]").textContent).toBe(
      "PMT(rate, periods, present_value, [future_value], [end_or_beginning])",
    );
    expect(fnHelp.hintSurface.querySelector("[data-active-arg]").textContent).toBe("periods");
    expect(fnHelp.hintSurface.querySelector("[data-function-summary]").textContent).toBe(
      FUNCTION_BY_NAME.get("PMT").summary,
    );

    // A press on the card keeps the editor focused: the browser's default would blur it mid-edit.
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    fnHelp.hintSurface.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    // Up moves the caret to the start of a one-line field; the hint follows it there.
    editor.textarea.setSelectionRange(0, 0);
    editor.textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowUp", bubbles: true }));
    expect(fnHelp.isHintOpen).toBe(false);
    editor.textarea.setSelectionRange(8, 8);
    editor.textarea.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true }));
    expect(fnHelp.isHintOpen).toBe(true);

    // Narrow phone viewport (< POPUP_WIDTH = 400): neither hint nor completion shows.
    window.innerWidth = POPUP_WIDTH - 20;
    fnHelp.update();
    expect(fnHelp.isHintOpen).toBe(false);

    typeText(editor.textarea, "=su");
    expect(fnHelp.isCompletionOpen).toBe(false);

    window.innerWidth = 1024;
    fnHelp.update();
    expect(fnHelp.isCompletionOpen).toBe(true);

    // The phone's docked edit bar has its quick keys where the popups would sit.
    setDocked(true);
    fnHelp.update();
    expect(fnHelp.isCompletionOpen).toBe(false);
    setDocked(false);

    fnHelp.dispose();
  });
});
