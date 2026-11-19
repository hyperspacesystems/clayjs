/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

// The interface repaints at most once per animation frame; a test reads after the frame ran.
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
<tr data-id="r1" data-pos="V"><td n v="3">3</td><td n v="30" fmt="0.00 &quot;kg&quot;">30.00 kg</td><td></td></tr>
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
<script type="application/json" sheet-commit">{"rev":1}</script>
</div></div></main>`;

function clipEvent(type, data = {}) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const store = { ...data };
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (kind) => store[kind] ?? "",
      setData: (kind, value) => {
        store[kind] = value;
      },
    },
  });
  return event;
}

function selectB2ToC3(textarea) {
  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown");
  press(textarea, "ArrowRight", { shiftKey: true });
  press(textarea, "ArrowDown", { shiftKey: true });
}

function moveToE5(textarea) {
  press(textarea, "ArrowRight");
  press(textarea, "ArrowRight");
  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown");
  press(textarea, "ArrowDown");
  press(textarea, "ArrowDown");
}

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

async function start(body = BOOK(), interfaceOptions = {}) {
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
  const getAdopted = installAdoptedStyleSheets();

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
  const beforeMountHTML = root.outerHTML;
  ui = startInterface({ shell, platform: "MacIntel", ...interfaceOptions });
  const book = books.books.get(root);
  const inst = ui.of(root);
  return { Sap, books, book, root, shell, ui, inst, getAdopted, beforeMountHTML };
}

const tableOf = (id) => document.querySelector(`section[data-id="${id}"] table[grid]`);

function docOf(inner) {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body><main sap plugins="grid"><div items="sheets" sheet-workbook>${inner}</div></main></body></html>`,
    "text/html",
  );
}

function press(field, key, init = {}) {
  field.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true, ...init }));
}

function typeInto(field, text) {
  field.focus();
  field.value = text;
  field.setSelectionRange(text.length, text.length);
  field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

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

// Bug: selection highlights, active outlines, tab visibility or editor elements wrote classes, attributes or nodes inside [sheet-workbook].
test("after moves, a cancelled edit, a tab switch and a reference pick, [sheet-workbook]'s innerHTML is unchanged and revision stays 0", async () => {
  const { book, root, ui, inst, beforeMountHTML } = await start();
  expect(book.revision).toBe(0);

  const textarea = inst.editor.textarea;
  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown", { shiftKey: true });

  // Switch tabs and back.
  inst.chrome.bottomShadow.querySelector('[data-tab-id="s2"]').click();
  inst.chrome.bottomShadow.querySelector('[data-tab-id="s1"]').click();

  // Start formula edit, pick a reference, then cancel with Escape.
  typeInto(textarea, "=SUM(");
  press(textarea, "ArrowDown");
  expect(textarea.value).toBe("=SUM(A2");
  press(textarea, "Escape");

  expect(root.outerHTML).toBe(beforeMountHTML);
  expect(book.revision).toBe(0);

  ui.dispose();
});

// Bug: tabs were shown by toggling hidden/style on section[item] instead of an adopted stylesheet, or listed out of order.
test("the tab strip lists the tabs in page order and switching tabs changes only the adopted stylesheet", async () => {
  const { root, ui, inst } = await start();
  const tabButtons = () => [...inst.chrome.bottomShadow.querySelectorAll('[role="tab"]')];

  expect(tabButtons().map((b) => b.textContent)).toEqual(["Budget", "Totals"]);
  expect(tabButtons().map((b) => b.getAttribute("aria-selected"))).toEqual(["true", "false"]);
  expect(inst.tabs.sheet.text).toContain('section[item]:not([data-id="s1"]) { display: none }');
  expect(inst.tabs.sheet.text).toContain('h2[bind="name"] { display: none }');

  const beforeSwitch = root.innerHTML;
  tabButtons()[1].click();

  expect(root.innerHTML).toBe(beforeSwitch);
  expect(inst.tabs.sheet.text).toContain('section[item]:not([data-id="s2"]) { display: none }');
  expect(tabButtons().map((b) => b.getAttribute("aria-selected"))).toEqual(["false", "true"]);

  ui.dispose();
});

// Bug: unimplemented toolbar commands (undo, merge on one cell, sort, chart, import) were clickable without aria-disabled="true".
test("buttons for commands that cannot act or land in later milestones are drawn and disabled with aria-disabled", async () => {
  const { ui, inst } = await start();

  for (const id of ["undo", "redo", "merge", "filter", "sort", "checkbox", "chart"]) {
    const btn = inst.chrome.topShadow.querySelector(`[data-command="${id}"]`);
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-disabled")).toBe("true");
  }
  for (const id of ["number-format", "currency", "bold", "borders", "find", "import"]) {
    const btn = inst.chrome.topShadow.querySelector(`[data-command="${id}"]`);
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-disabled")).toBeNull();
  }
  const addTab = inst.chrome.bottomShadow.querySelector('[data-command="add-tab"]');
  expect(addTab?.getAttribute("aria-disabled")).toBeNull();

  // Chrome mounts outside the scroll box and overlays mount after the workbook, never inside [sheet-workbook].
  const scroller = document.getElementById("scroller");
  expect(scroller.previousElementSibling).toBe(inst.chrome.topHost);
  expect(scroller.nextElementSibling).toBe(inst.chrome.bottomHost);
  expect(inst.overlays.host.parentElement).toBe(scroller);

  ui.dispose();
});

// Bug: restart() after a merge replaced the shown tab's table reset selection to A1 or stayed subscribed only to the dead Grid.
test("restart() after a merge that replaced the shown tab's table keeps the selection by id and subscribes to the new Grid", async () => {
  const { Sap, book, ui, inst } = await start();
  const textarea = inst.editor.textarea;

  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown");
  expect(ui.selection).toEqual({
    tab: "s1",
    anchor: { row: "r2", col: "c2" },
    focus: { row: "r2", col: "c2" },
  });

  const saved = book.serialize({ purpose: "save" });
  const peer = docOf(saved);
  // Insert a new row above r1 in peer's s1 so r2 moves to row index 2 (B3), and replace the table via merge.
  peer.querySelector('section[data-id="s1"] tbody').insertAdjacentHTML(
    "afterbegin",
    '<tr data-id="r0" data-pos="B"><td n v="1">1</td><td n v="2">2</td><td></td></tr>',
  );
  book.merge({ document: peer, base: docOf(saved) })();

  // Selection stays on { row: "r2", col: "c2" }, which is now B3!
  expect(ui.selection).toEqual({
    tab: "s1",
    anchor: { row: "r2", col: "c2" },
    focus: { row: "r2", col: "c2" },
  });
  expect(inst.chrome.nameBox.textContent).toBe("B3");

  // New Grid's change events refresh the formula bar and aria-label.
  Sap.grid(tableOf("s1")).set("B3", "99");
  await frame();
  expect(inst.chrome.formulaInput.value).toBe("99");
  expect(textarea.getAttribute("aria-label")).toBe("B3, 99");

  ui.dispose();
});

// Bug: Delete cleared cells one by one in a loop instead of one grid.clear(area) action, or failed in ready mode.
test("Delete clears the selected cells' content in one Grid action", async () => {
  const { Sap, book, ui, inst } = await start();
  const textarea = inst.editor.textarea;

  // Select A1:B2 (anchor A1, Shift+Right, Shift+Down).
  press(textarea, "ArrowRight", { shiftKey: true });
  press(textarea, "ArrowDown", { shiftKey: true });
  expect(inst.chrome.nameBox.textContent).toBe("A1:B2");

  const revBefore = book.revision;
  press(textarea, "Delete");

  expect(book.revision).toBe(revBefore + 1);
  expect(Sap.grid(tableOf("s1")).get("A1:B2")).toEqual([
    [null, null],
    [null, null],
  ]);
  expect(Sap.grid(tableOf("s1")).get("C2")).toBe(9);

  ui.dispose();
});

// Bug: the editor textarea lacked aria-label with the cell address and shown value, or failed to announce tab dimensions and moves, or overlays rendered all 500 row numbers instead of windowed rows.
test("the editor's aria-label and polite live region announce tab counts on entry and the active cell's shown value on move, while row numbers render only shown groups", async () => {
  const { ui, inst } = await start();
  const textarea = inst.editor.textarea;

  // Initial entry on Budget tab announces tab name, row/column counts, and A1's value.
  expect(textarea.getAttribute("aria-label")).toBe("Budget, 3 rows, 3 columns, A1, 3");

  // Move right onto B1 (formatted as "30.00 kg").
  press(textarea, "ArrowRight");
  expect(textarea.getAttribute("aria-label")).toBe("B1, 30.00 kg");
  expect(inst.overlays.live.textContent).toBe("B1, 30.00 kg");
  ui.dispose();

  // Verify row numbers only render the row window's shown groups on a 10-group (500-row) table.
  let n = 0;
  const posKey = (k) => String.fromCharCode(97 + Math.floor(k / 26)) + String.fromCharCode(97 + (k % 26));
  const bodies = Array.from({ length: 10 }, () => {
    let rows = "";
    for (let i = 0; i < 50; i++, n++) rows += `<tr data-id="r${n}" data-pos="${posKey(n)}"><td n v="${n}">${n}</td></tr>`;
    return `<tbody>${rows}</tbody>`;
  }).join("");
  const big = await start(`<main sap plugins="grid"><div style="position:relative;overflow:auto"><div items="sheets" sheet-workbook><section item data-id="s1" data-pos="V"><h2 bind="name">Big</h2><table grid><colgroup><col data-id="c1" data-pos="V"></colgroup>${bodies}</table></section></div></div></main>`);
  const renderedRows = big.inst.overlays.shadow.querySelectorAll(".sheet-row-hdr").length;
  expect(renderedRows).toBe(100);
  big.ui.dispose();
});

// Bug: a move stepped onto a hidden row, so the person typed into a cell they could not see.
test("a move from a row above a hidden row lands on the next visible row", async () => {
  const { ui, inst } = await start(BOOK().replace('<tr data-id="r2" data-pos="l">', '<tr data-id="r2" data-pos="l" hidden>'));
  const textarea = inst.editor.textarea;

  press(textarea, "ArrowDown");
  expect(ui.selection.anchor).toEqual({ row: "r3", col: "c1" });
  expect(inst.chrome.nameBox.textContent).toBe("A3");

  press(textarea, "ArrowUp");
  expect(ui.selection.anchor).toEqual({ row: "r1", col: "c1" });

  ui.dispose();
});

// Bug: the editor box took the pointer in ready mode, and floated over another tab while the
// person was picking a reference from it.
test("the editor box never takes the pointer in ready mode and parks while another tab is shown", async () => {
  const { ui, inst } = await start();
  const textarea = inst.editor.textarea;

  expect(textarea.style.pointerEvents).toBe("none");
  expect(inst.overlays.editorSlot.style.pointerEvents).not.toBe("none");

  typeInto(textarea, "=SUM(");
  expect(textarea.style.pointerEvents).toBe("auto");

  inst.chrome.bottomShadow.querySelector('[data-tab-id="s2"]').click();
  expect(inst.overlays.editorSlot.style.opacity).toBe("0");
  expect(inst.overlays.editorSlot.style.pointerEvents).toBe("none");

  inst.chrome.bottomShadow.querySelector('[data-tab-id="s1"]').click();
  expect(inst.overlays.editorSlot.style.opacity).toBe("");

  ui.dispose();
});

// Bug: keyboard moves moved the active cell out of the scroll box and left it invisible.
test("Ctrl+End scrolls the scroll box so the active cell is inside it", async () => {
  let n = 0;
  const posKey = (k) => String.fromCharCode(97 + Math.floor(k / 26)) + String.fromCharCode(97 + (k % 26));
  const bodies = Array.from({ length: 10 }, () => {
    let rows = "";
    for (let i = 0; i < 50; i++, n++) rows += `<tr data-id="r${n}" data-pos="${posKey(n)}"><td n v="${n}">${n}</td></tr>`;
    return `<tbody>${rows}</tbody>`;
  }).join("");
  const { ui, inst } = await start(
    `<main sap plugins="grid"><div id="scroller" style="position:relative;overflow:auto"><div items="sheets" sheet-workbook><section item data-id="s1" data-pos="V"><h2 bind="name">Big</h2><table grid><colgroup><col data-id="c1" data-pos="V"></colgroup>${bodies}</table></section></div></div></main>`,
  );
  const textarea = inst.editor.textarea;
  const scroller = document.getElementById("scroller");
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 260 });
  scroller.getBoundingClientRect = () => ({ top: 0, left: 0, right: 400, bottom: 260, width: 400, height: 260 });
  const boxOf = (r, c) => ({ top: 24 + r * 20, left: 42 + c * 90, width: 90, height: 20 });
  inst.overlays.cellBox = (table, win, r, c) => boxOf(r, c);

  press(textarea, "End", { metaKey: true });
  expect(inst.chrome.nameBox.textContent).toBe("A500");

  const cell = boxOf(499, 0);
  expect(scroller.scrollTop).toBe(cell.top + cell.height - 260);
  expect(cell.top - scroller.scrollTop + cell.height).toBeLessThanOrEqual(260);

  ui.dispose();
});

