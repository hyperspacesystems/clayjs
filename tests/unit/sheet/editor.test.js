/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

const BOOK = () => `<main sap plugins="grid"><div style="position:relative;overflow:auto"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="t"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="3">3</td><td n v="5">5</td><td></td></tr>
<tr data-id="r2" data-pos="l"><td n v="4">4</td><td n v="7">7</td><td></td></tr>
<tr data-id="r3" data-pos="t"><td n v="8">8</td><td></td><td></td></tr>
</tbody></table></section>
<section item data-id="s2" data-pos="l"><h2 bind="name">Tab two</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="10">10</td><td></td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit>{"rev":1}</script>
</div></div></main>`;

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

  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { startShell } = await import("../../../src/sheet/shell.js");
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const { startInterface } = await import("../../../src/sheet/interface.js");

  const shell = startShell();
  const books = ownWorkbooks({
    onRebuild: () => {
      shell.restart();
      ui?.restart();
    },
  });
  await books.ready;
  Sap.mount();
  await turn();

  const ui = startInterface({ shell, platform: "MacIntel" });
  const root = document.querySelector("[sheet-workbook]");
  const book = books.books.get(root);
  const inst = ui.of(root);
  const textarea = inst.editor.textarea;
  const formulaInput = inst.chrome.formulaInput;
  return { Sap, books, book, root, shell, ui, inst, textarea, formulaInput };
}

const tableOf = (id) => document.querySelector(`section[data-id="${id}"] table[grid]`);

function typeInto(field, text, inst) {
  field.focus();
  field.value = inst?.editor.editing ? text : field.value + text;
  field.setSelectionRange(field.value.length, field.value.length);
  field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function press(field, key, init = {}) {
  field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init }));
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  jest.restoreAllMocks();
});

// Bug: typing in ready mode appended to old cell text, failed to enter edit mode, or touched the table before Enter; Escape left residue.
test("slice: selecting B2, typing =A1*3 and pressing Enter commits the formula and moves to B3, while Escape on a second edit leaves the table byte for byte as it was", async () => {
  const { Sap, book, ui, inst, textarea } = await start();

  // Move right to B1, down to B2 (r2, c2).
  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown");
  expect(ui.selection.anchor).toEqual({ row: "r2", col: "c2" });

  // Typing replaces old 7 in the editor buffer while the table is untouched until Enter.
  const beforeCommit = tableOf("s1").innerHTML;
  typeInto(textarea, "=A1*3", inst);
  expect(inst.editor.editing).toBe(true);
  expect(textarea.value).toBe("=A1*3");
  expect(tableOf("s1").innerHTML).toBe(beforeCommit);

  press(textarea, "Enter");
  expect(inst.editor.editing).toBe(false);
  expect(Sap.grid(tableOf("s1")).input("B2")).toBe("=A1*3");
  expect(Sap.grid(tableOf("s1")).get("B2")).toBe(9);
  expect(book.serialize({})).toContain('f="=A1*3"');
  expect(book.serialize({})).toContain(">9<");
  expect(ui.selection.anchor).toEqual({ row: "r3", col: "c2" });

  // Escape on a second edit leaves the table byte for byte as it was.
  const afterFirst = tableOf("s1").innerHTML;
  typeInto(textarea, "discard me", inst);
  expect(inst.editor.editing).toBe(true);
  press(textarea, "Escape");
  expect(inst.editor.editing).toBe(false);
  expect(tableOf("s1").innerHTML).toBe(afterFirst);

  ui.dispose();
});

