import { a1, colIndex, colName, rowIndex, tabTable } from "./commit.js";
import { createChrome } from "./chrome.js";
import { copyParts, fillBlock, fillFormula, pasteBlock } from "./clipboard.js";
import { createEditor } from "./editor.js";
import {
  alignMenuItems,
  applyAlign,
  applyBorder,
  applyClearFormatting,
  applyDecimals,
  applyFillColor,
  applyNumberFormat,
  applyStyleToggle,
  applyTextColor,
  borderMenuItems,
  cellStyleState,
  colorMenuItems,
  inspectMerge,
  numberFormatMenuItems,
  runMergeCommand,
} from "./format-commands.js";
import { createHistory } from "./history.js";
import { keyIntent } from "./keys.js";
import { createMenu, openDeleteTabDialog, openMergeKeepDialog } from "./menu.js";
import { createOverlays } from "./overlays.js";
import {
  axisSpan,
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
  selectColsAt,
  commandArea,
  selectionArea,
  selectionBox,
  selectRows,
  selectRowsAt,
  sheetCornerSelection,
  writeSelection,
} from "./selection.js";
import {
  createTabs,
  duplicateTableHtml,
  emptyTableHtml,
  isKey,
  keyBetween,
  keysBetween,
  mintTabId,
  nextCopyName,
  nextSheetName,
} from "./tabs.js";
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

function frozenOf(table) {
  const rows = table?.tHead?.rows.length ?? 0;
  const rawCols = Number.parseInt(table?.getAttribute("freeze-cols") ?? "", 10);
  const cols = Number.isInteger(rawCols) && rawCols > 0 ? rawCols : 0;
  return { rows, cols };
}