// Bug: Delete on a sheet whose Grid refuses every write threw GridRefused and showed no notice.
test("Delete on a sheet that needs repair shows the notice and throws nothing", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const { ui, inst } = await start(BOOK().replace("<td>Note</td>", '<td hidden bad>bad</td>'));
  const errors = [];
  const onError = (event) => errors.push(event.error ?? event.reason ?? event);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onError);

  press(inst.editor.textarea, "Delete");

  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onError);
  expect(errors).toEqual([]);
  expect(inst.chrome.noticeBar.hidden).toBe(false);

  ui.dispose();
});

// Bug: Escape after a peer merge removed the edited tab showed the tab that no longer exists, so
// every surviving tab and its headers vanished.
test("Escape after a merge removed the edited tab leaves the other tab shown with its headers", async () => {
  const { book, ui, inst } = await start();
  const textarea = inst.editor.textarea;

  typeInto(textarea, "half typed");
  expect(inst.editor.editing).toBe(true);

  const saved = book.serialize({ purpose: "save" });
  const peer = docOf(saved);
  peer.querySelector('section[data-id="s1"]').remove();
  book.merge({ document: peer, base: docOf(saved) })();
  expect(inst.tabs.activeId).toBe("s2");

  press(textarea, "Escape");

  expect(inst.tabs.activeId).toBe("s2");
  expect(inst.overlays.shadow.querySelectorAll(".sheet-col-hdr").length).toBeGreaterThan(0);
  expect(inst.overlays.shadow.querySelectorAll(".sheet-row-hdr").length).toBeGreaterThan(0);

  ui.dispose();
});

// Bug: a scroll repainted the tab strip by rebuilding every button, losing the click a person
// was making while momentum scrolling.
test("a scroll repaints the sheet without replacing the tab buttons", async () => {
  const { ui, inst } = await start();
  const tabButton = inst.chrome.bottomShadow.querySelector('[data-tab-id="s1"]');

  inst.chrome.nameBox.textContent = "stale";
  document.getElementById("scroller").dispatchEvent(new Event("scroll", { bubbles: false }));
  await frame();

  expect(inst.chrome.nameBox.textContent).toBe("A1");
  expect(inst.chrome.bottomShadow.querySelector('[data-tab-id="s1"]')).toBe(tabButton);
  expect(tabButton.isConnected).toBe(true);

  ui.dispose();
});

// Bug: a page with a sans-serif body font replaced the mono font of the formula bar and the cell
// editor on focus, so formulas and digits stopped lining up.
test("the formula bar and the cell editor keep their mono font when focused", async () => {
  document.body.style.fontFamily = "Inter, sans-serif";
  const { ui, inst } = await start();
  const { formulaInput } = inst.chrome;
  const textarea = inst.editor.textarea;

  formulaInput.dispatchEvent(new FocusEvent("focus"));
  expect(formulaInput.style.fontFamily).toContain("ui-monospace");

  textarea.dispatchEvent(new FocusEvent("focus"));
  expect(textarea.style.fontFamily).toContain("ui-monospace");

  ui.dispose();
  document.body.removeAttribute("style");
});

// Bug: the sheet called preventDefault on browser shortcuts it does not own.
test("browser shortcuts typed into the editor are not prevented", async () => {
  const { ui, inst } = await start();
  const textarea = inst.editor.textarea;

  const save = new KeyboardEvent("keydown", { key: "s", metaKey: true, bubbles: true, composed: true, cancelable: true });
  textarea.dispatchEvent(save);
  expect(save.defaultPrevented).toBe(false);

  typeInto(textarea, "=A1+B1");
  const print = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, composed: true, cancelable: true });
  textarea.dispatchEvent(print);
  expect(print.defaultPrevented).toBe(false);
  expect(textarea.value).toBe("=A1+B1");

  ui.dispose();
});

// Bug: copy, paste, undo or redo lost a formula, or a paste was not one undoable action.
test("copy B2:C3, paste at E5, then undo empties it and redo pastes it again", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));

  selectB2ToC3(textarea);
  const copy = clipEvent("copy");
  textarea.dispatchEvent(copy);
  expect(copy.defaultPrevented).toBe(true);
  expect(copy.clipboardData.getData("text/html")).toContain('data-sheet-origin="1,1"');

  moveToE5(textarea);
  const paste = clipEvent("paste", { "text/html": copy.clipboardData.getData("text/html"), "text/plain": copy.clipboardData.getData("text/plain") });
  textarea.dispatchEvent(paste);
  expect(paste.defaultPrevented).toBe(true);

  expect(grid.get("E5")).toBe(3);
  expect(grid.get("E6")).toBe(5);
  expect(grid.input("F6")).toBe("=E6*2");
  expect(grid.get("F6")).toBe(10);

  press(textarea, "z", { metaKey: true });
  expect(grid.cell("E5").content).toBeNull();
  expect(grid.cell("F6").content).toBeNull();

  press(textarea, "Z", { metaKey: true, shiftKey: true });
  expect(grid.get("E5")).toBe(3);
  expect(grid.input("F6")).toBe("=E6*2");
  expect(grid.get("F6")).toBe(10);

  ui.dispose();
});

// Bug: the sheet undid a cell while the person was undoing typing inside the editor.
test("Ctrl+Z in edit mode is not prevented and leaves the sheet alone", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));

  typeInto(textarea, "42");
  press(textarea, "Enter");
  expect(grid.get("A1")).toBe(42);

  press(textarea, "ArrowUp");
  typeInto(textarea, "99");
  expect(inst.editor.editing).toBe(true);

  const undoKey = new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, composed: true, cancelable: true });
  textarea.dispatchEvent(undoKey);

  expect(undoKey.defaultPrevented).toBe(false);
  expect(grid.get("A1")).toBe(42);
  expect(textarea.value).toBe("99");

  press(textarea, "Escape");
  expect(grid.get("A1")).toBe(42);

  ui.dispose();
});

// Bug: a paste while the person was editing a cell wrote the block into the Grid.
test("a paste in edit mode does nothing to the Grid", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));

  typeInto(textarea, "hello");
  expect(inst.editor.editing).toBe(true);
  const html = '<table data-sheet-origin="0,0"><tr><td data-content="42">42</td></tr></table>';
  const paste = clipEvent("paste", { "text/html": html });
  textarea.dispatchEvent(paste);

  expect(paste.defaultPrevented).toBe(false);
  expect(grid.cell("A1").content).not.toBe(42);

  press(textarea, "Escape");
  ui.dispose();
});

// Bug: cut copied nothing, or its clear was not one undoable action.
test("cut leaves the copied text on the clipboard, empties the cells and one undo brings them back", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));

  selectB2ToC3(textarea);
  const cut = clipEvent("cut");
  textarea.dispatchEvent(cut);

  expect(cut.defaultPrevented).toBe(true);
  expect(cut.clipboardData.getData("text/plain")).toContain("3");
  expect(grid.cell("B2").content).toBeNull();
  expect(grid.cell("C3").content).toBeNull();

  press(textarea, "z", { metaKey: true });
  expect(grid.get("B2")).toBe(3);
  expect(grid.input("C3")).toBe("=B3*2");

  ui.dispose();
});

// Bug: values-only pasted a formula instead of its result.
test("Ctrl+Shift+V pastes values only", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));

  selectB2ToC3(textarea);
  const copy = clipEvent("copy");
  textarea.dispatchEvent(copy);

  moveToE5(textarea);
  const vKey = new KeyboardEvent("keydown", { key: "V", metaKey: true, shiftKey: true, bubbles: true, composed: true, cancelable: true });
  textarea.dispatchEvent(vKey);
  expect(vKey.defaultPrevented).toBe(false);
  const paste = clipEvent("paste", { "text/html": copy.clipboardData.getData("text/html") });
  textarea.dispatchEvent(paste);
  expect(paste.defaultPrevented).toBe(true);

  expect(grid.get("F6")).toBe(10);
  expect(grid.input("F6")).not.toBe("=E6*2");

  ui.dispose();
});

// Bug: the page's undo plugin recorded the sheet's own Grid writes.
test("a commit adds nothing to the page undo history", async () => {
  const { ui, inst } = await start(SLICE_BOOK());
  window.clayEditMode = true;
  await import("../../../src/lib/mutation.js");
  const { undo, ready } = await import("../../../src/plugins/undo.js");
  window.clay.undo = undo;
  await ready;
  await turn();

  typeInto(inst.editor.textarea, "42");
  press(inst.editor.textarea, "Enter");
  await turn();
  undo.flush();

  expect(undo.history).toEqual([]);
  undo.stop();
  ui.dispose();
});

// Bug: the toolbar's undo button stayed disabled after a change the sheet could undo.
test("the toolbar's undo button turns enabled after a commit and undoes that commit", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const button = () => inst.chrome.topShadow.querySelector('[data-command="undo"]');
  expect(button().getAttribute("aria-disabled")).toBe("true");

  typeInto(inst.editor.textarea, "42");
  press(inst.editor.textarea, "Enter");
  await frame();

  expect(button().getAttribute("aria-disabled")).not.toBe("true");

  button().click();
  await frame();

  expect(Sap.grid(tableOf("s1")).get("A1")).toBe(1);

  ui.dispose();
});

// Bug: a foreign table pasted by its HTML, so a colspan moved every value left and a cell's line break
// ran its words together.
test("a foreign table pastes the clipboard's plain text, so spans and line breaks keep their cells", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));
  const html = '<table><tr><td colspan="2">Q1</td><td>Total</td></tr><tr><td>Line 1<br>Line 2</td><td>10</td><td>20</td></tr></table>';
  const text = 'Q1\t\tTotal\r\n"Line 1\nLine 2"\t10\t20';

  const paste = clipEvent("paste", { "text/html": html, "text/plain": text });
  textarea.dispatchEvent(paste);

  expect(paste.defaultPrevented).toBe(true);
  expect(grid.get("A1")).toBe("Q1");
  expect(grid.cell("B1").content).toBeNull();
  expect(grid.get("C1")).toBe("Total");
  expect(grid.get("A2")).toBe("Line 1\nLine 2");
  expect(grid.get("B2")).toBe(10);
  expect(grid.get("C2")).toBe(20);

  ui.dispose();
});

// Bug: a cut cell's formula moved by the distance to where it was pasted.
test("cut then paste keeps the formula's references", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));
  expect(grid.input("C3")).toBe("=B3*2");

  press(textarea, "ArrowRight");
  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown");
  press(textarea, "ArrowDown");
  expect(inst.chrome.nameBox.textContent).toBe("C3");

  const cut = clipEvent("cut");
  textarea.dispatchEvent(cut);
  expect(cut.clipboardData.getData("text/html")).toContain("data-sheet-cut");
  expect(grid.cell("C3").content).toBeNull();

  for (let i = 0; i < 3; i++) press(textarea, "ArrowRight");
  for (let i = 0; i < 3; i++) press(textarea, "ArrowDown");
  expect(inst.chrome.nameBox.textContent).toBe("F6");

  const paste = clipEvent("paste", { "text/html": cut.clipboardData.getData("text/html"), "text/plain": cut.clipboardData.getData("text/plain") });
  textarea.dispatchEvent(paste);

  expect(grid.input("F6")).toBe("=B3*2");
  expect(grid.get("F6")).toBe(10);

  ui.dispose();
});

// Bug: a cut event with no clipboard to write to cleared the selected cells anyway.
test("a cut that cannot write the clipboard leaves the cells as they were", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));
  selectB2ToC3(textarea);

  const cut = new Event("cut", { bubbles: true, cancelable: true });
  textarea.dispatchEvent(cut);

  expect(cut.defaultPrevented).toBe(false);
  expect(grid.get("B2")).toBe(3);
  expect(grid.cell("C3").content).toEqual({ f: "=B3*2" });
  expect(grid.get("C3")).toBe(10);

  ui.dispose();
});

// Bug: a ready-mode textarea never cancelled beforecopy or beforecut, so the browser's menu Copy and
// Cut and Safari's Cmd+C and Cmd+X did nothing.
test("beforecopy and beforecut are cancelled in ready mode and left alone while editing", async () => {
  const { ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;

  for (const type of ["beforecopy", "beforecut"]) {
    const ready = new Event(type, { bubbles: true, cancelable: true });
    textarea.dispatchEvent(ready);
    expect(ready.defaultPrevented).toBe(true);
  }

  typeInto(textarea, "42");
  expect(inst.editor.editing).toBe(true);
  for (const type of ["beforecopy", "beforecut"]) {
    const editing = new Event(type, { bubbles: true, cancelable: true });
    textarea.dispatchEvent(editing);
    expect(editing.defaultPrevented).toBe(false);
  }

  press(textarea, "Escape");
  ui.dispose();
});

// Bug: plain text starting with an unclosed quote threw an uncaught DelimitedError and pasted nothing.
test("plain text starting with an unclosed quote pastes as that text and throws nothing", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));
  const errors = [];
  const onError = (event) => errors.push(event.error ?? event.reason ?? event);
  window.addEventListener("error", onError);

  const paste = clipEvent("paste", { "text/plain": '"TBD' });
  textarea.dispatchEvent(paste);

  window.removeEventListener("error", onError);
  expect(errors).toEqual([]);
  expect(paste.defaultPrevented).toBe(true);
  expect(grid.get("A1")).toBe('"TBD');
  expect(inst.chrome.noticeBar.hidden).toBe(true);

  ui.dispose();
});