// Bug: F2 opened an empty editor or showed the formatted cell text instead of grid.input, and Tab / Shift+Enter moved the wrong way.
test("F2 opens with grid.input, Tab commits right, and Shift+Enter commits up", async () => {
  const { Sap, ui, inst, textarea } = await start();
  Sap.grid(tableOf("s1")).set("A2", "=A1+10");

  press(textarea, "ArrowDown");
  expect(ui.selection.anchor).toEqual({ row: "r2", col: "c1" });

  press(textarea, "F2");
  expect(inst.editor.editing).toBe(true);
  expect(textarea.value).toBe("=A1+10");

  typeInto(textarea, "=A1+20", inst);
  press(textarea, "Tab");
  expect(Sap.grid(tableOf("s1")).get("A2")).toBe(23);
  expect(ui.selection.anchor).toEqual({ row: "r2", col: "c2" });

  typeInto(textarea, "42", inst);
  press(textarea, "Enter", { shiftKey: true });
  expect(Sap.grid(tableOf("s1")).get("B2")).toBe(42);
  expect(ui.selection.anchor).toEqual({ row: "r1", col: "c2" });

  ui.dispose();
});

// Bug: Enter during IME composition committed the unfinished composition text.
test("a composing Enter does not commit or close the editor", async () => {
  const { Sap, ui, inst, textarea } = await start();

  typeInto(textarea, "ni", inst);
  press(textarea, "Enter", { isComposing: true });
  press(textarea, "Enter", { keyCode: 229 });

  expect(inst.editor.editing).toBe(true);
  expect(textarea.value).toBe("ni");
  expect(Sap.grid(tableOf("s1")).get("A1")).toBe(3);

  ui.dispose();
});

// Bug: the formula bar and cell textarea held separate text states instead of sharing one buffer.
test("the formula bar and the textarea mirror each other on every input", async () => {
  const { Sap, ui, inst, textarea, formulaInput } = await start();

  typeInto(textarea, "=A2+", inst);
  expect(formulaInput.value).toBe("=A2+");

  typeInto(formulaInput, "=A2+B1", inst);
  expect(textarea.value).toBe("=A2+B1");

  press(formulaInput, "Enter");
  expect(Sap.grid(tableOf("s1")).get("A1")).toBe(9);

  ui.dispose();
});

// Bug: clicking another cell while editing discarded the typed edit or selected without committing first.
test("a click on another cell commits the open edit and then selects the clicked cell", async () => {
  const { Sap, ui, inst, textarea } = await start();

  typeInto(textarea, "123", inst);
  expect(inst.editor.editing).toBe(true);

  const targetTd = tableOf("s1").querySelector('tr[data-id="r3"] td');
  targetTd.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));

  expect(inst.editor.editing).toBe(false);
  expect(Sap.grid(tableOf("s1")).get("A1")).toBe(123);
  expect(ui.selection.anchor).toEqual({ row: "r3", col: "c1" });

  ui.dispose();
});

// Bug: arrow keys after =SUM( moved the selection or caret instead of picking a reference, or Shift+arrow failed to form a range, or tab click failed to quote Tab two.
test("with =SUM( an arrow inserts a reference, Shift+arrow extends it to a range, and clicking another tab inserts its quoted A1 ref without committing or moving selection", async () => {
  const { Sap, ui, inst, textarea } = await start();

  // Select B2 (r2, c2).
  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown");
  expect(ui.selection.anchor).toEqual({ row: "r2", col: "c2" });

  typeInto(textarea, "=SUM(", inst);
  press(textarea, "ArrowUp");
  expect(textarea.value).toBe("=SUM(B1");
  expect(inst.editor.editing).toBe(true);
  expect(ui.selection.anchor).toEqual({ row: "r2", col: "c2" });

  press(textarea, "ArrowLeft", { shiftKey: true });
  expect(textarea.value).toBe("=SUM(A1:B1");
  expect(inst.editor.editing).toBe(true);
  expect(ui.selection.anchor).toEqual({ row: "r2", col: "c2" });
  expect(Sap.grid(tableOf("s1")).get("B2")).toBe(7);

  // Add a comma and click the second tab ("Tab two") -> inserts 'Tab two'!A1.
  typeInto(textarea, "=SUM(A1:B1,", inst);
  const tabTwoBtn = inst.chrome.bottomShadow.querySelector('[data-tab-id="s2"]');
  tabTwoBtn.click();
  expect(textarea.value).toBe("=SUM(A1:B1,'Tab two'!A1");
  expect(inst.editor.editing).toBe(true);
  expect(ui.selection.anchor).toEqual({ row: "r2", col: "c2" });

  typeInto(textarea, "=SUM(A1:B1,'Tab two'!A1)", inst);
  press(textarea, "Enter");
  expect(Sap.grid(tableOf("s1")).get("B2")).toBe(18);

  ui.dispose();
});

