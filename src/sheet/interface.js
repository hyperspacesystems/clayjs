import { a1, colIndex, rowIndex, tabTable } from "./commit.js";
import { createChrome } from "./chrome.js";
import { copyParts, fillBlock, fillFormula, pasteBlock } from "./clipboard.js";
import { createEditor } from "./editor.js";
import { createHistory } from "./history.js";
import { keyIntent } from "./keys.js";
import { createOverlays } from "./overlays.js";
import {
  clipSelection,
  createSelection,
  edgeSelection,
  moveSelection,
  ownerOf,
  pageSelection,
  readSelection,
  rowEdgeSelection,
  selectAll,
  selectCell,
  selectCols,
  selectionArea,
  selectionBox,
  selectRows,
  sheetCornerSelection,
  writeSelection,
} from "./selection.js";
import { createTabs } from "./tabs.js";
import { ROW_ESTIMATE } from "./geometry.js";
import { WORKBOOK } from "./workbook.js";

function scrollerOf(el) {
  const doc = el.ownerDocument ?? document;
  for (let node = el.parentElement; node && node !== doc.body && node !== doc.documentElement; node = node.parentElement) {
    const { overflow, overflowY, overflowX } = getComputedStyle(node);
    if (/\b(auto|scroll)\b/.test(`${overflow ?? ""} ${overflowY ?? ""} ${overflowX ?? ""}`)) return node;
  }
  return null;
}

function tableRows(table) {
  const rows = [];
  for (const section of [table.tHead, ...table.tBodies]) {
    if (!section) continue;
    for (const tr of section.rows) rows.push(tr);
  }
  return rows;
}

function tableCols(table) {
  const cols = [];
  for (let node = table.firstElementChild; node !== null; node = node.nextElementSibling) {
    if (node.localName !== "colgroup") continue;
    for (let col = node.firstElementChild; col !== null; col = col.nextElementSibling) {
      if (col.localName === "col") cols.push(col);
    }
    break;
  }
  return cols;
}

function columnOfCell(td) {
  let c = 0;
  for (let prev = td.previousElementSibling; prev !== null; prev = prev.previousElementSibling) {
    if (prev.localName === "td" || prev.localName === "th") c += 1;
  }
  return c;
}