// Bug: plain text read as quoted CSV dropped the quotes a person had typed.
test("plain text that looks like quoted csv keeps its quotes", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));

  textarea.dispatchEvent(clipEvent("paste", { "text/plain": '"Best" coffee' }));

  expect(grid.get("A1")).toBe('"Best" coffee');

  ui.dispose();
});

// Bug: one value pasted over two percent cells stored a different value than the same paste onto one.
test("one value pasted over a percent selection stores what the same paste onto one cell stores", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));
  grid.format("A1:B2", { fmt: "0%" });

  textarea.dispatchEvent(clipEvent("paste", { "text/plain": "5" }));
  const single = grid.get("A1");
  expect(single).not.toBeNull();

  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown", { shiftKey: true });
  textarea.dispatchEvent(clipEvent("paste", { "text/plain": "5" }));

  expect(grid.get("B1")).toBe(single);
  expect(grid.get("B2")).toBe(single);

  ui.dispose();
});

// Bug: values-only stayed armed after Cmd+Shift+V with no paste came, so the next Cmd+V pasted values.
test("values only switches off on a later key, so the next paste keeps the formula", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));

  selectB2ToC3(textarea);
  const copy = clipEvent("copy");
  textarea.dispatchEvent(copy);

  moveToE5(textarea);
  press(textarea, "V", { metaKey: true, shiftKey: true });
  press(textarea, "v", { metaKey: true });
  textarea.dispatchEvent(clipEvent("paste", { "text/html": copy.clipboardData.getData("text/html"), "text/plain": copy.clipboardData.getData("text/plain") }));

  expect(grid.input("F6")).toBe("=E6*2");
  expect(grid.get("F6")).toBe(10);

  ui.dispose();
});

// Bug: one value pasted over a selection that holds a merge was refused, so nothing was written.
test("one value over a selection that holds a merge fills every uncovered cell without a notice", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));
  grid.merge("B2:C3");

  for (let i = 0; i < 3; i++) press(textarea, "ArrowDown", { shiftKey: true });
  for (let i = 0; i < 3; i++) press(textarea, "ArrowRight", { shiftKey: true });
  expect(inst.chrome.nameBox.textContent).toBe("A1:D4");

  const paste = clipEvent("paste", { "text/plain": "7" });
  textarea.dispatchEvent(paste);

  expect(inst.chrome.noticeBar.hidden).toBe(true);
  for (const ref of ["A1", "A2", "A3", "A4", "B1", "B2", "C1", "D1", "D2", "D3", "D4", "B4", "C4"]) expect(grid.get(ref)).toBe(7);
  for (const ref of ["C2", "B3", "C3"]) expect(grid.cell(ref).content).toBeNull();

  ui.dispose();
});

// Bug: a refused undo left the toolbar's undo button enabled with nothing left to undo.
test("a refused undo shows the notice and leaves the toolbar's undo button disabled", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const button = () => inst.chrome.topShadow.querySelector('[data-command="undo"]');

  typeInto(textarea, "42");
  press(textarea, "Enter");
  await frame();
  expect(button().getAttribute("aria-disabled")).not.toBe("true");

  const grid = Sap.grid(tableOf("s1"));
  grid.apply = () => {
    throw Object.assign(new Error("the sheet has 1 issue(s) to repair first"), { name: "GridRefused" });
  };
  press(textarea, "z", { metaKey: true });
  await frame();

  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(button().getAttribute("aria-disabled")).toBe("true");

  ui.dispose();
});

// Bug: a redo that found changed cells showed the undo wording.
test("a redo that finds changed cells says that step was not redone", async () => {
  const { book, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;

  typeInto(textarea, "42");
  press(textarea, "Enter");
  press(textarea, "z", { metaKey: true });
  await frame();

  const saved = book.serialize({ purpose: "save" });
  const peer = docOf(saved);
  const first = peer.querySelector('section[data-id="s1"] tr[data-id="r1"] td');
  first.setAttribute("v", "99");
  first.textContent = "99";
  book.merge({ document: peer, base: docOf(saved) })();
  await frame();

  press(inst.editor.textarea, "Z", { metaKey: true, shiftKey: true });

  expect(inst.chrome.noticeBar.textContent).toContain("Those cells changed since, so that step was not redone.");

  ui.dispose();
});

// Bug: formatting, merge, row-header insert, column-header resize drag or tab add/rename wrote outside the Grid or failed to walk back one step per undo on that tab.
test("slice: format B2:C3 bold, currency, outer border and merge, insert row above 2, drag col B width, add and rename a tab, then Ctrl+Z walks back each step on Budget", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = () => Sap.grid(tableOf("s1"));

  selectB2ToC3(textarea);
  expect(inst.chrome.nameBox.textContent).toBe("B2:C3");

  press(textarea, "b", { metaKey: true });
  await turn();
  expect(grid().cell("B2").style).toContain("font-weight:bold");
  expect(grid().cell("C3").style).toContain("font-weight:bold");

  inst.chrome.topShadow.querySelector('[data-command="number-format"]').click();
  inst.chrome.topShadow.querySelector('[data-menu-item="currency"]').click();
  expect(grid().cell("B2").fmt).toBe("$#,##0.00");
  expect(grid().cell("B2").text).toBe("$3.00");

  inst.chrome.topShadow.querySelector('[data-command="borders"]').click();
  inst.chrome.topShadow.querySelector('[data-menu-item="outer"]').click();
  expect(grid().cell("B2").style).toContain("border-top:1px solid #5F6368");
  expect(grid().cell("B2").style).toContain("border-left:1px solid #5F6368");
  expect(grid().cell("C3").style).toContain("border-bottom:1px solid #5F6368");
  expect(grid().cell("C3").style).toContain("border-right:1px solid #5F6368");

  inst.chrome.topShadow.querySelector('[data-command="merge"]').click();
  const keepDialog = inst.chrome.topShadow.querySelector('[role="dialog"]');
  expect(keepDialog).not.toBeNull();
  keepDialog.querySelector('button[type="submit"]').click();
  expect(grid().cell("B2").span).toEqual({ rows: 2, cols: 2 });
  expect(grid().get("B2")).toBe(3);

  const row2Hdr = inst.overlays.shadow.querySelector('[data-row="1"]');
  row2Hdr.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 60 }));
  inst.chrome.topShadow.querySelector('[data-menu-item="insert-above"]').click();
  expect(grid().size.rows).toBe(7);
  expect(inst.chrome.nameBox.textContent).toBe("A2:F2");
  expect(grid().cell("B3").span).toEqual({ rows: 2, cols: 2 });

  const colBGrip = inst.overlays.shadow.querySelector('[data-col-resize="1"]');
  colBGrip.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 200 }));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 260 }));
  expect(inst.overlays.resizeGuide.hidden).toBe(false);
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 260 }));
  expect(inst.overlays.resizeGuide.hidden).toBe(true);
  expect(tableOf("s1").querySelector('col[data-id="c2"]').getAttribute("style")).toBe("width:160px");

  inst.chrome.bottomShadow.querySelector('[data-command="add-tab"]').click();
  const tabBtns = () => [...inst.chrome.bottomShadow.querySelectorAll('[role="tab"]')];
  expect(tabBtns().map((b) => b.textContent)).toEqual(["Budget", "Sheet 1"]);
  const addedId = inst.tabs.activeId;
  expect(addedId).not.toBe("s1");
  expect(Sap.grid(tableOf(addedId)).size).toEqual({ rows: 100, cols: 26 });

  tabBtns()[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  const renameInput = inst.chrome.bottomShadow.querySelector("[data-tab-rename]");
  expect(renameInput).not.toBeNull();
  renameInput.value = "Notes";
  press(renameInput, "Enter");
  expect(tabBtns().map((b) => b.textContent)).toEqual(["Budget", "Notes"]);

  tabBtns()[0].click();
  expect(inst.tabs.activeId).toBe("s1");

  // 1) Undo column B width drag
  press(textarea, "z", { metaKey: true });
  expect(tableOf("s1").querySelector('col[data-id="c2"]').getAttribute("style")).toBeNull();

  // 2) Undo insert row above 2
  press(textarea, "z", { metaKey: true });
  expect(grid().size.rows).toBe(6);
  expect(grid().cell("B2").span).toEqual({ rows: 2, cols: 2 });

  // 3) Undo merge (single grouped entry)
  press(textarea, "z", { metaKey: true });
  expect(grid().cell("B2").span).toBeNull();
  expect(grid().get("B2:C3")).toEqual([
    [3, 4],
    [5, 10],
  ]);
  expect(grid().input("C3")).toBe("=B3*2");
  expect(grid().cell("B2").style).toContain("border-top:1px solid #5F6368");

  // 4) Undo outer border
  press(textarea, "z", { metaKey: true });
  expect(grid().cell("B2").style).toBe("font-weight:bold");

  // 5) Undo currency format
  press(textarea, "z", { metaKey: true });
  expect(grid().cell("B2").fmt).toBeNull();
  expect(grid().cell("B2").text).toBe("3");

  // 6) Undo bold
  press(textarea, "z", { metaKey: true });
  expect(grid().cell("B2").style).toBeNull();
  expect(tabBtns().map((b) => b.textContent)).toEqual(["Budget", "Notes"]);

  ui.dispose();
});

// Bug: inserting rows or columns dropped neighbour formats or failed to move the selection onto the new rows/columns, or Ctrl+Alt+=/Ctrl+Alt+- ignored whole-axis selection.
test("header menus, Shift+F10 and Ctrl+Alt+=/Ctrl+Alt+- insert with neighbour formats, move selection onto inserted axes, and delete selected rows and columns", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));

  inst.overlays.shadow.querySelector('[data-col="1"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  inst.chrome.topShadow.querySelector('[data-command="currency"]').click();
  await turn();
  expect(tableOf("s1").querySelector('col[data-id="c2"]').getAttribute("fmt")).toBe("$#,##0.00");

  inst.overlays.shadow.querySelector('[data-col="2"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  expect(inst.chrome.nameBox.textContent).toBe("B1:C6");

  press(textarea, "F10", { shiftKey: true });
  const insertLeft = inst.chrome.topShadow.querySelector('[data-menu-item="insert-left"]');
  expect(insertLeft?.textContent).toContain("Insert 2 left");
  insertLeft.click();

  expect(grid.size.cols).toBe(8);
  expect(inst.chrome.nameBox.textContent).toBe("B1:C6");
  const allCols = [...tableOf("s1").querySelectorAll("colgroup > col")];
  expect(allCols[1].getAttribute("fmt")).toBe("$#,##0.00");
  expect(allCols[2].getAttribute("fmt")).toBe("$#,##0.00");

  press(textarea, "-", { ctrlKey: true, altKey: true });
  expect(grid.size.cols).toBe(6);

  // Two columns selected: Ctrl+Alt+= inserts two and Ctrl+Alt+- takes both away again.
  inst.overlays.shadow.querySelector('[data-col="0"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  inst.overlays.shadow.querySelector('[data-col="1"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  expect(inst.chrome.nameBox.textContent).toBe("A1:B6");
  press(textarea, "=", { ctrlKey: true, altKey: true });
  expect(grid.size.cols).toBe(8);
  expect(inst.chrome.nameBox.textContent).toBe("A1:B6");
  press(textarea, "-", { ctrlKey: true, altKey: true });
  expect(grid.size.cols).toBe(6);

  press(textarea, "ArrowDown");
  press(textarea, " ", { shiftKey: true });
  expect(inst.chrome.nameBox.textContent).toBe("A2:F2");
  inst.overlays.shadow.querySelector('[data-row="2"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  expect(inst.chrome.nameBox.textContent).toBe("A2:F3");
  press(textarea, "=", { ctrlKey: true, altKey: true });
  expect(grid.size.rows).toBe(8);
  expect(inst.chrome.nameBox.textContent).toBe("A2:F3");

  tableOf("s1").dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 35 }));
  inst.chrome.topShadow.querySelector('[data-menu-item="delete-rows"]').click();
  expect(grid.size.rows).toBe(6);

  ui.dispose();
});