// Bug: F4 cycled in the wrong order or failed to update the reference at the caret.
test("F4 cycles the reference at the caret through A1, $A$1, A$1, $A1 and back to A1", async () => {
  const { ui, inst, textarea, formulaInput } = await start();

  typeInto(textarea, "=A1+5", inst);
  textarea.setSelectionRange(3, 3);

  press(textarea, "F4");
  expect(textarea.value).toBe("=$A$1+5");
  expect(formulaInput.value).toBe("=$A$1+5");

  press(textarea, "F4");
  expect(textarea.value).toBe("=A$1+5");

  press(textarea, "F4");
  expect(textarea.value).toBe("=$A1+5");

  press(textarea, "F4");
  expect(textarea.value).toBe("=A1+5");

  ui.dispose();
});

// Bug: regex-based reference matching outlined "A1" inside a string literal.
test("a reference inside a string literal gets no colored reference outline", async () => {
  const { ui, inst, textarea } = await start();

  typeInto(textarea, '=IF(B1="A1", C2, "B2:C3")', inst);
  const refs = inst.editor.refs();
  expect(refs.map((r) => textarea.value.slice(r.span[0], r.span[1]))).toEqual(["B1", "C2"]);
  const boxes = inst.overlays.shadow.querySelectorAll(".sheet-ref-box");
  expect(boxes).toHaveLength(2);

  ui.dispose();
});

// Bug: committing when the row was deleted closed the editor, discarded the user's text, or showed no notice.
test("a gone answer keeps the editor open with its text and shows a Bevel notice", async () => {
  const { Sap, ui, inst, textarea } = await start();

  typeInto(textarea, "important note", inst);
  Sap.grid(tableOf("s1")).deleteRows("1:1");

  press(textarea, "Enter");
  expect(inst.editor.editing).toBe(true);
  expect(textarea.value).toBe("important note");
  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(inst.chrome.noticeBar.textContent).toContain("removed");

  ui.dispose();
});

// Bug: an ArrowLeft just after a typed operator (with an operand still to its right) was hijacked
// into a reference pick and spliced a second cell reference into a working formula.
test("an arrow that has an operand to its right leaves the caret alone and never picks a reference", async () => {
  const { Sap, ui, inst, textarea } = await start();
  Sap.grid(tableOf("s1")).set("B2", "=A1+B1");

  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown");
  press(textarea, "F2");
  expect(textarea.value).toBe("=A1+B1");

  textarea.setSelectionRange(4, 4);
  const event = new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, composed: true, cancelable: true });
  textarea.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(false);
  expect(textarea.value).toBe("=A1+B1");
  expect(inst.editor.buffer).toBe("=A1+B1");

  ui.dispose();
});

// Bug: a double click or the corner box while a formula was picking a reference committed the
// unfinished formula instead of leaving the editor open.
test("a double click or the select-all corner while picking never commits the open formula", async () => {
  const { Sap, ui, inst, textarea } = await start();

  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown");
  typeInto(textarea, "=SUM(", inst);
  expect(inst.editor.editing).toBe(true);

  const targetTd = tableOf("s1").querySelector('tr[data-id="r3"] td');
  targetTd.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  expect(textarea.value).toBe("=SUM(A3");

  targetTd.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  expect(inst.editor.editing).toBe(true);
  expect(textarea.value).toBe("=SUM(A3");
  expect(Sap.grid(tableOf("s1")).input("B2")).toBe("7");

  inst.overlays.shadow.querySelector(".sheet-corner").dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  expect(inst.editor.editing).toBe(true);
  expect(textarea.value).toBe("=SUM(A3");
  expect(Sap.grid(tableOf("s1")).input("B2")).toBe("7");

  ui.dispose();
});

