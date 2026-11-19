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
  ui = startInterface({ shell, platform: "MacIntel" });
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

// Bug: unimplemented toolbar commands (undo, merge, sort, chart, import) were clickable without aria-disabled="true".
test("buttons for commands that land in later milestones are drawn and disabled with aria-disabled", async () => {
  const { ui, inst } = await start();

  for (const id of ["undo", "redo", "number-format", "currency", "bold", "borders", "merge", "filter", "sort", "chart", "find", "import"]) {
    const btn = inst.chrome.topShadow.querySelector(`[data-command="${id}"]`);
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-disabled")).toBe("true");
  }
  const addTab = inst.chrome.bottomShadow.querySelector('[data-command="add-tab"]');
  expect(addTab?.getAttribute("aria-disabled")).toBe("true");

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