// Bug: dragging a selected column or row header resized only one track or ignored the 8px/12px floor, or double-clicking the grip ignored the injected measureText and 12px/600px bounds.
test("header drag resizes all selected columns or rows with 8px/12px floors, and double-clicking a column grip fits to measured visible text plus 12px up to 600px", async () => {
  const { Sap, shell, ui, inst } = await start(SLICE_BOOK(), {
    measureText: (text) => text.length * 10,
  });
  const grid = Sap.grid(tableOf("s1"));
  grid.set("B2", "abcdefghij");
  grid.set("C2", "x".repeat(70));
  await frame();

  inst.overlays.shadow.querySelector('[data-col-resize="1"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  await turn();
  expect(tableOf("s1").querySelector('col[data-id="c2"]').getAttribute("style")).toBe("width:112px");

  inst.overlays.shadow.querySelector('[data-col-resize="2"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  expect(tableOf("s1").querySelector('col[data-id="c3"]').getAttribute("style")).toBe("width:600px");

  inst.overlays.shadow.querySelector('[data-col-resize="3"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  expect(tableOf("s1").querySelector('col[data-id="c4"]').getAttribute("style")).toBeNull();

  inst.overlays.shadow.querySelector('[data-col="1"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  inst.overlays.shadow.querySelector('[data-col="2"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  inst.overlays.shadow.querySelector('[data-col-resize="1"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 200 }));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: -500 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: -500 }));
  expect(tableOf("s1").querySelector('col[data-id="c2"]').getAttribute("style")).toBe("width:8px");
  expect(tableOf("s1").querySelector('col[data-id="c3"]').getAttribute("style")).toBe("width:8px");

  inst.overlays.shadow.querySelector('[data-row-resize="1"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientY: 60 }));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: 80 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientY: 80 }));
  expect(tableOf("s1").querySelector('tr[data-id="r2"]').getAttribute("style")).toBe("height:46px");
  expect(shell.windowOf(tableOf("s1")).geometry.rowHeight(1)).toBe(46);

  inst.overlays.shadow.querySelector('[data-row-resize="1"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientY: 60 }));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientY: -500 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientY: -500 }));
  expect(tableOf("s1").querySelector('tr[data-id="r2"]').getAttribute("style")).toBe("height:12px");

  ui.dispose();
});

// Bug: freezing rows reset frozen columns (or vice versa), or a freeze cutting a merge threw instead of showing sapjs's merge_cut notice.
test("freezing rows and columns preserves the other axis count, unfreezes cleanly, and shows sapjs's notice when a freeze cuts a merge", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const table = tableOf("s1");

  inst.overlays.shadow.querySelector('[data-row="1"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 60 }));
  await turn();
  inst.chrome.topShadow.querySelector('[data-menu-item="freeze-rows"]').click();
  expect(table.tHead?.rows.length).toBe(2);

  inst.overlays.shadow.querySelector('[data-col="2"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 10 }));
  inst.chrome.topShadow.querySelector('[data-menu-item="freeze-cols"]').click();
  expect(table.getAttribute("freeze-cols")).toBe("3");
  expect(table.tHead?.rows.length).toBe(2);

  inst.overlays.shadow.querySelector('[data-row="0"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }));
  inst.chrome.topShadow.querySelector('[data-menu-item="unfreeze-rows"]').click();
  expect(table.tHead).toBeNull();
  expect(table.getAttribute("freeze-cols")).toBe("3");

  Sap.grid(table).merge("B2:B3");
  await frame();
  inst.overlays.shadow.querySelector('[data-row="1"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 60 }));
  await turn();
  inst.chrome.topShadow.querySelector('[data-menu-item="freeze-rows"]').click();
  expect(table.tHead).toBeNull();
  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(inst.chrome.noticeBar.textContent).toContain("cut a merge");

  ui.dispose();
});

// Bug: duplicating a tab failed on matching record ids or placed it at the end, name_taken closed the rename input, or deleting tabs skipped confirmation or failed on last_sheet.
test("tabs duplicate with preserved record ids right after the source tab, move left/right, keep rename open on name_taken, and confirm delete while showing last_sheet on the final tab", async () => {
  const { Sap, ui, inst } = await start();
  const tabBtns = () => [...inst.chrome.bottomShadow.querySelectorAll('[role="tab"]')];

  tabBtns()[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 400 }));
  await turn();
  inst.chrome.topShadow.querySelector('[data-menu-item="duplicate-tab"]').click();

  expect(tabBtns().map((b) => b.textContent)).toEqual(["Budget", "Copy of Budget", "Totals"]);
  const copyId = inst.tabs.list()[1].id;
  expect([...tableOf(copyId).querySelectorAll("tbody tr")].map((tr) => tr.getAttribute("data-id"))).toEqual(["r1", "r2", "r3"]);
  expect(Sap.grid(tableOf(copyId)).cell("B1").text).toBe("30.00 kg");

  tabBtns()[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 400 }));
  inst.chrome.topShadow.querySelector('[data-menu-item="move-tab-right"]').click();
  expect(tabBtns().map((b) => b.textContent)).toEqual(["Budget", "Totals", "Copy of Budget"]);

  tabBtns()[2].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 400 }));
  inst.chrome.topShadow.querySelector('[data-menu-item="move-tab-left"]').click();
  expect(tabBtns().map((b) => b.textContent)).toEqual(["Budget", "Copy of Budget", "Totals"]);

  tabBtns()[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  const renameInput = inst.chrome.bottomShadow.querySelector("[data-tab-rename]");
  renameInput.value = "Totals";
  press(renameInput, "Enter");
  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(inst.chrome.bottomShadow.querySelector("[data-tab-rename]")).toBe(renameInput);

  press(renameInput, "Escape");
  expect(inst.chrome.bottomShadow.querySelector("[data-tab-rename]")).toBeNull();
  expect(tabBtns().map((b) => b.textContent)).toEqual(["Budget", "Copy of Budget", "Totals"]);

  for (const idx of [1, 1]) {
    tabBtns()[idx].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 400 }));
    inst.chrome.topShadow.querySelector('[data-menu-item="delete-tab"]').click();
    const dlg = inst.chrome.topShadow.querySelector('[role="dialog"]');
    expect(dlg).not.toBeNull();
    dlg.querySelector('button[type="submit"]').click();
  }
  expect(tabBtns().map((b) => b.textContent)).toEqual(["Budget"]);

  tabBtns()[0].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 400 }));
  inst.chrome.topShadow.querySelector('[data-menu-item="delete-tab"]').click();
  const lastDlg = inst.chrome.topShadow.querySelector('[role="dialog"]');
  expect(lastDlg?.textContent).toContain("Budget");
  lastDlg.querySelector('button[type="submit"]').click();
  expect(tabBtns().map((b) => b.textContent)).toEqual(["Budget"]);
  expect(inst.chrome.noticeBar.hidden).toBe(false);

  ui.dispose();
});

// Bug: toolbar aria-pressed, number-format label or merge/unmerge label did not track the active cell, or commands stayed enabled while editing.
test("toolbar tracks active-cell pressed states, format label and Merge/Unmerge state, disables all commands while editing, and Ctrl+\\ clears formatting", async () => {
  const { ui, inst } = await start();
  const textarea = inst.editor.textarea;
  const cmd = (id) => inst.chrome.topShadow.querySelector(`[data-command="${id}"]`);

  expect(cmd("number-format").textContent).toBe("Automatic");
  expect(cmd("merge").getAttribute("aria-disabled")).toBe("true");

  press(textarea, "ArrowRight");
  expect(cmd("number-format").textContent).toBe("Custom");

  press(textarea, "b", { metaKey: true });
  await turn();
  press(textarea, "i", { metaKey: true });
  press(textarea, "X", { metaKey: true, shiftKey: true });
  cmd("wrap").click();
  expect(cmd("bold").getAttribute("aria-pressed")).toBe("true");
  expect(cmd("italic").getAttribute("aria-pressed")).toBe("true");
  expect(cmd("strikethrough").getAttribute("aria-pressed")).toBe("true");
  expect(cmd("wrap").getAttribute("aria-pressed")).toBe("true");

  cmd("currency").click();
  expect(cmd("number-format").textContent).toBe("Currency");

  press(textarea, "\\", { metaKey: true });
  expect(cmd("bold").getAttribute("aria-pressed")).toBe("false");
  expect(cmd("italic").getAttribute("aria-pressed")).toBe("false");
  expect(cmd("strikethrough").getAttribute("aria-pressed")).toBe("false");
  expect(cmd("wrap").getAttribute("aria-pressed")).toBe("false");
  expect(cmd("number-format").textContent).toBe("Automatic");

  press(textarea, "ArrowRight", { shiftKey: true });
  expect(cmd("merge").getAttribute("aria-disabled")).toBeNull();
  expect(cmd("merge").textContent).toBe("Merge");
  cmd("merge").click();
  expect(cmd("merge").textContent).toBe("Unmerge");
  expect(cmd("merge").getAttribute("aria-label")).toBe("Unmerge cells");

  typeInto(textarea, "editing");
  expect(inst.editor.editing).toBe(true);
  for (const id of ["bold", "number-format", "merge"]) {
    expect(cmd(id).getAttribute("aria-disabled")).toBe("true");
  }
  expect(inst.chrome.bottomShadow.querySelector('[data-command="add-tab"]').getAttribute("aria-disabled")).toBe("true");

  press(textarea, "Escape");
  ui.dispose();
});

const TITLE_BOOK = () => `<main sap plugins="grid"><div id="scroller" style="position:relative;overflow:auto"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="t"><col data-id="c4" data-pos="x"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td colspan="3">Budget 2026</td><td hidden></td><td hidden></td><td></td></tr>
<tr data-id="r2" data-pos="l"><td>Rent</td><td n v="10">10</td><td n v="20">20</td><td n v="30">30</td></tr>
<tr data-id="r3" data-pos="t"><td>Food</td><td n v="1">1</td><td n v="2">2</td><td n v="3">3</td></tr>
</tbody></table></section>
<section item data-id="s2" data-pos="l"><h2 bind="name">Totals</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody><tr data-id="r1" data-pos="V"><td n v="7">7</td><td></td></tr></tbody></table></section>
<script type="application/json" sheet-commit">{"rev":1}</script>
</div></div></main>`;

const NO_POS_BOOK = () => `<main sap plugins="grid"><div id="scroller" style="position:relative;overflow:auto"><div items="sheets" sheet-workbook>
<section item data-id="s1"><h2 bind="name">One</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody><tr data-id="r1" data-pos="V"><td n v="1">1</td><td></td></tr></tbody></table></section>
<section item data-id="s2"><h2 bind="name">Two</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody><tr data-id="r1" data-pos="V"><td n v="2">2</td><td></td></tr></tbody></table></section>
<section item data-id="s3"><h2 bind="name">Three</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody><tr data-id="r1" data-pos="V"><td n v="3">3</td><td></td></tr></tbody></table></section>
<script type="application/json" sheet-commit">{"rev":1}</script>
</div></div></main>`;

const colIds = () => [...tableOf("s1").querySelectorAll("colgroup > col")].map((c) => c.getAttribute("data-id"));
const tabLabels = (inst) => [...inst.chrome.bottomShadow.querySelectorAll('[role="tab"]')].map((b) => b.textContent);
const openTabMenu = (inst, index) =>
  inst.chrome.bottomShadow.querySelectorAll('[role="tab"]')[index].dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40 + index * 40, clientY: 400 }),
  );