function formatCount(n, singular, plural) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? singular : plural}`;
}

const CHANGED_MSG = "Those cells changed since, so that step was not undone.";
const REDONE_MSG = "Those cells changed since, so that step was not redone.";

function createWorkbookInterface(workbook, { shell, storage, tabOptions, commands, platform, measureText }) {
  const doc = workbook.ownerDocument ?? document;
  const win = doc.defaultView ?? window;
  const scrollBox = scrollerOf(workbook) ?? workbook;
  const scrollTarget = scrollerOf(workbook) ?? win;
  const path = win.location?.pathname ?? "/";
  const externalCommands = { ...commands };

  const tabs = createTabs(workbook, tabOptions);
  const lastViews = new Map();
  const unsubGrids = [];
  const seenKeys = new WeakSet();
  let sel = null;
  let disposed = false;
  let mine = false;
  let valuesNext = false;
  let activeDialog = null;
  let dialogTab = "";

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
      chrome.hideNotice();
      return true;
    } catch (error) {
      if (error?.name !== "GridRefused") throw error;
      chrome.showNotice(error.message || "That step could not be applied.");
      return false;
    }
  }

  function runTabStep(fn) {
    try {
      fn();
      chrome.hideNotice();
      return true;
    } catch (error) {
      if (error?.name !== "GridRefused") throw error;
      chrome.showNotice(error.message || "That sheet action could not be applied.");
      return false;
    }
  }

  function clearDialog() {
    activeDialog = null;
    dialogTab = "";
  }

  function closeDialog() {
    const handle = activeDialog;
    clearDialog();
    handle?.close?.();
  }

  function showDialog(tabId, handle) {
    closeDialog();
    activeDialog = handle;
    dialogTab = tabId;
    return handle;
  }

  function closeTransient() {
    if (menu.isOpen) menu.close({ restoreFocus: false });
    closeDialog();
  }

  function onForeignChange(tabId) {
    if (menu.isOpen && tabId === sel?.tab) menu.close({ restoreFocus: false });
    if (activeDialog && dialogTab === tabId) closeDialog();
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
    if (!table) return { ...point, r: -1, c: -1, ref: "A1", text: "", input: "", effectiveFmt: null, cell: null };
    const r = rowIndex(table, point.row);
    const c = colIndex(table, point.col);
    if (r === -1 || c === -1) return { ...point, r: -1, c: -1, ref: "A1", text: "", input: "", effectiveFmt: null, cell: null };
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
      cell,
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

  function ensureReadyForAction() {
    editor.settle();
    if (editor.editing && !commitEdit().ok) return false;
    return true;
  }

  function runFormat(fn) {
    if (editor.editing || !sel) return false;
    const table = tabTable(workbook, sel.tab);
    const grid = gridOf(table);
    if (!grid) return false;
    const view = viewOf(sel.tab);
    if (view.rows.length === 0 || view.cols.length === 0) return false;
    if (!writeGrid(() => fn(grid, view, table))) return false;
    syncUI({ announce: true });
    return true;
  }

  function insertRowsAt(insertIndex, count, likeRow, wholeRows) {
    if (!sel) return;
    const prevView = viewOf(sel.tab);
    const prevBox = selectionBox(prevView, sel);
    if (!prevBox) return;
    if (!runFormat((grid) => grid.insertRows(insertIndex + 1, count, { like: likeRow }))) return;
    const nextView = viewOf(sel.tab);
    if (nextView.rows.length === 0 || nextView.cols.length === 0) return;
    const top = Math.min(insertIndex, nextView.rows.length - 1);
    const bottom = Math.min(insertIndex + count - 1, nextView.rows.length - 1);
    const nextSel = wholeRows
      ? {
          tab: sel.tab,
          anchor: { row: nextView.rows[top], col: nextView.cols[0] },
          focus: { row: nextView.rows[bottom], col: nextView.cols[nextView.cols.length - 1] },
          whole: "rows",
        }
      : (() => {
          const own = ownerOf(nextView, top, Math.min(prevBox.left, nextView.cols.length - 1));
          return {
            tab: sel.tab,
            anchor: { row: nextView.rows[own.r], col: nextView.cols[own.c] },
            focus: { row: nextView.rows[bottom], col: nextView.cols[Math.min(prevBox.right, nextView.cols.length - 1)] },
          };
        })();
    applyMove(nextSel);
  }

  function insertColsAt(insertIndex, count, likeCol, wholeCols) {
    if (!sel) return;
    const prevView = viewOf(sel.tab);
    const prevBox = selectionBox(prevView, sel);
    if (!prevBox) return;
    if (!runFormat((grid) => grid.insertCols(colName(insertIndex), count, { like: likeCol }))) return;
    const nextView = viewOf(sel.tab);
    if (nextView.rows.length === 0 || nextView.cols.length === 0) return;
    const left = Math.min(insertIndex, nextView.cols.length - 1);
    const right = Math.min(insertIndex + count - 1, nextView.cols.length - 1);
    const nextSel = wholeCols
      ? {
          tab: sel.tab,
          anchor: { row: nextView.rows[0], col: nextView.cols[left] },
          focus: { row: nextView.rows[nextView.rows.length - 1], col: nextView.cols[right] },
          whole: "cols",
        }
      : (() => {
          const own = ownerOf(nextView, Math.min(prevBox.top, nextView.rows.length - 1), left);
          return {
            tab: sel.tab,
            anchor: { row: nextView.rows[own.r], col: nextView.cols[own.c] },
            focus: { row: nextView.rows[Math.min(prevBox.bottom, nextView.rows.length - 1)], col: nextView.cols[right] },
          };
        })();
    applyMove(nextSel);
  }

  function deleteRowsAt(top, bottom) {
    runFormat((grid) => grid.deleteRows(`${top + 1}:${bottom + 1}`));
  }

  function deleteColsAt(left, right) {
    runFormat((grid) => grid.deleteCols(`${colName(left)}:${colName(right)}`));
  }

  function handleResizeCol(c, px) {
    if (editor.editing && editor.canPick()) return editor.focus();
    if (!ensureReadyForAction() || !sel) return;
    const span = axisSpan(viewOf(sel.tab), sel);
    const multi = span?.axis === "cols" && c >= span.first && c <= span.last;
    const area = multi ? `${colName(span.first)}:${colName(span.last)}` : `${colName(c)}:${colName(c)}`;
    runFormat((grid) => grid.setColWidth(area, Math.max(8, Math.round(px))));
    editor.focus();
  }

  function handleResizeRow(r, px) {
    if (editor.editing && editor.canPick()) return editor.focus();
    if (!ensureReadyForAction() || !sel) return;
    const span = axisSpan(viewOf(sel.tab), sel);
    const multi = span?.axis === "rows" && r >= span.first && r <= span.last;
    const first = multi ? span.first : r;
    const last = multi ? span.last : r;
    runFormat((grid) => grid.setRowHeight(`${first + 1}:${last + 1}`, Math.max(12, Math.round(px))));
    editor.focus();
  }

  function handleFitCol(c) {
    if (editor.editing && editor.canPick()) return editor.focus();
    if (!ensureReadyForAction() || !sel) return;
    const table = tabTable(workbook, sel.tab);
    const view = viewOf(sel.tab);
    const span = axisSpan(view, sel);
    const rw = windowOf(table);
    const cols = span?.axis === "cols" && c >= span.first && c <= span.last
      ? Array.from({ length: span.last - span.first + 1 }, (_, i) => span.first + i)
      : [c];
    runFormat((grid) => {
      if (cols.length === 1) {
        const px = overlays.fitColumnWidth(table, rw, view, cols[0]);
        if (px !== null) grid.setColWidth(`${colName(cols[0])}:${colName(cols[0])}`, px);
        return;
      }
      history.group(sel.tab, () => {
        for (const col of cols) {
          const px = overlays.fitColumnWidth(table, rw, view, col);
          if (px !== null) grid.setColWidth(`${colName(col)}:${colName(col)}`, px);
        }
      });
    });
    editor.focus();
  }

  function openRowHeaderMenu(r, anchor, x, y) {
    if (editor.editing && editor.canPick()) return editor.focus();
    if (!ensureReadyForAction() || !sel) return;
    const view = viewOf(sel.tab);
    const curSpan = axisSpan(view, sel);
    if (curSpan?.axis !== "rows" || r < curSpan.first || r > curSpan.last) {
      applySelection(selectRowsAt(view, sel, r));
    }
    const span = axisSpan(viewOf(sel.tab), sel);
    if (!span) return;
    const count = span.last - span.first + 1;
    const table = tabTable(workbook, sel.tab);
    const frozen = frozenOf(table);
    menu.open({
      anchor: x === null ? anchor : null,
      x: x ?? 0,
      y: y ?? 0,
      label: `Row ${r + 1} options`,
      items: [
        { id: "insert-above", label: `Insert ${count} above`, onSelect: () => insertRowsAt(span.first, count, span.first + 1, true) },
        { id: "insert-below", label: `Insert ${count} below`, onSelect: () => insertRowsAt(span.last + 1, count, span.last + 1, true) },
        { id: "delete-rows", label: "Delete rows", onSelect: () => deleteRowsAt(span.first, span.last) },
        { type: "separator" },
        { id: "freeze-rows", label: `Freeze up to row ${r + 1}`, onSelect: () => runFormat((g) => g.freeze({ rows: r + 1, cols: frozen.cols })) },
        { id: "unfreeze-rows", label: "Unfreeze rows", disabled: frozen.rows === 0, onSelect: () => runFormat((g) => g.freeze({ rows: 0, cols: frozen.cols })) },
      ],
    });
  }

  function openColHeaderMenu(c, anchor, x, y) {
    if (editor.editing && editor.canPick()) return editor.focus();
    if (!ensureReadyForAction() || !sel) return;
    const view = viewOf(sel.tab);
    const curSpan = axisSpan(view, sel);
    if (curSpan?.axis !== "cols" || c < curSpan.first || c > curSpan.last) {
      applySelection(selectColsAt(view, sel, c));
    }
    const span = axisSpan(viewOf(sel.tab), sel);
    if (!span) return;
    const count = span.last - span.first + 1;
    const table = tabTable(workbook, sel.tab);
    const frozen = frozenOf(table);
    const letter = colName(c);
    menu.open({
      anchor: x === null ? anchor : null,
      x: x ?? 0,
      y: y ?? 0,
      label: `Column ${letter} options`,
      items: [
        { id: "insert-left", label: `Insert ${count} left`, onSelect: () => insertColsAt(span.first, count, colName(span.first), true) },
        { id: "insert-right", label: `Insert ${count} right`, onSelect: () => insertColsAt(span.last + 1, count, colName(span.last), true) },
        { id: "delete-cols", label: "Delete columns", onSelect: () => deleteColsAt(span.first, span.last) },
        { type: "separator" },
        { id: "freeze-cols", label: `Freeze up to column ${letter}`, onSelect: () => runFormat((g) => g.freeze({ rows: frozen.rows, cols: c + 1 })) },
        { id: "unfreeze-cols", label: "Unfreeze columns", disabled: frozen.cols === 0, onSelect: () => runFormat((g) => g.freeze({ rows: frozen.rows, cols: 0 })) },
      ],
    });
  }

  function openCellContextMenu(r, c, x, y) {
    if (!sel) return;
    menu.open({
      x,
      y,
      label: "Cell options",
      items: [
        { id: "insert-row-above", label: "Insert row above", onSelect: () => insertRowsAt(r, 1, r + 1, false) },
        { id: "insert-col-left", label: "Insert column left", onSelect: () => insertColsAt(c, 1, colName(c), false) },
        { type: "separator" },
        { id: "delete-row", label: "Delete row", onSelect: () => deleteRowsAt(r, r) },
        { id: "delete-col", label: "Delete column", onSelect: () => deleteColsAt(c, c) },
      ],
    });
  }

  function handleAddTab() {
    if (!ensureReadyForAction()) return;
    const list = tabs.list();
    const sapGrid = win.Sap?.grid;
    const grid = gridOf(list[0]?.table);
    if (!grid || typeof sapGrid?.createSheetWriter !== "function") return;
    let maxPos = null;
    for (const t of list) {
      if (isKey(t.pos) && (maxPos === null || maxPos < t.pos)) maxPos = t.pos;
    }
    const pos = keyBetween(maxPos, null);
    const newId = mintTabId(list, sapGrid.newId);
    const name = nextSheetName(list);
    const html = emptyTableHtml(newId, sapGrid);
    if (!runTabStep(() => grid.apply({ v: 1, t: "insertSheet", sheet: { id: newId, name, pos, html } }))) return;
    subscribeGrids();
    const view = viewOf(newId);
    tabs.show(newId);
    applySelection(createSelection(view, newId), { announce: true, enteredTab: true });
    editor.focus();
  }

  function handleDuplicateTab(tabId) {
    if (!ensureReadyForAction()) return;
    const list = tabs.list();
    const idx = list.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const srcTab = list[idx];
    const sapGrid = win.Sap?.grid;
    const grid = gridOf(srcTab.table);
    if (!grid || typeof sapGrid?.createSheetWriter !== "function") return;
    const low = isKey(srcTab.pos) ? srcTab.pos : null;
    let end = idx + 1;
    while (end < list.length && (!isKey(list[end].pos) || (low !== null && list[end].pos <= low))) end += 1;
    const high = end < list.length && isKey(list[end].pos) ? list[end].pos : null;
    const keys = keysBetween(low, high, 1 + (end - (idx + 1)));
    const newId = mintTabId(list, sapGrid.newId);
    const name = nextCopyName(srcTab.name, list);
    const html = duplicateTableHtml(newId, srcTab.table, sapGrid);
    const ok = runTabStep(() => {
      for (let k = idx + 1; k < end; k++) {
        grid.apply({ v: 1, t: "moveSheet", sheet: list[k].id, pos: keys[1 + (k - (idx + 1))] });
      }
      grid.apply({ v: 1, t: "insertSheet", sheet: { id: newId, name, pos: keys[0], html } });
    });
    if (!ok) return;
    subscribeGrids();
    const view = viewOf(newId);
    tabs.show(newId);
    applySelection(createSelection(view, newId), { announce: true, enteredTab: true });
    editor.focus();
  }

  function handleMoveTab(tabId, delta) {
    if (!ensureReadyForAction()) return;
    const list = tabs.list();
    const idx = list.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const targetIdx = idx + delta;
    if (targetIdx < 0 || targetIdx >= list.length) return;
    const grid = gridOf(list[idx].table);
    if (!grid) return;
    const others = list.filter((_, i) => i !== idx);
    const low = targetIdx > 0 && isKey(others[targetIdx - 1].pos) ? others[targetIdx - 1].pos : null;
    let end = targetIdx;
    while (end < others.length && (!isKey(others[end].pos) || (low !== null && others[end].pos <= low))) end += 1;
    const high = end < others.length && isKey(others[end].pos) ? others[end].pos : null;
    const keys = keysBetween(low, high, 1 + (end - targetIdx));
    const ok = runTabStep(() => {
      for (let k = targetIdx; k < end; k++) {
        grid.apply({ v: 1, t: "moveSheet", sheet: others[k].id, pos: keys[1 + (k - targetIdx)] });
      }
      grid.apply({ v: 1, t: "moveSheet", sheet: tabId, pos: keys[0] });
    });
    if (!ok) return;
    syncUI();
    editor.focus();
  }

  function handleDeleteTab(tabId) {
    if (!ensureReadyForAction()) return;
    const list = tabs.list();
    const tab = list.find((t) => t.id === tabId);
    if (!tab) return;
    activeDialog = showDialog(tabId, openDeleteTabDialog({
      doc,
      theme: chrome.theme,
      container: chrome.topRoot,
      tabName: tab.name,
      getReturnFocus: () => editor.textarea,
      onConfirm: () => {
        clearDialog();
        const freshTab = tabs.list().find((t) => t.id === tabId);
        const grid = gridOf(freshTab?.table ?? tabs.list()[0]?.table);
        if (!grid) return;
        if (!runTabStep(() => grid.apply({ v: 1, t: "deleteSheet", sheet: tabId }))) return;
        restart();
      },
      onCancel: () => {
        clearDialog();
      },
    }));
  }

  function handleRenameTab(tabId, nextName) {
    if (nextName === null) {
      chrome.hideNotice();
      editor.focus();
      return true;
    }
    const tab = tabs.list().find((t) => t.id === tabId);
    if (!tab) return true;
    if (nextName === tab.name) {
      chrome.hideNotice();
      editor.focus();
      return true;
    }
    const grid = gridOf(tab.table);
    if (!grid) return true;
    const ok = runTabStep(() => grid.apply({ v: 1, t: "renameSheet", sheet: tabId, name: nextName }));
    if (!ok) return false;
    syncUI();
    editor.focus();
    return true;
  }

  function openTabContextMenu(tabId, btn, x, y) {
    if (!ensureReadyForAction()) return;
    const list = tabs.list();
    const idx = list.findIndex((t) => t.id === tabId);
    if (idx === -1) return;
    const rect = btn?.getBoundingClientRect?.();
    const menuX = x || rect?.left || 0;
    const menuY = y || (rect ? rect.top - 4 : 0);
    menu.open({
      x: menuX,
      y: menuY,
      label: `Sheet ${list[idx].name} options`,
      items: [
        { id: "rename-tab", label: "Rename", onSelect: () => chrome.startRenameTab(tabId) },
        { id: "duplicate-tab", label: "Duplicate", onSelect: () => handleDuplicateTab(tabId) },
        { type: "separator" },
        { id: "move-tab-left", label: "Move left", disabled: idx <= 0, onSelect: () => handleMoveTab(tabId, -1) },
        { id: "move-tab-right", label: "Move right", disabled: idx >= list.length - 1, onSelect: () => handleMoveTab(tabId, 1) },
        { type: "separator" },
        { id: "delete-tab", label: "Delete", danger: true, onSelect: () => handleDeleteTab(tabId) },
      ],
    });
  }

  const overlays = createOverlays(workbook, {
    measureText,
    onSelectCol(c, extend) {
      editor.settle();
      if (editor.editing && editor.canPick()) return editor.focus();
      if (editor.editing && !commitEdit().ok) return;
      applySelection(selectColsAt(viewOf(sel.tab), sel, c, { extend }));
      editor.focus();
    },
    onSelectRow(r, extend) {
      editor.settle();
      if (editor.editing && editor.canPick()) return editor.focus();
      if (editor.editing && !commitEdit().ok) return;
      applySelection(selectRowsAt(viewOf(sel.tab), sel, r, { extend }));
      editor.focus();
    },
    onSelectAll() {
      editor.settle();
      if (editor.editing && editor.canPick()) return;
      if (editor.editing && !commitEdit().ok) return;
      applySelection(selectAll(viewOf(sel.tab), sel));
      editor.focus();
    },
    onResizeCol: handleResizeCol,
    onResizeRow: handleResizeRow,
    onFitCol: handleFitCol,
    onColMenu: openColHeaderMenu,
    onRowMenu: openRowHeaderMenu,
  });

  const chrome = createChrome({
    scrollBox,
    commands: externalCommands,
    onSelectTab(tabId) {
      handleTabClick(tabId);
    },
    onTabMenu: openTabContextMenu,
    onRenameTab: handleRenameTab,
    onRenameTabStart(tabId) {
      if (!ensureReadyForAction()) return;
      chrome.startRenameTab(tabId);
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

  const menu = createMenu({
    container: chrome.topRoot,
    theme: chrome.theme,
    getReturnFocus: () => editor.textarea,
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

  function openNumberFormatMenu() {
    const info = activeCellInfo();
    menu.open({
      anchor: chrome.getButton("number-format"),
      label: "Number format",
      items: numberFormatMenuItems({
        activeValue: info?.cell?.value ?? null,
        activeFmt: info?.effectiveFmt ?? null,
        formatValue: win.Sap?.grid?.formatValue,
        onPick: (fmt) => runFormat((g, v) => applyNumberFormat(g, v, sel, fmt)),
      }),
    });
  }

  function openColorMenu(kind) {
    const info = activeCellInfo();
    const st = cellStyleState(info?.cell);
    const isText = kind === "text";
    menu.open({
      anchor: chrome.getButton(isText ? "text-color" : "fill-color"),
      label: isText ? "Text color" : "Fill color",
      items: colorMenuItems({
        current: isText ? st.color : st.fillColor,
        onPick: (hex) => runFormat((g, v) => (isText ? applyTextColor(g, v, sel, hex) : applyFillColor(g, v, sel, hex))),
      }),
    });
  }

  function openBordersMenu() {
    menu.open({
      anchor: chrome.getButton("borders"),
      label: "Borders",
      items: borderMenuItems({
        onPick: (preset) => runFormat((g, v) => applyBorder(g, v, sel, preset)),
      }),
    });
  }

  function openAlignMenu() {
    const info = activeCellInfo();
    const st = cellStyleState(info?.cell);
    menu.open({
      anchor: chrome.getButton("align"),
      label: "Horizontal align",
      items: alignMenuItems({
        current: st.align,
        onPick: (align) => runFormat((g, v) => applyAlign(g, v, sel, align)),
      }),
    });
  }

  function triggerMerge() {
    if (editor.editing || !sel) return;
    const table = tabTable(workbook, sel.tab);
    const grid = gridOf(table);
    if (!grid) return;
    const view = viewOf(sel.tab);
    runMergeCommand({
      grid,
      view,
      sel,
      history,
      runWrite: (fn) => {
        const ok = writeGrid(fn);
        if (ok) syncUI({ announce: true });
        return ok;
      },
      promptKeep: (filled, onChoose) => {
        activeDialog = showDialog(sel.tab, openMergeKeepDialog({
          doc,
          theme: chrome.theme,
          container: chrome.topRoot,
          items: filled,
          totalCount: filled.length,
          getReturnFocus: () => editor.textarea,
          onConfirm: (chosen) => {
            clearDialog();
            onChoose(chosen);
          },
          onCancel: () => {
            clearDialog();
          },
        }));
      },
    });
  }

  function syncToolbar(selView) {
    const selTable = tabTable(workbook, sel.tab);
    const selGrid = gridOf(selTable);
    const canEdit = !editor.editing && Boolean(selGrid);
    if (editor.editing && menu.isOpen) menu.close({ restoreFocus: false });

    const info = activeCellInfo();
    const st = cellStyleState(info?.cell);
    chrome.setButtonPressed("bold", st.bold);
    chrome.setButtonPressed("italic", st.italic);
    chrome.setButtonPressed("strikethrough", st.strikethrough);
    chrome.setButtonPressed("wrap", st.wrap);
    chrome.setButtonText("number-format", st.formatLabel);

    const mState = canEdit ? inspectMerge(selGrid, selView, sel, { scan: false }) : { canAct: false, isSingleMerge: false };
    chrome.setButtonText(
      "merge",
      mState.isSingleMerge ? "Unmerge" : "Merge",
      mState.isSingleMerge ? "Unmerge cells" : "Merge cells",
    );

    chrome.registerCommand("undo", canEdit && history.canUndo(sel.tab) ? () => replayStep("undo") : null);
    chrome.registerCommand("redo", canEdit && history.canRedo(sel.tab) ? () => replayStep("redo") : null);
    chrome.registerCommand("number-format", canEdit ? openNumberFormatMenu : null);
    chrome.registerCommand("currency", canEdit ? () => runFormat((g, v) => applyNumberFormat(g, v, sel, "$#,##0.00")) : null);
    chrome.registerCommand("percent", canEdit ? () => runFormat((g, v) => applyNumberFormat(g, v, sel, "0.00%")) : null);
    chrome.registerCommand("decimals-less", canEdit ? () => runFormat((g, v) => applyDecimals(g, v, sel, history, -1, win.Sap?.grid?.adjustDecimals)) : null);
    chrome.registerCommand("decimals-more", canEdit ? () => runFormat((g, v) => applyDecimals(g, v, sel, history, 1, win.Sap?.grid?.adjustDecimals)) : null);
    chrome.registerCommand("bold", canEdit ? () => runFormat((g, v) => applyStyleToggle(g, v, sel, history, "bold")) : null);
    chrome.registerCommand("italic", canEdit ? () => runFormat((g, v) => applyStyleToggle(g, v, sel, history, "italic")) : null);
    chrome.registerCommand("strikethrough", canEdit ? () => runFormat((g, v) => applyStyleToggle(g, v, sel, history, "strikethrough")) : null);
    chrome.registerCommand("text-color", canEdit ? () => openColorMenu("text") : null);
    chrome.registerCommand("fill-color", canEdit ? () => openColorMenu("fill") : null);
    chrome.registerCommand("borders", canEdit ? openBordersMenu : null);
    chrome.registerCommand("merge", canEdit && mState.canAct ? triggerMerge : null);
    chrome.registerCommand("align", canEdit ? openAlignMenu : null);
    chrome.registerCommand("wrap", canEdit ? () => runFormat((g, v) => applyStyleToggle(g, v, sel, history, "wrap")) : null);
    chrome.registerCommand("add-tab", canEdit ? handleAddTab : null);

    for (const extraId of ["filter", "sort", "checkbox", "chart", "find", "import"]) {
      const ext = externalCommands[extraId];
      chrome.registerCommand(extraId, !editor.editing && typeof ext === "function" ? ext : null);
    }
  }

  function syncUI({ announce = false, enteredTab = false } = {}) {
    if (disposed || !sel) return;
    const shownId = tabs.activeId;
    const table = tabTable(workbook, shownId);
    const view = viewOf(shownId);
    const selView = shownId === sel.tab ? view : viewOf(sel.tab);
    const box = shownId === sel.tab ? selectionBox(view, sel) : null;

    chrome.setEditing(editor.editing);
    syncToolbar(selView);
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

    closeTransient();
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
    if (!writeGrid(() => grid.clear(commandArea(view, sel)))) return;
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
    const own = ownerOf(view, top, left);
    return {
      tab: current.tab,
      anchor: { row: view.rows[own.r], col: view.cols[own.c] },
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

  function handleInsertAxisShortcut() {
    const view = viewOf(sel.tab);
    const span = axisSpan(view, sel);
    if (span?.axis === "cols") {
      insertColsAt(span.first, span.last - span.first + 1, colName(span.first), true);
      return;
    }
    if (span?.axis === "rows") {
      insertRowsAt(span.first, span.last - span.first + 1, span.first + 1, true);
      return;
    }
    const box = selectionBox(view, sel);
    if (box) insertRowsAt(box.top, 1, box.top + 1, false);
  }

  function handleDeleteAxisShortcut() {
    const span = axisSpan(viewOf(sel.tab), sel);
    if (span?.axis === "rows") deleteRowsAt(span.first, span.last);
    else if (span?.axis === "cols") deleteColsAt(span.first, span.last);
  }

  function handleContextMenuShortcut() {
    const view = viewOf(sel.tab);
    const span = axisSpan(view, sel);
    if (span?.axis === "rows") {
      const hdr = overlays.shadow.querySelector(`[data-row="${span.first}"]`);
      openRowHeaderMenu(span.first, hdr, null, null);
      return;
    }
    if (span?.axis === "cols") {
      const hdr = overlays.shadow.querySelector(`[data-col="${span.first}"]`);
      openColHeaderMenu(span.first, hdr, null, null);
      return;
    }
    const box = selectionBox(view, sel);
    if (!box) return;
    const table = tabTable(workbook, sel.tab);
    const cb = overlays.cellBox(table, windowOf(table), box.active.r, box.active.c);
    openCellContextMenu(box.active.r, box.active.c, cb?.left ?? 0, (cb?.top ?? 0) + (cb?.height ?? 0));
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
      case "bold":
      case "italic":
      case "underline":
      case "strikethrough":
        runFormat((g, v) => applyStyleToggle(g, v, sel, history, intent.type));
        break;
      case "align":
        runFormat((g, v) => applyAlign(g, v, sel, intent.align));
        break;
      case "numberFormat":
        runFormat((g, v) => applyNumberFormat(g, v, sel, intent.fmt));
        break;
      case "clearFormat":
        runFormat((g, v) => applyClearFormatting(g, v, sel, history));
        break;
      case "insertAxis":
        handleInsertAxisShortcut();
        break;
      case "deleteAxis":
        handleDeleteAxisShortcut();
        break;
      case "contextMenu":
        handleContextMenuShortcut();
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
    chrome.commitRename();
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

  function onContextMenu(event) {
    const hit = locateCellEvent(event);
    if (!hit) return;
    event.preventDefault();
    if (!ensureReadyForAction()) return;
    const view = viewOf(hit.tab);
    const box = hit.tab === sel.tab ? selectionBox(view, sel) : null;
    if (!box || hit.r < box.top || hit.r > box.bottom || hit.c < box.left || hit.c > box.right) {
      actOnCellPointer(hit, { extend: false });
    }
    const span = hit.tab === sel.tab ? axisSpan(viewOf(sel.tab), sel) : null;
    if (span?.axis === "rows") return openRowHeaderMenu(hit.r, null, event.clientX ?? 0, event.clientY ?? 0);
    if (span?.axis === "cols") return openColHeaderMenu(hit.c, null, event.clientX ?? 0, event.clientY ?? 0);
    openCellContextMenu(hit.r, hit.c, event.clientX ?? 0, event.clientY ?? 0);
  }

  function subscribeGrids() {
    shell?.restart?.();
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
          else onForeignChange(tab.id);
          const rw = windowOf(tab.table);
          if (rw?.geometry && event.rows?.changed?.length) {
            for (const rowId of event.rows.changed) {
              const idx = rw.geometry.indexOf(rowId);
              if (idx === -1) continue;
              const tr = rw.geometry.row(idx);
              if (tr.offsetHeight === 0 && !tr.hidden) {
                const h = Number.parseFloat(tr.style?.height);
                rw.geometry.setRowHeight(idx, Number.isFinite(h) && h > 0 ? h : ROW_ESTIMATE);
              }
            }
          }
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
    closeTransient();
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
  workbook.addEventListener("contextmenu", onContextMenu);
  scrollTarget.addEventListener("scroll", onViewportMove, { passive: true });
  win.addEventListener("resize", onViewportMove);

  initSelection();
  subscribeGrids();

  function dispose() {
    if (disposed) return;
    disposed = true;
    closeDialog();
    menu.dispose();
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
    workbook.removeEventListener("contextmenu", onContextMenu);
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
    menu,
    get selection() {
      return sel ? { tab: sel.tab, anchor: { ...sel.anchor }, focus: { ...sel.focus } } : null;
    },
    registerCommand(id, fn) {
      if (typeof fn === "function") externalCommands[id] = fn;
      else delete externalCommands[id];
      chrome.registerCommand(id, fn);
    },
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
  measureText = null,
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
        instances.set(el, createWorkbookInterface(el, { shell, storage, tabOptions, commands, platform, measureText }));
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