function formatCount(n, singular, plural) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? singular : plural}`;
}

const CHANGED_MSG = "Those cells changed since, so that step was not undone.";
const REDONE_MSG = "Those cells changed since, so that step was not redone.";

function createWorkbookInterface(workbook, { shell, storage, tabOptions, commands, platform }) {
  const doc = workbook.ownerDocument ?? document;
  const win = doc.defaultView ?? window;
  const scrollBox = scrollerOf(workbook) ?? workbook;
  const scrollTarget = scrollerOf(workbook) ?? win;
  const path = win.location?.pathname ?? "/";

  const tabs = createTabs(workbook, tabOptions);
  const lastViews = new Map();
  const unsubGrids = [];
  const seenKeys = new WeakSet();
  let sel = null;
  let disposed = false;
  let mine = false;
  let valuesNext = false;

  const gridOf = (table) => (table && typeof win.Sap?.grid === "function" ? win.Sap.grid(table) : null);
  const history = createHistory(workbook, gridOf);

  function withMine(fn) {
    mine = true;
    try {
      return fn();
    } finally {
      mine = false;
    }
  }

  function writeGrid(fn) {
    try {
      withMine(fn);
      return true;
    } catch (error) {
      if (error?.name !== "GridRefused") throw error;
      chrome.showNotice(error.message || "Those cells could not be pasted.");
      return false;
    }
  }

  const windowOf = (table) => shell?.windowOf?.(table) ?? null;

  function viewOf(tabId) {
    const table = tabTable(workbook, tabId);
    if (!table) return { rows: [], cols: [], rowHidden: () => false, colHidden: () => false, cell: () => null };
    const grid = gridOf(table);
    const trs = tableRows(table);
    const colEls = tableCols(table);
    const rows = trs.map((tr) => tr.getAttribute("data-id") ?? "");
    const cols = colEls.map((col) => col.getAttribute("data-id") ?? "");
    return {
      rows,
      cols,
      rowHidden: (r) => Boolean(trs[r]?.hidden),
      colHidden: (c) => Boolean(colEls[c]?.hidden),
      cell(r, c) {
        if (!grid || r < 0 || c < 0 || r >= rows.length || c >= cols.length) return null;
        return grid.cell(a1(r, c));
      },
    };
  }

  function snapshotViews() {
    for (const tab of tabs.list()) {
      const v = viewOf(tab.id);
      lastViews.set(tab.id, { rows: v.rows, cols: v.cols });
    }
  }

  function activeCellInfo(overrideTarget = null) {
    const point = overrideTarget ?? (sel ? { tab: sel.tab, row: sel.anchor.row, col: sel.anchor.col } : null);
    if (!point?.tab) return null;
    const table = tabTable(workbook, point.tab);
    if (!table) return { ...point, r: -1, c: -1, ref: "A1", text: "", input: "", effectiveFmt: null };
    const r = rowIndex(table, point.row);
    const c = colIndex(table, point.col);
    if (r === -1 || c === -1) return { ...point, r: -1, c: -1, ref: "A1", text: "", input: "", effectiveFmt: null };
    const ref = a1(r, c);
    const grid = gridOf(table);
    const cell = grid ? grid.cell(ref) : null;
    const input = grid ? grid.input(ref) : "";
    return {
      tab: point.tab,
      row: point.row,
      col: point.col,
      r,
      c,
      ref,
      text: cell?.text ?? "",
      input,
      effectiveFmt: cell?.effectiveFmt ?? null,
    };
  }

  function cellSpeech(enteredTab = false) {
    const info = activeCellInfo();
    if (!info) return "";
    const valuePart = info.text ? `${info.ref}, ${info.text}` : `${info.ref}, empty`;
    if (!enteredTab) return valuePart;
    const tab = tabs.list().find((t) => t.id === info.tab);
    const view = viewOf(info.tab);
    const prefix = `${tab?.name || info.tab}, ${formatCount(view.rows.length, "row", "rows")}, ${formatCount(view.cols.length, "column", "columns")}`;
    return `${prefix}, ${valuePart}`;
  }

  const overlays = createOverlays(workbook, {
    onSelectCol(c, extend) {
      editor.settle();
      if (editor.editing && editor.canPick()) return editor.focus();
      if (editor.editing && !commitEdit().ok) return;
      const view = viewOf(sel.tab);
      const next = selectCell(view, sel, 0, c, { extend });
      applySelection(selectCols(view, next));
      editor.focus();
    },
    onSelectRow(r, extend) {
      editor.settle();
      if (editor.editing && editor.canPick()) return editor.focus();
      if (editor.editing && !commitEdit().ok) return;
      const view = viewOf(sel.tab);
      const next = selectCell(view, sel, r, 0, { extend });
      applySelection(selectRows(view, next));
      editor.focus();
    },
    onSelectAll() {
      editor.settle();
      if (editor.editing && editor.canPick()) return;
      if (editor.editing && !commitEdit().ok) return;
      applySelection(selectAll(viewOf(sel.tab), sel));
      editor.focus();
    },
  });

  const chrome = createChrome({
    scrollBox,
    commands,
    onSelectTab(tabId) {
      handleTabClick(tabId);
    },
    onCommit() {
      if (!editor.editing) return;
      const res = commitEdit();
      if (res.ok) {
        applySelection(moveSelection(viewOf(sel.tab), sel, { dr: 1, dc: 0, extend: false }));
        revealFocus();
        editor.focus();
      }
    },
    onCancel() {
      editor.cancel();
    },
  });

  const editor = createEditor({
    workbook,
    editorSlot: overlays.editorSlot,
    formulaInput: chrome.formulaInput,
    getActiveCell: activeCellInfo,
    getView: viewOf,
    getTabs: () => tabs.list(),
    getShownTab: () => tabs.activeId,
    showTab: (id) => tabs.show(id),
    onStateChange: () => syncUI(),
    onNotice: (msg) => chrome.showNotice(msg),
    onClearNotice: () => chrome.hideNotice(),
  });

  function syncUI({ announce = false, enteredTab = false } = {}) {
    if (disposed || !sel) return;
    const shownId = tabs.activeId;
    const table = tabTable(workbook, shownId);
    const view = viewOf(shownId);
    const selView = shownId === sel.tab ? view : viewOf(sel.tab);
    const box = shownId === sel.tab ? selectionBox(view, sel) : null;

    chrome.setEditing(editor.editing);
    chrome.registerCommand("undo", !editor.editing && history.canUndo(sel.tab) ? () => replayStep("undo") : null);
    chrome.registerCommand("redo", !editor.editing && history.canRedo(sel.tab) ? () => replayStep("redo") : null);
    chrome.setCoord(selectionArea(selView, sel));
    chrome.renderTabs(tabs.list(), shownId);
    if (!editor.editing) editor.refreshReady();

    const speech = cellSpeech(enteredTab);
    editor.setAriaLabel(speech);
    if (announce) overlays.announce(speech);

    overlays.render({
      table,
      win: windowOf(table),
      view,
      box,
      editing: editor.editing && shownId === sel.tab,
      refs: editor.refs(),
      shownTab: shownId,
    });
  }

  function revealFocus() {
    if (!sel) return;
    const table = tabTable(workbook, sel.tab);
    if (!table) return;
    const r = rowIndex(table, sel.focus.row);
    const c = colIndex(table, sel.focus.col);
    if (r < (table.tHead?.rows.length ?? 0) || c < 0) return;
    const cb = overlays.cellBox(table, windowOf(table), r, c);
    if (!cb) return;
    const scroller = scrollerOf(workbook);
    if (scroller && scroller.clientHeight <= 0) return;
    const sb = scroller
      ? scroller.getBoundingClientRect()
      : { top: 0, left: 0, bottom: win.innerHeight ?? 0, right: win.innerWidth ?? 0 };
    const topEdge = sb.top + (table.tHead?.offsetHeight ?? 0) + 24;
    const leftEdge = sb.left + 42;
    let dy = 0;
    let dx = 0;
    if (cb.top < topEdge) dy = cb.top - topEdge;
    else if (cb.top + cb.height > sb.bottom) dy = cb.top + cb.height - sb.bottom;
    if (cb.left < leftEdge) dx = cb.left - leftEdge;
    else if (cb.left + cb.width > sb.right) dx = cb.left + cb.width - sb.right;
    if (!dy && !dx) return;
    if (scroller) {
      scroller.scrollTop += dy;
      scroller.scrollLeft += dx;
    } else {
      win.scrollBy?.(dx, dy);
    }
  }

  function applyMove(nextSel, { announce = true, enteredTab = false } = {}) {
    applySelection(nextSel, { announce, enteredTab });
    revealFocus();
  }

  function applySelection(nextSel, { announce = true, enteredTab = false } = {}) {
    sel = nextSel;
    if (!editor.editing && tabs.activeId !== sel.tab) tabs.show(sel.tab);
    writeSelection(storage, path, sel);
    snapshotViews();
    syncUI({ announce, enteredTab });
  }

  function initSelection() {
    const list = tabs.list();
    const firstId = list[0]?.id ?? "";
    const stored = readSelection(storage, path);
    const chosenTab = stored && list.some((t) => t.id === stored.tab) ? stored.tab : firstId;
    const view = viewOf(chosenTab);
    sel = stored && stored.tab === chosenTab
      ? clipSelection(view, stored)
      : createSelection(view, chosenTab);
    tabs.show(sel.tab);
    writeSelection(storage, path, sel);
    snapshotViews();
    syncUI({ announce: true, enteredTab: true });
  }

  function handleTabClick(tabId) {
    editor.settle();
    const list = tabs.list();
    const targetTab = list.find((t) => t.id === tabId);
    if (!targetTab) return;

    if (editor.editing && editor.canPick()) {
      if (tabId === tabs.activeId) return editor.focus();
      tabs.show(tabId);
      editor.pickCell({ tab: tabId, tabName: targetTab.name, r: 0, c: 0, extend: false });
      syncUI({ announce: false });
      return;
    }

    if (editor.editing && !commitEdit().ok) return;
    if (tabId === sel.tab && tabs.activeId === tabId) {
      editor.focus();
      return;
    }

    const view = viewOf(tabId);
    const nextSel = createSelection(view, tabId);
    tabs.show(tabId);
    applySelection(nextSel, { announce: true, enteredTab: true });
    editor.focus();
  }

  function pageRowsCount() {
    const scroller = scrollerOf(workbook);
    const h = scroller ? scroller.clientHeight : win.innerHeight;
    return Math.max(1, Math.floor((h || 520) / ROW_ESTIMATE));
  }

  function clearSelectedCells() {
    const table = tabTable(workbook, sel.tab);
    const grid = gridOf(table);
    if (!grid) return;
    const view = viewOf(sel.tab);
    if (view.rows.length === 0 || view.cols.length === 0) return;
    try {
      withMine(() => grid.clear(selectionArea(view, sel)));
      chrome.hideNotice();
    } catch (error) {
      if (error?.name !== "GridRefused") throw error;
      chrome.showNotice(error.message || "Those cells could not be cleared.");
      return;
    }
    syncUI({ announce: true });
  }

  function commitEdit() {
    return withMine(() => editor.commit());
  }

  function boxSelection(view, current, coords) {
    const top = Math.min(...coords.map((p) => p.r));
    const left = Math.min(...coords.map((p) => p.c));
    const bottom = Math.max(...coords.map((p) => p.r));
    const right = Math.max(...coords.map((p) => p.c));
    return {
      tab: current.tab,
      anchor: { row: view.rows[top], col: view.cols[left] },
      focus: { row: view.rows[bottom], col: view.cols[right] },
    };
  }

  function replayStep(kind) {
    let res;
    try {
      res = kind === "undo" ? history.undo(sel.tab) : history.redo(sel.tab);
    } catch (error) {
      if (error?.name !== "GridRefused") throw error;
      chrome.showNotice(error.message || "That step could not be applied.");
      syncUI();
      return;
    }
    if (res.why === "changed") {
      chrome.showNotice(kind === "undo" ? CHANGED_MSG : REDONE_MSG);
      syncUI();
      return;
    }
    if (!res.ok) return;
    chrome.hideNotice();
    const table = tabTable(workbook, sel.tab);
    const coords = [];
    for (const { row, col } of res.cells) {
      const r = table ? rowIndex(table, row) : -1;
      const c = table ? colIndex(table, col) : -1;
      if (r >= 0 && c >= 0) coords.push({ r, c });
    }
    if (coords.length > 0) applyMove(boxSelection(viewOf(sel.tab), sel, coords));
    else syncUI({ announce: true });
  }

  function copySelection(cut = false) {
    const table = tabTable(workbook, sel.tab);
    const grid = gridOf(table);
    if (!grid) return null;
    const view = viewOf(sel.tab);
    if (view.rows.length === 0 || view.cols.length === 0) return null;
    const box = selectionBox(view, sel);
    return box ? { grid, box, parts: copyParts(grid, box, a1, { cut }) } : null;
  }

  function onCopy(event) {
    if (disposed || editor.editing || !sel || !event.clipboardData) return;
    const copied = copySelection();
    if (!copied) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", copied.parts.text);
    event.clipboardData.setData("text/html", copied.parts.html);
  }

  function onCut(event) {
    if (disposed || editor.editing || !sel || !event.clipboardData) return;
    const copied = copySelection(true);
    if (!copied) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", copied.parts.text);
    event.clipboardData.setData("text/html", copied.parts.html);
    clearSelectedCells();
  }

  function onBeforeClipboard(event) {
    if (!disposed && !editor.editing) event.preventDefault();
  }

  function onPaste(event) {
    if (disposed || editor.editing || !sel) return;
    event.preventDefault();
    try {
      const table = tabTable(workbook, sel.tab);
      const grid = gridOf(table);
      if (!grid) return;
      const view = viewOf(sel.tab);
      if (view.rows.length === 0 || view.cols.length === 0) return;
      const box = selectionBox(view, sel);
      if (!box) return;
      const at = a1(box.top, box.left);
      const singleMerge =
        box.top === box.active.r &&
        box.left === box.active.c &&
        box.bottom === box.active.r + box.active.rows - 1 &&
        box.right === box.active.c + box.active.cols - 1;
      const [selRows, selCols] = singleMerge ? [1, 1] : [box.bottom - box.top + 1, box.right - box.left + 1];
      const html = event.clipboardData?.getData("text/html") ?? "";
      const text = event.clipboardData?.getData("text/plain") ?? "";
      const valuesOnly = valuesNext;
      const parsed = pasteBlock(html, { r: box.top, c: box.left }, { valuesOnly });
      const uncovered = (write) =>
        write.map((line, i) => line.map((item, j) => (view.cell(box.top + i, box.left + j)?.covered ? undefined : item)));
      let rows = 0;
      let cols = 0;
      if (parsed && (parsed.kind === "ours" || !text)) {
        const { kind, block, origin } = parsed;
        let write = block;
        if (kind === "ours" && !valuesOnly && block.length === 1 && block[0].length === 1 && block[0][0]?.content && typeof block[0][0].content === "object" && typeof block[0][0].content.f === "string") {
          const item = block[0][0];
          write = uncovered(fillFormula(item.content.f, item.fmt, box.top - origin.r, box.left - origin.c, selRows, selCols));
          rows = selRows;
          cols = selCols;
        } else if (block.length === 1 && block[0].length === 1) {
          write = uncovered(fillBlock(block, selRows, selCols));
          rows = selRows;
          cols = selCols;
        } else {
          rows = block.length;
          cols = block[0]?.length ?? 0;
        }
        const options = kind === "ours" ? (valuesOnly ? { grow: true, detect: false, formats: false } : { grow: true }) : { grow: true, formulas: !valuesOnly };
        if (!writeGrid(() => grid.setRange(at, write, options))) return;
      } else if (text) {
        const flat = text.replace(/\r?\n$/, "");
        let lines;
        if (!/[\t\r\n]/.test(flat)) {
          lines = [[flat]];
        } else {
          try {
            lines = win.Sap?.grid?.csv?.parseDelimited(text, { delimiter: "\t" }) ?? [];
          } catch (error) {
            if (error?.name !== "DelimitedError") throw error;
            lines = [[flat]];
          }
        }
        const one = lines.length === 1 && (lines[0]?.length ?? 0) === 1;
        const filled = fillBlock(lines, selRows, selCols);
        rows = filled.length;
        cols = Math.max(0, ...filled.map((line) => line.length));
        if (!rows || !cols) return;
        const options = { grow: true, formulas: !valuesOnly };
        const wrote = one
          ? writeGrid(() => grid.setRange(at, uncovered(filled), options))
          : writeGrid(() => grid.importDelimited(text, at, { delimiter: "\t", formulas: !valuesOnly }));
        if (!wrote) return;
      } else {
        return;
      }
      if (!rows || !cols) return;
      const nextView = viewOf(sel.tab);
      if (nextView.rows.length === 0 || nextView.cols.length === 0) return;
      const bottom = Math.min(box.top + rows - 1, nextView.rows.length - 1);
      const right = Math.min(box.left + cols - 1, nextView.cols.length - 1);
      applyMove({
        tab: sel.tab,
        anchor: { row: nextView.rows[box.top], col: nextView.cols[box.left] },
        focus: { row: nextView.rows[bottom], col: nextView.cols[right] },
      });
    } finally {
      valuesNext = false;
    }
  }

  function runKey(event) {
    if (disposed || seenKeys.has(event)) return;
    seenKeys.add(event);

    const effectivePlatform = platform ?? win.navigator?.platform ?? "";
    const intent = keyIntent(event, {
      platform: effectivePlatform,
      editing: editor.editing,
      picking: editor.canPick({ keyboard: true }),
      composing: editor.composing,
    });
    if (intent?.type === "pasteValues") {
      valuesNext = true;
      return;
    }
    if (!["Shift", "Control", "Meta", "Alt"].includes(event.key) && intent?.type !== "pasteValues") valuesNext = false;
    if (!intent) return;

    event.preventDefault();
    const view = viewOf(sel.tab);

    switch (intent.type) {
      case "move":
        applyMove(moveSelection(view, sel, intent));
        break;
      case "edge":
        applyMove(edgeSelection(view, sel, intent));
        break;
      case "rowEdge":
        applyMove(rowEdgeSelection(view, sel, intent));
        break;
      case "sheetCorner":
        applyMove(sheetCornerSelection(view, sel, intent));
        break;
      case "page":
        applyMove(pageSelection(view, sel, { ...intent, pageSize: pageRowsCount() }));
        break;
      case "selectAll":
        applyMove(selectAll(view, sel));
        break;
      case "selectCols":
        applySelection(selectCols(view, sel));
        break;
      case "selectRows":
        applySelection(selectRows(view, sel));
        break;
      case "tab": {
        const list = tabs.list();
        if (list.length < 2) break;
        const idx = list.findIndex((t) => t.id === sel.tab);
        const nextIdx = (idx + intent.delta + list.length) % list.length;
        handleTabClick(list[nextIdx].id);
        break;
      }
      case "clear":
        clearSelectedCells();
        break;
      case "undo":
        replayStep("undo");
        break;
      case "redo":
        replayStep("redo");
        break;
      case "edit":
        editor.openWithInput(editor.textarea);
        break;
      case "cancel":
        editor.cancel();
        break;
      case "newline":
        editor.insertNewline();
        break;
      case "cycleRef":
        editor.cycleRef();
        break;
      case "pick":
        editor.pickMove(intent);
        break;
      case "commit": {
        const res = commitEdit();
        if (res.ok) {
          applyMove(moveSelection(viewOf(sel.tab), sel, { dr: intent.dr, dc: intent.dc, extend: false }));
          editor.focus();
        }
        break;
      }
    }
  }

  function onWindowKeyDown(event) {
    const target = event.composedPath?.()[0] ?? event.target;
    if (target !== editor.textarea && target !== chrome.formulaInput) return;
    runKey(event);
  }

  function locateCellEvent(event) {
    const el = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    if (!el) return null;
    const cellEl = el.closest?.("td, th");
    if (cellEl && workbook.contains(cellEl)) {
      const table = cellEl.closest("table[grid]");
      const section = table?.parentElement;
      const tr = cellEl.parentElement;
      if (table && section?.matches("section[item]") && tr?.localName === "tr") {
        const tab = section.getAttribute("data-id") ?? "";
        const r = tableRows(table).indexOf(tr);
        const c = columnOfCell(cellEl);
        if (r !== -1) return { tab, r, c };
      }
    }
    const shownId = tabs.activeId;
    const table = tabTable(workbook, shownId);
    if (!table) return null;
    const hit = overlays.cellAtPoint(table, windowOf(table), event.clientX ?? 0, event.clientY ?? 0);
    return hit ? { tab: shownId, r: hit.r, c: hit.c } : null;
  }

  function actOnCellPointer(hit, { extend = false } = {}) {
    editor.settle();
    const tabInfo = tabs.list().find((t) => t.id === hit.tab);
    if (editor.editing) {
      if (editor.canPick()) {
        editor.pickCell({ tab: hit.tab, tabName: tabInfo?.name ?? "", r: hit.r, c: hit.c, extend });
        return;
      }
      const res = commitEdit();
      if (!res.ok) return;
    }
    const view = viewOf(hit.tab);
    const entered = hit.tab !== sel.tab;
    if (entered) tabs.show(hit.tab);
    const baseSel = entered ? createSelection(view, hit.tab) : sel;
    const nextSel = selectCell(view, baseSel, hit.r, hit.c, { extend: !entered && extend });
    applySelection(nextSel, { announce: true, enteredTab: entered });
    editor.focus();
  }

  let handledPointerDown = false;
  let dragging = false;

  function onMouseDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    const hit = locateCellEvent(event);
    if (!hit) return;
    event.preventDefault();
    handledPointerDown = true;
    dragging = true;
    actOnCellPointer(hit, { extend: event.shiftKey });
  }

  function onMouseMove(event) {
    if (!dragging) return;
    const hit = locateCellEvent(event);
    if (!hit) return;
    if (editor.editing && editor.canPick()) {
      const tabInfo = tabs.list().find((t) => t.id === hit.tab);
      editor.pickCell({ tab: hit.tab, tabName: tabInfo?.name ?? "", r: hit.r, c: hit.c, extend: true });
      return;
    }
    if (!editor.editing && hit.tab === sel.tab) {
      applySelection(selectCell(viewOf(sel.tab), sel, hit.r, hit.c, { extend: true }), { announce: false });
    }
  }

  function onMouseUp() {
    dragging = false;
  }

  function onClick(event) {
    if (handledPointerDown) {
      handledPointerDown = false;
      return;
    }
    const hit = locateCellEvent(event);
    if (!hit) return;
    actOnCellPointer(hit, { extend: event.shiftKey });
  }

  function onDblClick(event) {
    if (editor.editing && editor.canPick()) return;
    const hit = locateCellEvent(event);
    if (hit) {
      if (editor.editing && !commitEdit().ok) return;
      const view = viewOf(hit.tab);
      applySelection(selectCell(view, { ...sel, tab: hit.tab }, hit.r, hit.c, { extend: false }));
    }
    if (!editor.editing) editor.openWithInput(editor.textarea);
  }

  function subscribeGrids() {
    for (const off of unsubGrids.splice(0)) off();
    resizeObserver?.disconnect();
    for (const tab of tabs.list()) {
      resizeObserver?.observe(tab.table);
      const grid = gridOf(tab.table);
      if (!grid) continue;
      unsubGrids.push(
        grid.on("change", (event) => {
          if (disposed) return;
          if (mine) history.record(tab.id, event);
          if (tab.id === sel?.tab) {
            const view = viewOf(sel.tab);
            sel = clipSelection(view, sel, lastViews.get(sel.tab) ?? null);
            writeSelection(storage, path, sel);
          }
          snapshotViews();
          redraw();
        }),
      );
    }
  }

  function restart() {
    if (disposed) return;
    const list = tabs.list();
    const firstId = list[0]?.id ?? "";
    const keepTab = list.some((t) => t.id === sel?.tab) ? sel.tab : firstId;
    const entered = keepTab !== sel?.tab;
    const view = viewOf(keepTab);
    sel = entered
      ? createSelection(view, keepTab)
      : clipSelection(view, sel, lastViews.get(keepTab) ?? null);
    if (!editor.editing) tabs.show(sel.tab);
    else tabs.refresh();
    writeSelection(storage, path, sel);
    snapshotViews();
    subscribeGrids();
    syncUI({ announce: entered, enteredTab: entered });
  }

  const raf = typeof win.requestAnimationFrame === "function" ? win.requestAnimationFrame.bind(win) : null;
  let framePending = false;

  // One redraw per frame: rows the window measured, a scroll and a grid change all repaint.
  function redraw() {
    if (disposed || framePending) return;
    if (!raf) {
      syncUI({ announce: false });
      return;
    }
    framePending = true;
    raf(() => {
      framePending = false;
      if (!disposed) syncUI({ announce: false });
    });
  }

  const resizeObserver = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(() => redraw()) : null;
  const onViewportMove = () => redraw();

  win.addEventListener("keydown", onWindowKeyDown, true);
  editor.textarea.addEventListener("keydown", runKey);
  editor.textarea.addEventListener("beforecopy", onBeforeClipboard);
  editor.textarea.addEventListener("beforecut", onBeforeClipboard);
  editor.textarea.addEventListener("copy", onCopy);
  editor.textarea.addEventListener("cut", onCut);
  editor.textarea.addEventListener("paste", onPaste);
  chrome.formulaInput.addEventListener("keydown", runKey);
  workbook.addEventListener("mousedown", onMouseDown);
  win.addEventListener("mousemove", onMouseMove);
  win.addEventListener("mouseup", onMouseUp);
  workbook.addEventListener("click", onClick);
  workbook.addEventListener("dblclick", onDblClick);
  scrollTarget.addEventListener("scroll", onViewportMove, { passive: true });
  win.addEventListener("resize", onViewportMove);

  initSelection();
  subscribeGrids();

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const off of unsubGrids.splice(0)) off();
    win.removeEventListener("keydown", onWindowKeyDown, true);
    editor.textarea.removeEventListener("keydown", runKey);
    editor.textarea.removeEventListener("beforecopy", onBeforeClipboard);
    editor.textarea.removeEventListener("beforecut", onBeforeClipboard);
    editor.textarea.removeEventListener("copy", onCopy);
    editor.textarea.removeEventListener("cut", onCut);
    editor.textarea.removeEventListener("paste", onPaste);
    chrome.formulaInput.removeEventListener("keydown", runKey);
    workbook.removeEventListener("mousedown", onMouseDown);
    win.removeEventListener("mousemove", onMouseMove);
    win.removeEventListener("mouseup", onMouseUp);
    workbook.removeEventListener("click", onClick);
    workbook.removeEventListener("dblclick", onDblClick);
    scrollTarget.removeEventListener("scroll", onViewportMove);
    win.removeEventListener("resize", onViewportMove);
    resizeObserver?.disconnect();
    tabs.dispose();
    overlays.dispose();
    chrome.dispose();
  }

  return {
    workbook,
    chrome,
    overlays,
    editor,
    tabs,
    get selection() {
      return sel ? { tab: sel.tab, anchor: { ...sel.anchor }, focus: { ...sel.focus } } : null;
    },
    registerCommand: chrome.registerCommand,
    restart,
    dispose,
  };
}

export function startInterface({
  shell = null,
  root = document,
  storage = globalThis.sessionStorage,
  tabOptions = {},
  commands = {},
  platform,
} = {}) {
  const instances = new Map();

  function mountMissing() {
    const live = new Set(root.querySelectorAll(WORKBOOK));
    for (const [el, inst] of instances) {
      if (live.has(el)) continue;
      inst.dispose();
      instances.delete(el);
    }
    for (const el of live) {
      if (!instances.has(el)) {
        instances.set(el, createWorkbookInterface(el, { shell, storage, tabOptions, commands, platform }));
      }
    }
  }

  mountMissing();

  return {
    get selection() {
      const first = instances.values().next().value;
      return first ? first.selection : null;
    },
    of: (workbook) => instances.get(workbook) ?? null,
    restart() {
      mountMissing();
      for (const inst of instances.values()) inst.restart();
    },
    dispose() {
      for (const inst of instances.values()) inst.dispose();
      instances.clear();
    },
  };
}