// Bug: a header click under a merge grew the selection through the merge, so the menu, Delete and Bold acted on A:C.
test("a column header click under a merged title selects only that column for its menu, Delete columns and Bold", async () => {
  const { Sap, ui, inst } = await start(TITLE_BOOK());
  const grid = () => Sap.grid(tableOf("s1"));
  const textarea = inst.editor.textarea;
  expect(grid().cell("A1").span).toEqual({ rows: 1, cols: 3 });

  inst.overlays.shadow.querySelector('[data-col="2"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  expect(inst.chrome.nameBox.textContent).toBe("C1:C3");

  press(textarea, "b", { metaKey: true });
  await turn();
  expect(grid().cell("A2").style).toBeNull();
  expect(grid().cell("B2").style).toBeNull();
  expect(grid().cell("C2").style).toContain("font-weight:bold");
  press(textarea, "b", { metaKey: true });

  press(textarea, "Delete");
  expect(grid().get("C2")).toBeNull();
  expect(grid().get("C3")).toBeNull();
  expect(grid().get("A2")).toBe("Rent");
  expect(grid().get("B2")).toBe(10);
  expect(grid().cell("A1").span).toEqual({ rows: 1, cols: 3 });

  inst.overlays.shadow.querySelector('[data-col="2"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 10 }));
  expect(inst.chrome.nameBox.textContent).toBe("C1:C3");
  expect(inst.chrome.topShadow.querySelector('[data-menu-item="insert-left"]').textContent).toContain("Insert 1 left");
  inst.chrome.topShadow.querySelector('[data-menu-item="delete-cols"]').click();

  expect(colIds()).toEqual(["c1", "c2", "c4"]);
  expect(grid().get("A2")).toBe("Rent");
  expect(grid().get("B2")).toBe(10);

  ui.dispose();
});

// Bug: a header menu left open while the Grid gained a column deleted the column that moved into its old index.
test("a column header menu closes when the Grid gains a column outside the interface", async () => {
  const { Sap, ui, inst } = await start(TITLE_BOOK());
  const grid = () => Sap.grid(tableOf("s1"));

  inst.overlays.shadow.querySelector('[data-col="3"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 300, clientY: 10 }));
  await turn();
  expect(inst.chrome.topShadow.querySelector('[role="menu"]')).not.toBeNull();

  grid().insertCols("A", 1);
  await frame();

  expect(inst.chrome.topShadow.querySelector('[role="menu"]')).toBeNull();
  expect(colIds()).toHaveLength(5);
  expect(colIds()).toContain("c4");

  // The same menu also closes on a tab switch and on a restart.
  inst.overlays.shadow.querySelector('[data-col="1"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 10 }));
  expect(inst.chrome.topShadow.querySelector('[role="menu"]')).not.toBeNull();
  inst.chrome.bottomShadow.querySelector('[data-tab-id="s2"]').click();
  expect(inst.chrome.topShadow.querySelector('[role="menu"]')).toBeNull();

  inst.chrome.bottomShadow.querySelector('[data-tab-id="s1"]').click();
  inst.overlays.shadow.querySelector('[data-col="1"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 10 }));
  expect(inst.chrome.topShadow.querySelector('[role="menu"]')).not.toBeNull();
  ui.restart();
  expect(inst.chrome.topShadow.querySelector('[role="menu"]')).toBeNull();

  ui.dispose();
});

// Bug: a merge dialog left open while the Grid changed underneath merged stale coordinates over a coworker's cells.
test("the merge dialog closes when the Grid changes outside the interface", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const grid = () => Sap.grid(tableOf("s1"));

  selectB2ToC3(inst.editor.textarea);
  inst.chrome.topShadow.querySelector('[data-command="merge"]').click();
  await turn();
  expect(inst.chrome.topShadow.querySelector('[role="dialog"]')).not.toBeNull();

  grid().set("A1", "peer");
  expect(inst.chrome.topShadow.querySelector('[role="dialog"]')).toBeNull();

  ui.dispose();
});

// Bug: the rename input ignored blur, so clicking away left the input with no tab button and the typed name lost.
test("a tab rename commits on blur and on a cell click, and never opens over a cell edit that cannot commit", async () => {
  const { ui, inst } = await start();
  const textarea = inst.editor.textarea;
  const renameInput = () => inst.chrome.bottomShadow.querySelector("[data-tab-rename]");
  const tabBtn = (id) => inst.chrome.bottomShadow.querySelector(`[data-tab-id="${id}"]`);

  tabBtn("s1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  await turn();
  renameInput().value = "Q1";
  renameInput().dispatchEvent(new FocusEvent("blur"));
  expect(renameInput()).toBeNull();
  expect(tabLabels(inst)).toEqual(["Q1", "Totals"]);

  tabBtn("s1").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  renameInput().value = "Q1 budget";
  tableOf("s1").querySelector("tbody tr td").dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  expect(renameInput()).toBeNull();
  expect(tabLabels(inst)).toEqual(["Q1 budget", "Totals"]);

  ui.dispose();

  jest.spyOn(console, "warn").mockImplementation(() => {});
  const broken = await start(BOOK().replace("<td>Note</td>", '<td hidden bad>bad</td>'));
  const brokenTextarea = broken.inst.editor.textarea;
  typeInto(brokenTextarea, "9");
  press(brokenTextarea, "Enter");
  expect(broken.inst.editor.editing).toBe(true);
  broken.inst.chrome.bottomShadow.querySelector('[data-tab-id="s2"]').dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  await turn();
  expect(broken.inst.chrome.bottomShadow.querySelector("[data-tab-rename]")).toBeNull();

  broken.ui.dispose();
});

// Bug: right-clicking a cell inside a whole-column selection opened the cell menu, whose Delete row removed row 1.
test("a cell context menu inside a whole-column selection opens the column menu, and otherwise acts on the clicked row and column", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const grid = () => Sap.grid(tableOf("s1"));
  const cells = () => [...tableOf("s1").querySelectorAll("tbody tr")];
  const firstCell = () => cells()[0].children[0].textContent;
  expect(firstCell()).toBe("1");

  inst.overlays.shadow.querySelector('[data-col="2"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  expect(inst.chrome.nameBox.textContent).toBe("C1:C6");
  cells()[5].children[2].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 200 }));
  await turn();
  expect(inst.chrome.topShadow.querySelector('[data-menu-item="delete-row"]')).toBeNull();
  expect(inst.chrome.topShadow.querySelector('[data-menu-item="delete-cols"]')).not.toBeNull();
  inst.chrome.topShadow.querySelector('[data-menu-item="delete-cols"]').click();
  expect(grid().size.rows).toBe(6);
  expect(grid().size.cols).toBe(5);
  expect(firstCell()).toBe("1");

  // A range whose top row is row 1, right-clicked on row 3: the cell menu acts on the clicked row.
  const colB = () => cells().map((tr) => tr.children[1].textContent);
  expect(colB()).toEqual(["2", "3", "5", "", "", ""]);
  cells()[0].children[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  cells()[2].children[2].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  expect(inst.chrome.nameBox.textContent).toBe("A1:C3");
  cells()[2].children[2].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 200 }));
  inst.chrome.topShadow.querySelector('[data-menu-item="delete-row"]').click();
  expect(grid().size.rows).toBe(5);
  expect(colB()).toEqual(["2", "3", "", "", ""]);
  expect(firstCell()).toBe("1");

  ui.dispose();
});

// Bug: a header right-click while picking a reference on another tab committed the edit and deleted a row on the edited tab.
test("a header menu and resize drag do nothing while picking a reference on another tab", async () => {
  const { Sap, ui, inst } = await start();
  const textarea = inst.editor.textarea;
  const budget = () => Sap.grid(tableOf("s1"));
  const totals = () => Sap.grid(tableOf("s2"));

  typeInto(textarea, "=SUM(");
  inst.chrome.bottomShadow.querySelector('[data-tab-id="s2"]').click();
  expect(inst.tabs.activeId).toBe("s2");
  expect(inst.editor.editing).toBe(true);

  inst.overlays.shadow.querySelector('[data-row="0"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 20, clientY: 60 }));
  await turn();
  expect(inst.chrome.topShadow.querySelector('[role="menu"]')).toBeNull();
  inst.overlays.shadow.querySelector('[data-col-resize="1"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 200 }));
  window.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 260 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 260 }));
  await turn();

  expect(inst.editor.editing).toBe(true);
  expect(inst.tabs.activeId).toBe("s2");
  expect(budget().input("A1")).toBe("3");
  expect(budget().size).toEqual({ rows: 3, cols: 3 });
  expect(totals().size).toEqual({ rows: 1, cols: 2 });
  expect(tableOf("s1").querySelector('col[data-id="c2"]').getAttribute("style")).toBeNull();
  expect(tableOf("s2").querySelector('col[data-id="c2"]').getAttribute("style")).toBeNull();
  expect(budget().get("A2")).toBe(4);

  press(textarea, "Escape");
  ui.dispose();
});

// Bug: the merge dialog drew raw radios on the page, so a page stylesheet hid them and Enter on a choice did nothing.
test("the merge dialog's choices are shadow-root controls that Enter picks under a page stylesheet hiding inputs", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const grid = () => Sap.grid(tableOf("s1"));
  const style = document.createElement("style");
  style.textContent = "input { display: none }";
  document.head.append(style);

  selectB2ToC3(inst.editor.textarea);
  inst.chrome.topShadow.querySelector('[data-command="merge"]').click();
  await turn();
  const dialog = inst.chrome.topShadow.querySelector('[role="dialog"]');
  expect(dialog).not.toBeNull();

  const choices = [...dialog.querySelectorAll('[role="radio"]')];
  expect(choices).toHaveLength(4);
  expect(choices.map((c) => c.localName)).toEqual(["button", "button", "button", "button"]);
  expect(choices[0].getRootNode()).not.toBe(document);
  expect(choices[0].getAttribute("aria-checked")).toBe("true");

  press(choices[1], "Enter");
  expect(inst.chrome.topShadow.querySelector('[role="dialog"]')).toBeNull();
  expect(grid().cell("B2").span).toEqual({ rows: 2, cols: 2 });
  expect(grid().get("B2")).toBe(4);

  ui.dispose();
});

// Bug: Shift+F10 or the ContextMenu key on a focused tab button opened nothing, so keyboard users could not reach tab actions.
test("Shift+F10 and the ContextMenu key on a focused tab button open that tab's menu", async () => {
  const { ui, inst } = await start();
  const tabBtn = (id) => inst.chrome.bottomShadow.querySelector(`[data-tab-id="${id}"]`);

  tabBtn("s2").dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }));
  await turn();
  expect(inst.chrome.topShadow.querySelector('[data-menu-item="duplicate-tab"]')).not.toBeNull();
  expect(inst.chrome.topShadow.querySelector('[role="menu"]').getAttribute("aria-label")).toContain("Totals");
  inst.menu.close();

  tabBtn("s1").dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true, cancelable: true }));
  expect(inst.chrome.topShadow.querySelector('[role="menu"]').getAttribute("aria-label")).toContain("Budget");

  ui.dispose();
});

// Bug: tabs authored without data-pos kept an empty order key, so a duplicate landed last and a move left did nothing.
test("duplicating the first tab places the copy second and moving the second tab left makes it first when tabs have no data-pos", async () => {
  const first = await start(NO_POS_BOOK());
  expect(tabLabels(first.inst)).toEqual(["One", "Two", "Three"]);
  openTabMenu(first.inst, 0);
  await turn();
  first.inst.chrome.topShadow.querySelector('[data-menu-item="duplicate-tab"]').click();
  expect(tabLabels(first.inst)).toEqual(["One", "Copy of One", "Two", "Three"]);
  first.ui.dispose();

  const second = await start(NO_POS_BOOK());
  openTabMenu(second.inst, 1);
  await turn();
  second.inst.chrome.topShadow.querySelector('[data-menu-item="move-tab-left"]').click();
  expect(tabLabels(second.inst)).toEqual(["Two", "One", "Three"]);
  second.ui.dispose();
});

// Bug: the toolbar scanned every selected cell on every repaint, so Select All on a big sheet cost one grid.cell call per cell.
test("a repaint with 200 rows and 26 columns selected asks the Grid for fewer than 100 cells", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const grid = Sap.grid(tableOf("s1"));
  const block = Array.from({ length: 200 }, (_, r) => Array.from({ length: 26 }, (_, c) => r * 26 + c));
  grid.setRange("A1", block, { grow: true });
  await frame();

  press(inst.editor.textarea, "a", { metaKey: true });
  expect(inst.chrome.nameBox.textContent).toBe("A1:Z200");

  const spy = jest.spyOn(grid, "cell");
  window.dispatchEvent(new Event("resize"));
  await frame();

  expect(spy.mock.calls.length).toBeLessThan(100);
  ui.dispose();
}, 30000);

const MERGED_BOOK = () => `<main sap plugins="grid"><div id="scroller" style="position:relative;overflow:auto"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td rowspan="2">Title</td><td n v="1">1</td></tr>
<tr data-id="r2" data-pos="l"><td hidden></td><td n v="2">2</td></tr>
<tr data-id="r3" data-pos="t"><td>a</td><td n v="3">3</td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit">{"rev":1}</script>
</div></div></main>`;