// Bug: the formula bar dropped line breaks, so editing a multi-line cell through it silently
// joined its lines.
test("the formula bar keeps a cell's line breaks when an edit is added and committed", async () => {
  const { Sap, ui, inst, formulaInput } = await start();
  Sap.grid(tableOf("s1")).set("A1", "line1\nline2");
  expect(Sap.grid(tableOf("s1")).input("A1")).toBe("line1\nline2");

  formulaInput.focus();
  expect(inst.editor.editing).toBe(true);
  expect(inst.editor.buffer).toBe("line1\nline2");

  formulaInput.value = `${formulaInput.value}!`;
  formulaInput.setSelectionRange(formulaInput.value.length, formulaInput.value.length);
  formulaInput.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  press(formulaInput, "Enter");

  expect(Sap.grid(tableOf("s1")).input("A1")).toBe("line1\nline2!");

  ui.dispose();
});

// Bug: the first input of an IME composition moved the caret with setSelectionRange, splitting
// the first syllable.
test("an input during composition never moves the caret of the field being composed", async () => {
  const { ui, inst, textarea } = await start();
  const setCaret = jest.spyOn(textarea, "setSelectionRange");

  textarea.dispatchEvent(new Event("compositionstart", { bubbles: true, composed: true }));
  expect(inst.editor.composing).toBe(true);

  textarea.value = "k";
  textarea.dispatchEvent(new Event("input", { bubbles: true, composed: true }));

  expect(inst.editor.buffer).toBe("k");
  expect(setCaret).not.toHaveBeenCalled();

  ui.dispose();
});

// Bug: an Enter that arrived with isComposing false while the field was still composing the IME
// candidate committed the half-composed text.
test("Enter while the field is composing does not commit even when the event says it is not", async () => {
  const { Sap, ui, inst, textarea } = await start();

  typeInto(textarea, "ni", inst);
  textarea.dispatchEvent(new Event("compositionstart", { bubbles: true, composed: true }));
  expect(inst.editor.composing).toBe(true);

  press(textarea, "Enter");

  expect(inst.editor.editing).toBe(true);
  expect(textarea.value).toBe("ni");
  expect(Sap.grid(tableOf("s1")).get("A1")).toBe(3);

  ui.dispose();
});

// Bug: clicking the shown tab's button or a column or row header while picking inserted that
// reference instead of leaving the buffer alone.
test("while picking, the shown tab and the header clicks leave the buffer as it was", async () => {
  const { ui, inst, textarea } = await start();

  typeInto(textarea, "=SUM(", inst);
  inst.chrome.bottomShadow.querySelector('[data-tab-id="s1"]').click();
  expect(textarea.value).toBe("=SUM(");
  expect(inst.editor.editing).toBe(true);

  const colHeader = inst.overlays.shadow.querySelector('[data-col="1"]');
  colHeader.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  expect(textarea.value).toBe("=SUM(");

  const rowHeader = inst.overlays.shadow.querySelector('[data-row="2"]');
  rowHeader.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
  expect(textarea.value).toBe("=SUM(");
  expect(inst.editor.editing).toBe(true);

  ui.dispose();
});

// Bug: picking a reference across a merge stepped onto a covered cell, so the reference stayed
// trapped on the merge's top-left cell.
test("picking steps past a merge instead of staying on its own cell", async () => {
  const { Sap, ui, inst, textarea } = await start();
  Sap.grid(tableOf("s1")).merge("B1:C2");

  typeInto(textarea, "=SUM(", inst);
  press(textarea, "ArrowRight");
  expect(textarea.value).toBe("=SUM(B1");

  press(textarea, "ArrowDown");
  expect(textarea.value).toBe("=SUM(B3");

  press(textarea, "ArrowRight");
  expect(textarea.value).toBe("=SUM(C3");

  ui.dispose();
});