// Bug: a selection rebuilt after an undo anchored on the covered half of a vertical merge, so typing into it was refused.
test("typing into the selection an undo leaves beside a vertical merge commits without a covered-position notice", async () => {
  const { Sap, ui, inst } = await start(MERGED_BOOK());
  const grid = () => Sap.grid(tableOf("s1"));
  const textarea = inst.editor.textarea;
  const cells = () => [...tableOf("s1").querySelectorAll("tbody tr")];
  expect(grid().cell("A1").span).toEqual({ rows: 2, cols: 1 });

  cells()[1].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  cells()[2].children[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  expect(inst.chrome.nameBox.textContent).toBe("A1:B3");

  press(textarea, "b", { metaKey: true });
  await turn();
  press(textarea, "z", { metaKey: true });
  expect(inst.chrome.noticeBar.hidden).toBe(true);

  typeInto(textarea, "hello");
  press(textarea, "Enter");
  expect(inst.chrome.noticeBar.hidden).toBe(true);
  expect(grid().get("A1:B3").flat()).toContain("hello");

  ui.dispose();
});

const C8B_SLICE_BOOK = () => `<main sap plugins="grid"><div id="scroller" style="position:relative;overflow:auto"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"><col data-id="c3" data-pos="t"><col data-id="c4" data-pos="x"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td></td><td></td><td></td><td></td></tr>
<tr data-id="r2" data-pos="l"><td></td><td n v="1">1</td><td n f="=B2*2" v="2">2</td><td></td></tr>
<tr data-id="r3" data-pos="t"><td></td><td n v="2">2</td><td></td><td></td></tr>
<tr data-id="r4" data-pos="v"><td></td><td></td><td></td><td></td></tr>
<tr data-id="r5" data-pos="x"><td></td><td></td><td></td><td></td></tr>
<tr data-id="r6" data-pos="z"><td></td><td></td><td></td><td></td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit">{"rev":1}</script>
</div></div></main>`;

function readBlobText(blob) {
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

// Bug: fill-handle drag or double-click missed series/formula shifting, find missed evaluated matches, status bar miscalculated aggregates, CSV import evaluated formulas, or multi-cell writes split across undo steps.
test("c8b slice: drag fill B2:B3 to B6, double-click fill C2 formulas, find '4', check status bar on B2:B6, import and export CSV, and undo each write in one step", async () => {
  const { Sap, ui, inst } = await start(C8B_SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const budget = () => Sap.grid(tableOf("s1"));
  const rows = () => [...tableOf("s1").querySelectorAll("tbody tr")];

  // Select B2:B3 and drag the fill handle down to B6 -> 3, 4, 5.
  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown");
  press(textarea, "ArrowDown", { shiftKey: true });
  expect(inst.chrome.nameBox.value).toBe("B2:B3");

  const fillHandle = inst.overlays.shadow.querySelector("[data-fill-handle]");
  const fillPreview = inst.overlays.shadow.querySelector("[data-fill-preview]");
  expect(fillHandle.hidden).toBe(false);

  fillHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 150, clientY: 70 }));
  await turn();
  rows()[5].children[1].dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 152, clientY: 160 }));
  expect(fillPreview.hidden).toBe(false);
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 152, clientY: 160 }));
  await turn();

  expect(fillPreview.hidden).toBe(true);
  expect(budget().get("B2:B6")).toEqual([[1], [2], [3], [4], [5]]);
  expect(inst.chrome.nameBox.value).toBe("B2:B6");

  // Select C2 (=B2*2) and double-click its fill handle -> C3:C6 hold =B3*2 .. =B6*2.
  rows()[1].children[2].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(inst.chrome.nameBox.value).toBe("C2");
  fillHandle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  await turn();

  expect([3, 4, 5, 6].map((r) => budget().input(`C${r}`))).toEqual(["=B3*2", "=B4*2", "=B5*2", "=B6*2"]);
  expect(budget().get("C2:C6")).toEqual([[2], [4], [6], [8], [10]]);

  // Cmd+F "4" finds C3 (shown 4) then Enter steps to B5 (4), Escape closes and returns focus.
  press(textarea, "f", { metaKey: true });
  await turn();
  const findBar = inst.chrome.topShadow.querySelector("[data-sheet-find]");
  const findInput = findBar.querySelector("[data-find-input]");
  const findCount = findBar.querySelector("[data-find-count]");
  expect(findBar.hidden).toBe(false);

  typeInto(findInput, "4");
  expect(findCount.textContent).toBe("1 of 2");
  expect(inst.chrome.nameBox.value).toBe("C3");
  press(findInput, "Enter");
  expect(findCount.textContent).toBe("2 of 2");
  expect(inst.chrome.nameBox.value).toBe("B5");
  press(findInput, "Escape");
  expect(findBar.hidden).toBe(true);

  // Select B2:B6 -> status bar shows "Sum 15 · Average 3 · Count 5".
  rows()[1].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  rows()[5].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(inst.chrome.nameBox.value).toBe("B2:B6");
  expect(inst.chrome.statusText.textContent).toBe("Sum 15 · Average 3 · Count 5");

  // Import a CSV into a new tab through the preview dialog.
  inst.chrome.topShadow.querySelector('[data-command="import"]').click();
  await turn();
  inst.chrome.topShadow.querySelector('[data-menu-item="import-delimited"]').click();
  const fileInput = inst.chrome.topShadow.querySelector("[data-csv-file-input]");
  expect(fileInput).not.toBeNull();
  const csvFile = new File(["Item,Qty\nApples,12\nPears,=1+1"], "Inventory.csv", { type: "text/csv" });
  Object.defineProperty(fileInput, "files", { configurable: true, value: [csvFile] });
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  await turn();
  await turn();

  const importDlg = inst.chrome.topShadow.querySelector('[role="dialog"]');
  expect(importDlg).not.toBeNull();
  importDlg.querySelector('button[type="submit"]').click();

  expect(tabLabels(inst)).toEqual(["Budget", "Inventory"]);
  const invId = inst.tabs.activeId;
  const invGrid = () => Sap.grid(tableOf(invId));
  expect(invGrid().get("A1:B3")).toEqual([
    ["Item", "Qty"],
    ["Apples", 12],
    ["Pears", "=1+1"],
  ]);

  // Export that tab as CSV with formula-injection protection and Blob URL revocation.
  const prevCreateObj = window.URL.createObjectURL;
  const prevRevokeObj = window.URL.revokeObjectURL;
  let exportedBlob = null;
  let downloadName = "";
  window.URL.createObjectURL = jest.fn((b) => {
    exportedBlob = b;
    return "blob:https://example.com/inventory";
  });
  window.URL.revokeObjectURL = jest.fn();
  const clickSpy = jest.spyOn(window.HTMLAnchorElement.prototype, "click").mockImplementation(function () {
    downloadName = this.download;
  });

  try {
    // Safari aborts the download when the Blob URL is revoked before WebKit reads the Blob.
    const scheduled = [];
    const timerSpy = jest.spyOn(globalThis, "setTimeout").mockImplementation((fn, ms) => {
      scheduled.push({ fn, ms });
      return 0;
    });
    inst.chrome.topShadow.querySelector('[data-command="import"]').click();
    inst.chrome.topShadow.querySelector('[data-menu-item="export-csv"]').click();
    timerSpy.mockRestore();
    expect(downloadName).toBe("Inventory.csv");
    expect(window.URL.revokeObjectURL).not.toHaveBeenCalled();
    const revoke = scheduled.find((t) => t.ms === 40000);
    expect(revoke).toBeTruthy();
    revoke.fn();
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith("blob:https://example.com/inventory");
    const exportedText = await readBlobText(exportedBlob);
    expect(exportedText.split("\r\n").slice(0, 3)).toEqual(
      ["Item,Qty", "Apples,12", "Pears,'=1+1"].map((row) => `${row}${",".repeat(24)}`),
    );
  } finally {
    clickSpy.mockRestore();
    window.URL.createObjectURL = prevCreateObj;
    window.URL.revokeObjectURL = prevRevokeObj;
  }

  // Each write (CSV import on Inventory, autofill C3:C6 on Budget, drag fill B4:B6 on Budget) is one undo step.
  press(textarea, "z", { metaKey: true });
  expect(invGrid().get("A1:B3")).toEqual([
    [null, null],
    [null, null],
    [null, null],
  ]);

  inst.chrome.bottomShadow.querySelector('[data-tab-id="s1"]').click();
  press(textarea, "z", { metaKey: true });
  expect(budget().get("C2:C6")).toEqual([[2], [null], [null], [null], [null]]);

  press(textarea, "z", { metaKey: true });
  expect(budget().get("B2:B6")).toEqual([[1], [2], [null], [null], [null]]);

  ui.dispose();
});

// Bug: Ctrl+D/Ctrl+R stepped numbers as a series instead of copying with shifted formulas, Ctrl+Enter wrote only the active cell, fill handle stayed visible while editing or on whole-axis selection, or cutting a merge threw instead of showing sapjs's notice.
test("Ctrl+D, Ctrl+R, context-menu Fill and Ctrl+Enter each write shifted formulas in one undo step, hide the fill handle on whole-axis or edit states, and show sapjs's notice when fill cuts a merge", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = () => Sap.grid(tableOf("s1"));
  const fillHandle = inst.overlays.shadow.querySelector("[data-fill-handle]");

  grid().set("A2", 10);
  grid().set("A3", 20);
  grid().set("A4", 30);
  grid().set("B2", "=A2+1");
  grid().set("C2", 7);
  await frame();

  // Select B2:C4 and press Cmd+D -> plain copy (7 stays 7, no series) with formulas shifted per row, 1 undo step.
  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown");
  press(textarea, "ArrowRight", { shiftKey: true });
  press(textarea, "ArrowDown", { shiftKey: true });
  press(textarea, "ArrowDown", { shiftKey: true });
  expect(inst.chrome.nameBox.value).toBe("B2:C4");

  press(textarea, "d", { metaKey: true });
  await turn();
  expect([2, 3, 4].map((r) => grid().input(`B${r}`))).toEqual(["=A2+1", "=A3+1", "=A4+1"]);
  expect(grid().get("B2:C4")).toEqual([
    [11, 7],
    [21, 7],
    [31, 7],
  ]);
  press(textarea, "z", { metaKey: true });
  expect(grid().get("B3:C4")).toEqual([
    [5, 10],
    [null, null],
  ]);

  // Select B2:D2 and press Cmd+R -> shifts formula horizontally in 1 undo step.
  const rows = () => [...tableOf("s1").querySelectorAll("tbody tr")];
  rows()[1].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  rows()[1].children[3].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(inst.chrome.nameBox.value).toBe("B2:D2");
  press(textarea, "r", { metaKey: true });
  expect(["B2", "C2", "D2"].map((ref) => grid().input(ref))).toEqual(["=A2+1", "=B2+1", "=C2+1"]);
  press(textarea, "z", { metaKey: true });
  expect(grid().get("C2:D2")).toEqual([[7, null]]);

  // Cell context menu exposes Fill down and Fill right.
  rows()[1].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  rows()[2].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  rows()[2].children[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 80 }));
  await turn();
  expect(inst.chrome.topShadow.querySelector('[data-menu-item="fill-right"]')).not.toBeNull();
  inst.chrome.topShadow.querySelector('[data-menu-item="fill-down"]').click();
  expect(grid().input("B3")).toBe("=A3+1");
  press(textarea, "z", { metaKey: true });

  // Select B2:C3, start editing "=A2*10", verify fill handle hides while editing, and press Cmd+Enter -> 1 undo step.
  rows()[1].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  rows()[2].children[2].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(fillHandle.hidden).toBe(false);

  typeInto(textarea, "=A2*10");
  expect(fillHandle.hidden).toBe(true);
  press(textarea, "Enter", { metaKey: true });
  expect(grid().input("B2")).toBe("=A2*10");
  expect(grid().input("C2")).toBe("=B2*10");
  expect(grid().input("B3")).toBe("=A3*10");
  expect(grid().input("C3")).toBe("=B3*10");
  expect(grid().get("B2:C3")).toEqual([
    [100, 1000],
    [200, 2000],
  ]);

  press(textarea, "z", { metaKey: true });
  expect(grid().input("B2")).toBe("=A2+1");
  expect(grid().get("C2")).toBe(7);

  // Fill handle hides on whole-column selection.
  inst.overlays.shadow.querySelector('[data-col="1"]').dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  expect(fillHandle.hidden).toBe(true);

  // Dragging fill into a partial merge is refused with sapjs's covered-cell notice.
  grid().merge("B4:C4");
  await frame();
  rows()[2].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(inst.chrome.nameBox.value).toBe("B3");
  fillHandle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 150, clientY: 90 }));
  rows()[3].children[1].dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 150, clientY: 120 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 150, clientY: 120 }));
  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(inst.chrome.noticeBar.textContent).toContain(
    "Fill can't cover only part of a merged cell. Unmerge it, or fill a range that holds all of it.",
  );

  ui.dispose();
});

// Bug: status bar formatted sums as dates when the active cell had a date format, failed to count text-only selections, showed aggregates on single cells or merges, or scanned over 100,000 cells.
test("status bar formats numeric aggregates in the active cell's number format, shows Count on text-only selections, and stays blank on single cells, single merges, or >100,000 cells", async () => {
  const { Sap, ui, inst } = await start(SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));

  // Single cell shows nothing.
  expect(inst.chrome.statusText.textContent).toBe("");

  // Currency active cell formats Sum and Average as currency.
  grid.format("B2", { fmt: "$#,##0.00" });
  await frame();
  selectB2ToC3(textarea);
  expect(inst.chrome.statusText.textContent).toBe("Sum $22.00 · Average $5.50 · Count 4");

  // Date active cell falls back to automatic number formatting for Sum and Average.
  grid.format("B2", { fmt: "m/d/yyyy" });
  await frame();
  expect(inst.chrome.statusText.textContent).toBe("Sum 22 · Average 5.5 · Count 4");

  // Single merged range shows nothing.
  grid.merge("B2:C3", { keep: "top-left" });
  await frame();
  expect(inst.chrome.statusText.textContent).toBe("");

  // Text-only multi-cell selection shows "Count N", and empty selection shows "".
  grid.set("D1", "Alpha");
  grid.set("E1", "Beta");
  await frame();
  const rows = [...tableOf("s1").querySelectorAll("tbody tr")];
  rows[0].children[3].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  rows[0].children[5].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(inst.chrome.statusText.textContent).toBe("Count 2");

  rows[5].children[3].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  rows[5].children[5].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(inst.chrome.statusText.textContent).toBe("");

  // Selection over 100,000 cells (1001 rows x 100 cols = 100,100 cells) shows nothing without scanning cells.
  grid.insertRows(6, 995, "after");
  grid.insertCols("F", 94, "after");
  await frame();
  const cellSpy = jest.spyOn(grid, "cell");
  press(textarea, "a", { metaKey: true });
  expect(inst.chrome.nameBox.value).toBe("A1:CV1001");
  expect(inst.chrome.statusText.textContent).toBe("");
  expect(cellSpy.mock.calls.length).toBeLessThan(20);

  ui.dispose();
}, 30000);

// Bug: nameBox stayed a static label or Ctrl+J failed to focus it, Enter failed to switch tabs or select ranges, or Escape lost the current coordinate.
test("Cmd+J focuses the name box input, Enter navigates to cells, ranges and other tabs, Escape restores the coordinate, and invalid refs show a notice", async () => {
  const { ui, inst } = await start();
  const textarea = inst.editor.textarea;
  const nameBox = inst.chrome.nameBox;

  expect(nameBox.localName).toBe("input");
  press(textarea, "j", { metaKey: true });
  expect(inst.chrome.topShadow.activeElement).toBe(nameBox);

  nameBox.value = "C2";
  press(nameBox, "Enter");
  await turn();
  expect(ui.selection).toEqual({
    tab: "s1",
    anchor: { row: "r2", col: "c3" },
    focus: { row: "r2", col: "c3" },
  });
  expect(nameBox.value).toBe("C2");

  nameBox.focus();
  nameBox.value = "Totals!A1:B1";
  press(nameBox, "Enter");
  expect(inst.tabs.activeId).toBe("s2");
  expect(nameBox.value).toBe("A1:B1");

  nameBox.focus();
  nameBox.value = "typed-draft";
  press(nameBox, "Escape");
  expect(nameBox.value).toBe("A1:B1");
  expect(inst.chrome.noticeBar.hidden).toBe(true);

  nameBox.focus();
  nameBox.value = "Missing!A1";
  press(nameBox, "Enter");
  expect(inst.tabs.activeId).toBe("s2");
  expect(inst.chrome.noticeBar.hidden).toBe(false);

  ui.dispose();
});

// Bug: link chip or Cmd+click opened javascript:/data: schemes, failed on HYPERLINK literals or mailto:, left >60-char URLs untruncated, or wrote <a> nodes into [sheet-workbook].
test("link chip and Cmd+click open only http, https and mailto URLs or HYPERLINK string literals, truncate the chip text to 60 chars, and never write links into [sheet-workbook]", async () => {
  const { Sap, root, ui, inst } = await start(SLICE_BOOK());
  const grid = Sap.grid(tableOf("s1"));
  const openSpy = jest.spyOn(window, "open").mockImplementation(() => null);

  const longHttps = "https://example.com/documentation/spreadsheets/reference/functions/lookup-and-index";
  grid.set("A1", longHttps);
  grid.set("A2", "mailto:team@example.com");
  grid.set("A3", '=HYPERLINK("http://example.org/guide", "Guide")');
  grid.set("B1", "javascript:alert(1)");
  grid.set("B2", '=HYPERLINK("javascript:alert(1)", "Click")');
  grid.set("B3", "data:text/html,<script>alert(1)</script>");
  await frame();

  const chip = inst.overlays.shadow.querySelector("[data-sheet-link-chip]");
  const chipUrl = chip.querySelector("[data-link-url]");
  const chipOpen = chip.querySelector("[data-link-open]");
  const rows = [...tableOf("s1").querySelectorAll("tbody tr")];

  // Active cell A1: >60-char https URL shows truncated 60-char chip label and safe Open link, with zero <a> inside [sheet-workbook].
  expect(chip.hidden).toBe(false);
  expect(chipUrl.textContent).toHaveLength(60);
  expect(chipOpen.getAttribute("href")).toBe(longHttps);
  expect(chipOpen.getAttribute("target")).toBe("_blank");
  expect(chipOpen.getAttribute("rel")).toBe("noopener noreferrer");
  expect(root.querySelectorAll("a")).toHaveLength(0);

  // Cmd+click on A2 (mailto:) and A3 (HYPERLINK string literal) opens each URL.
  rows[1].children[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true }));
  expect(openSpy).toHaveBeenLastCalledWith("mailto:team@example.com", "_blank", "noopener,noreferrer");
  expect(chip.hidden).toBe(false);
  expect(chipUrl.textContent).toBe("mailto:team@example.com");

  rows[2].children[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true }));
  expect(openSpy).toHaveBeenLastCalledWith("http://example.org/guide", "_blank", "noopener,noreferrer");
  expect(chip.hidden).toBe(false);
  expect(chipUrl.textContent).toBe("http://example.org/guide");

  // Unsafe schemes (javascript:, HYPERLINK("javascript:..."), data:) never show the chip and never open on Cmd+click.
  openSpy.mockClear();
  for (const r of [0, 1, 2]) {
    rows[r].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true }));
    expect(chip.hidden).toBe(true);
  }
  expect(openSpy).not.toHaveBeenCalled();

  ui.dispose();
});

// Bug: one failed lazy import() left the cached promise rejected for the life of the page, so the tool stayed dead forever.
test("lazyModule resets its cache on a failed load, reports the failure once, and succeeds on the next try", async () => {
  const { lazyModule } = await import("../../../src/sheet/interface.js");
  const failures = [];
  let attempt = 0;
  const tool = lazyModule(
    () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new Error("offline")) : Promise.resolve({ ready: true });
    },
    () => failures.push("notice"),
  );

  expect(await tool.load()).toBeNull();
  expect(failures).toEqual(["notice"]);
  expect(tool.peek()).toBeNull();

  expect(await tool.load()).toEqual({ ready: true });
  expect(tool.peek()).toEqual({ ready: true });
  expect(await tool.load()).toEqual({ ready: true });
  expect(failures).toEqual(["notice"]);
});

// Bug: a formatting key pressed before its module arrived applied to whatever cell was selected when the module landed.
test("a lazy formatting shortcut that lands after the selection moved drops the action instead of bolding the new cell", async () => {
  const { Sap, ui, inst } = await start();
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));

  press(textarea, "ArrowDown", { shiftKey: true });
  expect(inst.chrome.nameBox.value).toBe("A1:A2");

  press(textarea, "b", { metaKey: true });
  press(textarea, "ArrowRight");
  await turn();

  expect(grid.cell("A1").style ?? null).toBeNull();
  expect(grid.cell("B1").style ?? null).toBeNull();

  press(textarea, "b", { metaKey: true });
  expect(grid.cell("B1").style).toContain("font-weight:bold");

  ui.dispose();
});

// Bug: two Import clicks before the CSV module arrived opened the menu and immediately closed it again.
test("clicking Import twice before the CSV module arrives leaves the menu open once", async () => {
  const { ui, inst } = await start();
  const importBtn = inst.chrome.topShadow.querySelector('[data-command="import"]');

  importBtn.click();
  importBtn.click();
  await turn();

  expect(inst.chrome.topShadow.querySelector('[data-menu-item="import-delimited"]')).not.toBeNull();
  importBtn.click();
  expect(inst.chrome.topShadow.querySelector('[data-menu-item="import-delimited"]')).toBeNull();

  ui.dispose();
});

const FIND_EDIT_BOOK = () => `<main sap plugins="grid"><div id="scroller" style="position:relative;overflow:auto"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Budget</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td></td><td></td></tr>
<tr data-id="r2" data-pos="l"><td></td><td></td></tr>
</tbody></table></section>
<section item data-id="s2" data-pos="l"><h2 bind="name">Totals</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td>match</td><td></td></tr>
<tr data-id="r2" data-pos="l"><td></td><td></td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit">{"rev":1}</script>
</div></div></main>`;

// Bug: clicking a Find match while editing left the editor bound to the old tab and the old cell.
test("stepping Find while editing commits the edit into the cell being edited before the jump", async () => {
  const { Sap, ui, inst } = await start(FIND_EDIT_BOOK());
  const textarea = inst.editor.textarea;
  const budget = Sap.grid(tableOf("s1"));

  press(textarea, "f", { metaKey: true });
  await turn();
  const findBar = inst.chrome.topShadow.querySelector("[data-sheet-find]");
  const findInput = findBar.querySelector("[data-find-input]");
  typeInto(findInput, "match");
  expect(inst.tabs.activeId).toBe("s2");

  inst.chrome.bottomShadow.querySelector('[data-tab-id="s1"]').click();
  expect(inst.tabs.activeId).toBe("s1");
  typeInto(textarea, "draft");
  expect(inst.editor.editing).toBe(true);

  findBar.querySelector("[data-find-next]").click();
  expect(budget.get("A1")).toBe("draft");
  expect(inst.editor.editing).toBe(false);
  expect(inst.tabs.activeId).toBe("s2");

  ui.dispose();
});

// Bug: the status bar rounded a sum to 12 significant digits, showing cents that were never in the cells.
test("the status bar keeps every cent of a sum past 12 significant digits", async () => {
  const { Sap, ui, inst } = await start();
  const grid = Sap.grid(tableOf("s1"));
  grid.set("A1", 10000000000.12);
  grid.set("A2", 0.05);
  grid.format("A1:A2", { fmt: "$#,##0.00" });
  await frame();

  const rows = () => [...tableOf("s1").querySelectorAll("tbody tr")];
  rows()[0].children[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  rows()[1].children[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

  expect(inst.chrome.nameBox.value).toBe("A1:A2");
  expect(inst.chrome.statusText.textContent).toContain("Sum $10,000,000,000.17");

  ui.dispose();
});

// Bug: delegating the tab long-press cancel to pointerout cancelled the press when the finger crossed onto the tab's label.
test("a touch long-press on a tab that slides onto its own label still opens the tab menu", async () => {
  const { ui, inst } = await start();
  const tabBtn = inst.chrome.bottomShadow.querySelector('[role="tab"]');
  const label = tabBtn.querySelector("span");

  tabBtn.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 12, clientY: 400 }));
  tabBtn.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, cancelable: true, relatedTarget: label }));
  await new Promise((resolve) => setTimeout(resolve, 480));
  await turn();

  expect(inst.chrome.topShadow.querySelector('[data-menu-item="rename-tab"]')).not.toBeNull();

  ui.dispose();
});

// Bug: the name box kept the old coordinate when toolbar Undo moved the selection while the box had focus.
test("the name box follows the selection after a toolbar Undo while it has focus", async () => {
  const { Sap, ui, inst } = await start();
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));

  press(textarea, "ArrowRight");
  press(textarea, "ArrowDown");
  expect(inst.chrome.nameBox.value).toBe("B2");
  typeInto(textarea, "5");
  press(textarea, "Enter");
  expect(grid.get("B2")).toBe(5);
  await frame();
  expect(inst.chrome.nameBox.value).toBe("B3");

  inst.chrome.nameBox.focus();
  inst.chrome.topShadow.querySelector('[data-command="undo"]').click();
  expect(grid.get("B2")).toBe(8);
  expect(inst.chrome.nameBox.value).toBe("B2");

  ui.dispose();
});

// Bug: lazy command and fill modules either loaded eagerly at boot or swallowed the first shortcut key that triggered import().
test("pressing a lazy fill or formatting shortcut as the first action loads its module on demand and applies the key once loaded", async () => {
  const { Sap, ui, inst } = await start();
  const textarea = inst.editor.textarea;
  const grid = Sap.grid(tableOf("s1"));

  press(textarea, "ArrowDown", { shiftKey: true });
  expect(inst.chrome.nameBox.value).toBe("A1:A2");
  expect(grid.get("A1:A2")).toEqual([[3], [4]]);

  // First Cmd+D triggers import("./fill.js") asynchronously, then applies Fill Down once loaded.
  press(textarea, "d", { metaKey: true });
  expect(grid.get("A2")).toBe(4);
  await turn();
  expect(grid.get("A2")).toBe(3);

  // First Cmd+I triggers import("./format-commands.js") asynchronously, then applies Italic once loaded.
  press(textarea, "i", { metaKey: true });
  expect(grid.cell("A1").style).toBeNull();
  await turn();
  expect(grid.cell("A1").style).toContain("font-style:italic");

  ui.dispose();
});

const C8C_SLICE_BOOK = () => `<main sap plugins="grid"><div id="scroller" style="position:relative;overflow:auto"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Data</h2><table grid><colgroup><col data-id="c1" data-pos="F"><col data-id="c2" data-pos="P"><col data-id="c3" data-pos="Z"></colgroup>
<thead><tr data-id="r1" data-pos="F"><td>Item</td><td>Val</td><td>Echo</td></tr></thead>
<tbody>
<tr data-id="r2" data-pos="J"><td>first</td><td n v="30">30</td><td n f="=B2" v="30">30</td></tr>
<tr data-id="r3" data-pos="P"><td>second</td><td>apple</td><td>tag-apple</td></tr>
<tr data-id="r4" data-pos="V"><td>third</td><td n v="10">10</td><td>tag-10</td></tr>
<tr data-id="r5" data-pos="b"><td>fourth</td><td></td><td>tag-empty</td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit>{"rev":1}</script>
</div></div></main>`;

// Bug: Sort sheet moved frozen header rows or left other columns and row formulas behind, Ctrl+Z failed to restore the order in one step, or Sort range touched rows and columns outside the selection.
test("c8c slice: Sort sheet A to Z on column B keeps frozen row 1, moves all columns and shifts =B2 with its row, Ctrl+Z restores the order, and Sort range Z to A on A2:B3 moves only A2:B3", async () => {
  const { Sap, ui, inst } = await start(C8C_SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = () => Sap.grid(tableOf("s1"));
  expect(grid().issues).toEqual([]);

  // Right-click column B's header and choose "Sort sheet A to Z".
  inst.overlays.shadow
    .querySelector('[data-col="1"]')
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 140, clientY: 10 }));
  await turn();
  const sortSheetAsc = inst.chrome.topShadow.querySelector('[data-menu-item="sort-sheet-asc"]');
  expect(sortSheetAsc?.textContent).toContain("Sort sheet A to Z");
  sortSheetAsc.click();

  // Frozen row 1 stays; B2:B5 come out 10, 30, "apple", empty; cols A and C move with their rows; =B2 moved to C3 as =B3 = 30.
  expect(tableOf("s1").tHead?.rows.length).toBe(1);
  expect(grid().get("A1:C5")).toEqual([
    ["Item", "Val", "Echo"],
    ["third", 10, "tag-10"],
    ["first", 30, 30],
    ["second", "apple", "tag-apple"],
    ["fourth", null, "tag-empty"],
  ]);
  expect(grid().input("C3")).toBe("=B3");
  expect(grid().get("C3")).toBe(30);

  // Cmd+Z puts the original row order and =B2 back in one undo step.
  press(textarea, "z", { metaKey: true });
  expect(grid().get("A1:C5")).toEqual([
    ["Item", "Val", "Echo"],
    ["first", 30, 30],
    ["second", "apple", "tag-apple"],
    ["third", 10, "tag-10"],
    ["fourth", null, "tag-empty"],
  ]);
  expect(grid().input("C2")).toBe("=B2");

  // Select A2:B3 with active cell B2 (mousedown B2, shift+mousedown A3) and "Sort range Z to A" from the cell menu.
  const bodyRows = () => [...tableOf("s1").querySelectorAll("tbody tr")];
  bodyRows()[0].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  bodyRows()[1].children[0].dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }),
  );
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(inst.chrome.nameBox.value).toBe("A2:B3");

  bodyRows()[0].children[0].dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 60 }),
  );
  await turn();
  const sortRangeDesc = inst.chrome.topShadow.querySelector('[data-menu-item="sort-range-desc"]');
  expect(sortRangeDesc?.textContent).toContain("Sort range Z to A");
  sortRangeDesc.click();

  // Only A2:B3 moved ("apple" before 30 in Z to A); rows 4:5 and column C stayed in their rows.
  expect(grid().get("A1:C5")).toEqual([
    ["Item", "Val", "Echo"],
    ["second", "apple", "apple"],
    ["first", 30, "tag-apple"],
    ["third", 10, "tag-10"],
    ["fourth", null, "tag-empty"],
  ]);
  expect(grid().input("C2")).toBe("=B2");

  press(textarea, "z", { metaKey: true });
  expect(grid().get("A2:C3")).toEqual([
    ["first", 30, 30],
    ["second", "apple", "tag-apple"],
  ]);

  ui.dispose();
});

const UNFROZEN_SORT_BOOK = () => `<main sap plugins="grid"><div id="scroller" style="position:relative;overflow:auto"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Plain</h2><table grid><colgroup><col data-id="c1" data-pos="F"><col data-id="c2" data-pos="P"><col data-id="c3" data-pos="Z"></colgroup>
<tbody>
<tr data-id="r1" data-pos="F"><td>k2</td><td n v="20">20</td><td>x</td></tr>
<tr data-id="r2" data-pos="P"><td>k1</td><td n v="5">5</td><td>y</td></tr>
<tr data-id="r3" data-pos="Z"><td>k3</td><td n v="15">15</td><td>z</td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit>{"rev":1}</script>
</div></div></main>`;

// Bug: column header menu showed Sort range when the full sheet was selected or omitted it for one column, 1-row selections left Sort range enabled, or Sort sheet skipped row 1 when nothing was frozen.
test("column and cell menus disable Sort range on one row, offer Sort range on partial-sheet column selections, sort every row when none are frozen, and send cols null on full-width ranges", async () => {
  const { Sap, ui, inst } = await start(UNFROZEN_SORT_BOOK());
  const grid = () => Sap.grid(tableOf("s1"));
  const rows = () => [...tableOf("s1").querySelectorAll("tbody tr")];

  // Single-row selection (A1:C1): cell menu shows Sort range items disabled.
  rows()[0].children[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  rows()[0].children[2].dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }),
  );
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(inst.chrome.nameBox.value).toBe("A1:C1");

  rows()[0].children[1].dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 80, clientY: 40 }),
  );
  await turn();
  expect(inst.chrome.topShadow.querySelector('[data-menu-item="sort-range-asc"]')?.getAttribute("aria-disabled")).toBe(
    "true",
  );
  expect(inst.chrome.topShadow.querySelector('[data-menu-item="sort-range-desc"]')?.getAttribute("aria-disabled")).toBe(
    "true",
  );
  inst.menu.close();

  // Single-column header menu on B (not full sheet): offers Sort range A to Z and sorts only column B.
  inst.overlays.shadow
    .querySelector('[data-col="1"]')
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 140, clientY: 10 }));
  expect(inst.chrome.topShadow.querySelector('[data-menu-item="sort-sheet-asc"]')).not.toBeNull();
  const colRangeAsc = inst.chrome.topShadow.querySelector('[data-menu-item="sort-range-asc"]');
  expect(colRangeAsc).not.toBeNull();
  expect(colRangeAsc.getAttribute("aria-disabled")).toBeNull();
  colRangeAsc.click();

  expect(grid().get("A1:C3")).toEqual([
    ["k2", 5, "x"],
    ["k1", 15, "y"],
    ["k3", 20, "z"],
  ]);

  // Select all columns A:C via headers: full-sheet whole-column menu omits Sort range, and Sort sheet Z to A sorts every row including row 1.
  inst.overlays.shadow
    .querySelector('[data-col="0"]')
    .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  inst.overlays.shadow
    .querySelector('[data-col="2"]')
    .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  inst.overlays.shadow
    .querySelector('[data-col="1"]')
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 140, clientY: 10 }));
  expect(inst.chrome.topShadow.querySelector('[data-menu-item="sort-range-asc"]')).toBeNull();
  inst.chrome.topShadow.querySelector('[data-menu-item="sort-sheet-desc"]').click();

  expect(grid().get("A1:C3")).toEqual([
    ["k3", 20, "z"],
    ["k1", 15, "y"],
    ["k2", 5, "x"],
  ]);

  // Full-width cell selection A2:C3 sends cols: null to grid.apply and keeps A2:C3 selected.
  rows()[1].children[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  rows()[2].children[2].dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }),
  );
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(inst.chrome.nameBox.value).toBe("A2:C3");

  const applySpy = jest.spyOn(grid(), "apply");
  rows()[1].children[0].dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 70 }),
  );
  inst.chrome.topShadow.querySelector('[data-menu-item="sort-range-desc"]').click();

  expect(applySpy).toHaveBeenCalledWith(expect.objectContaining({ v: 1, t: "sort", sheet: "s1", cols: null }));
  expect(inst.chrome.nameBox.value).toBe("A2:C3");
  expect(grid().get("A1:C3")).toEqual([
    ["k3", 20, "z"],
    ["k2", 5, "x"],
    ["k1", 15, "y"],
  ]);

  ui.dispose();
});

// Bug: sorting across a vertical merge, a covered cell, a cut horizontal merge, or a frozen row threw GridRefused or altered cells instead of showing the notice.
test("a refused sort over a merge or a frozen row shows sapjs's notice and leaves the sheet unchanged", async () => {
  const { Sap, ui, inst } = await start(C8C_SLICE_BOOK());
  const grid = () => Sap.grid(tableOf("s1"));
  const bodyRows = () => [...tableOf("s1").querySelectorAll("tbody tr")];

  // Vertical merge A3:A4 refused on whole-width Sort sheet A to Z (would split r3 and r4 around r2).
  grid().merge("A3:A4");
  await frame();
  const snapMerged = grid().get("A1:C5");

  inst.overlays.shadow
    .querySelector('[data-col="1"]')
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 140, clientY: 10 }));
  await turn();
  inst.chrome.topShadow.querySelector('[data-menu-item="sort-sheet-asc"]').click();

  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(inst.chrome.noticeBar.textContent).toContain("merge");
  expect(grid().get("A1:C5")).toEqual(snapMerged);
  expect(grid().cell("A3").span).toEqual({ rows: 2, cols: 1 });
  expect(inst.chrome.topShadow.querySelector('[data-command="undo"]').getAttribute("aria-disabled")).toBe("true");

  // Partial-width Sort range over A2:B4 (contains covered cell A4) shows notice and changes nothing.
  inst.chrome.hideNotice();
  bodyRows()[0].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  bodyRows()[2].children[0].dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }),
  );
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  bodyRows()[1].children[1].dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 80 }),
  );
  inst.chrome.topShadow.querySelector('[data-menu-item="sort-range-asc"]').click();

  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(grid().get("A1:C5")).toEqual(snapMerged);

  // Horizontal merge A2:B2 refused when sorting whole column A alone via Sort range.
  grid().unmerge("A3");
  grid().merge("A2:B2");
  await frame();
  inst.chrome.hideNotice();
  const snapHoriz = grid().get("A1:C5");

  inst.overlays.shadow
    .querySelector('[data-col="0"]')
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 10 }));
  inst.chrome.topShadow.querySelector('[data-menu-item="sort-range-desc"]').click();

  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(grid().cell("A2").span).toEqual({ rows: 1, cols: 2 });
  expect(grid().get("A1:C5")).toEqual(snapHoriz);

  // Full-width Sort range A1:C3 that includes frozen row 1 is refused by sapjs with its frozen-row notice.
  grid().unmerge("A2");
  await frame();
  inst.chrome.hideNotice();
  const snapUnmerged = grid().get("A1:C5");
  const allRows = () => [...tableOf("s1").querySelectorAll("tr")];
  allRows()[0].children[0].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  allRows()[2].children[2].dispatchEvent(
    new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }),
  );
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(inst.chrome.nameBox.value).toBe("A1:C3");

  allRows()[1].children[1].dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 50 }),
  );
  inst.chrome.topShadow.querySelector('[data-menu-item="sort-range-asc"]').click();

  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(inst.chrome.noticeBar.textContent).toContain("frozen row");
  expect(grid().get("A1:C5")).toEqual(snapUnmerged);

  ui.dispose();
});

// Bug: a partial-width Sort range on a column selection moved frozen header row 1 into the data (sapjs checks frozen rows only on whole-width sorts).
test("Sort range on a column selection leaves frozen rows in place, and a cell range over a frozen row is refused", async () => {
  const { Sap, ui, inst } = await start(C8C_SLICE_BOOK());
  const grid = () => Sap.grid(tableOf("s1"));
  const header = () => inst.overlays.shadow.querySelector('[data-col="1"]');
  header().dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, clientX: 140, clientY: 10 }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  header().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 140, clientY: 10 }));
  await turn();
  inst.chrome.topShadow.querySelector('[data-menu-item="sort-range-asc"]').click();
  expect(grid().get("B1")).toBe("Val");
  expect([grid().get("B2"), grid().get("B3"), grid().get("B4")]).toEqual([10, 30, "apple"]);
  expect(grid().get("A1")).toBe("Item");

  inst.chrome.hideNotice();
  const before = grid().get("A1:C5");
  const allRows = () => [...tableOf("s1").querySelectorAll("tr")];
  allRows()[0].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  allRows()[2].children[1].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
  window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  expect(inst.chrome.nameBox.value).toBe("B1:B3");
  allRows()[1].children[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 140, clientY: 50 }));
  inst.chrome.topShadow.querySelector('[data-menu-item="sort-range-asc"]').click();
  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(inst.chrome.noticeBar.textContent).toContain("frozen row");
  expect(grid().get("A1:C5")).toEqual(before);
  ui.dispose();
});

// Bug: pressing Undo after a later foreign edit in the sorted rows moved the edited row back instead of showing the changed-since notice.
test("undoing a sort after a later edit in the sorted rows shows the changed-since notice and moves nothing", async () => {
  const { Sap, ui, inst } = await start(C8C_SLICE_BOOK());
  const textarea = inst.editor.textarea;
  const grid = () => Sap.grid(tableOf("s1"));

  inst.overlays.shadow
    .querySelector('[data-col="1"]')
    .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 140, clientY: 10 }));
  await turn();
  inst.chrome.topShadow.querySelector('[data-menu-item="sort-sheet-asc"]').click();

  expect(grid().get("B2:B5")).toEqual([[10], [30], ["apple"], [null]]);

  // Later foreign edit in one of the sorted rows.
  grid().set("A3", "edited-later");
  await frame();

  press(textarea, "z", { metaKey: true });

  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(inst.chrome.noticeBar.textContent).toContain("Those cells changed since, so that step was not undone.");
  expect(grid().get("A2:B5")).toEqual([
    ["third", 10],
    ["edited-later", 30],
    ["second", "apple"],
    ["fourth", null],
  ]);

  ui.dispose();
});
