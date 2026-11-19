import { a1, colIndex, rowIndex, tabTable } from "./commit.js";
import { createChrome } from "./chrome.js";
import { copyParts, fillBlock, fillFormula, pasteBlock, transposeMatrix } from "./clipboard.js";
import { createEditor } from "./editor.js";
import { ROW_ESTIMATE } from "./geometry.js";
import { createHistory } from "./history.js";
import { keyIntent } from "./keys.js";
import { createOverlays } from "./overlays.js";
import {
  axisSpan,
  clipSelection,
  commandArea,
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
  selectionArea,
  selectionBox,
  selectRows,
  selectRowsAt,
  sheetCornerSelection,
  writeSelection,
} from "./selection.js";
import { createTabs } from "./tabs.js";

const WORKBOOK = "[sheet-workbook]";
const STATUS_CELL_CAP = 100_000;
const CHANGED_MSG = "Those cells changed since, so that step was not undone.";
const REDONE_MSG = "Those cells changed since, so that step was not redone.";

const FORMAT_LABELS = new Map([
  [null, "Automatic"],
  ["@", "Plain text"],
  ["#,##0.00", "Number"],
  ["#,##0", "Thousands"],
  ["0.00%", "Percent"],
  ["$#,##0.00", "Currency"],
  ["m/d/yyyy", "Date"],
  ["mmmm d, yyyy", "Long date"],
  ["h:mm AM/PM", "Time"],
  ["m/d/yyyy h:mm", "Date and time"],
]);

const LAZY_TOOLBAR_IDS = [
  "number-format",
  "currency",
  "percent",
  "decimals-less",
  "decimals-more",
  "bold",
  "italic",
  "strikethrough",
  "text-color",
  "fill-color",
  "borders",
  "merge",
  "align",
  "wrap",
  "add-tab",
];

let importChain = Promise.resolve();
const queueImport = (loader) => {
  const next = importChain.then(loader);
  importChain = next.catch(() => {});
  return next;
};

const LAZY_FAIL_MESSAGE = "That tool could not load. Check your connection and try again.";

export function lazyModule(loader, onFail) {
  let promise = null;
  let value = null;
  return {
    peek: () => value,
    put: (mod) => {
      value = mod;
      return mod;
    },
    load: () => {
      if (promise) return promise;
      promise = queueImport(loader).then(
        (mod) => {
          value = mod;
          return mod;
        },
        () => {
          promise = null;
          onFail?.();
          return null;
        },
      );
      return promise;
    },
  };
}

const samePoint = (a, b) => a?.row === b?.row && a?.col === b?.col;

function sameSelection(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.tab === b.tab && samePoint(a.anchor, b.anchor) && samePoint(a.focus, b.focus);
}

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

const formatCount = (n, singular, plural) => `${n.toLocaleString("en-US")} ${n === 1 ? singular : plural}`;

function quickToolbarStyle(cell) {
  const css = typeof cell?.style === "string" ? cell.style : "";
  let fw = "";
  let fs = "";
  let td = "";
  let ws = "";
  if (css) {
    for (const part of css.split(";")) {
      const colon = part.indexOf(":");
      if (colon === -1) continue;
      const k = part.slice(0, colon).trim().toLowerCase();
      const v = part.slice(colon + 1).trim().toLowerCase();
      if (k === "font-weight") fw = v;
      else if (k === "font-style") fs = v;
      else if (k === "text-decoration") td = v;
      else if (k === "white-space") ws = v;
    }
  }
  const rawFmt = cell?.effectiveFmt;
  const normFmt = rawFmt === "" || rawFmt === undefined ? null : rawFmt;
  return {
    bold: fw === "bold" || fw === "bolder" || (/^\d+$/.test(fw) && Number(fw) >= 700),
    italic: fs === "italic" || fs === "oblique",
    strikethrough: /\bline-through\b/.test(td),
    wrap: ws === "pre-wrap",
    formatLabel: FORMAT_LABELS.get(normFmt) ?? "Custom",
  };
}

function quickMergeState(grid, view, sel) {
  const box = selectionBox(view, sel);
  if (!box || !grid) return { canAct: false, isSingleMerge: false };
  if ((box.bottom - box.top + 1) * (box.right - box.left + 1) < 2) return { canAct: false, isSingleMerge: false };
  const tl = ownerOf(view, box.top, box.left);
  return {
    canAct: true,
    isSingleMerge:
      tl.r === box.top &&
      tl.c === box.left &&
      tl.rows === box.bottom - box.top + 1 &&
      tl.cols === box.right - box.left + 1,
  };
}

function safeLinkUrl(raw) {
  if (typeof raw !== "string") return null;
  const str = raw.trim();
  if (!str || /\s/.test(str) || !/^(?:https?:\/\/|mailto:)/i.test(str)) return null;
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    return null;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.hostname ? str : null;
  if (parsed.protocol === "mailto:") return parsed.pathname.trim() ? str : null;
  return null;
}

function extractHyperlinkLiteral(formula, tokenize) {
  if (typeof tokenize !== "function") return null;
  const tokens = tokenize(formula);
  if (
    tokens.length < 5 ||
    tokens[0]?.value !== "=" ||
    tokens[1]?.type !== "name" ||
    tokens[1]?.value !== "HYPERLINK" ||
    tokens[2]?.type !== "punct" ||
    tokens[2]?.value !== "(" ||
    tokens[3]?.type !== "str" ||
    tokens[4]?.type !== "punct" ||
    (tokens[4].value !== "," && tokens[4].value !== ")")
  ) {
    return null;
  }
  let depth = 0;
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "punct" && t.value === "(") depth += 1;
    else if (t.type === "punct" && t.value === ")") {
      depth -= 1;
      if (depth === 0) return i === tokens.length - 1 ? { literal: tokens[3].value } : null;
    }
  }
  return null;
}

export function extractCellLink(cell, tokenize) {
  if (!cell) return null;
  if (cell.content !== null && typeof cell.content === "object" && typeof cell.content.f === "string") {
    const hl = extractHyperlinkLiteral(cell.content.f, tokenize);
    if (hl) return safeLinkUrl(hl.literal);
  }
  return safeLinkUrl(cell.text);
}

function createWorkbookInterface(workbook, { shell, storage, tabOptions, commands, platform, measureText, loaders = {} }) {
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
  let liveMenu = null;
  let cmdActions = null;
  let findCtrl = null;
  let fnHelp = null;
  let fillDrag = null;
  let statusCache = "";

  const alive = () => !disposed;
  const onLazyFail = () => {
    if (alive()) chrome.showNotice(LAZY_FAIL_MESSAGE);
  };
  const cmdTool = lazyModule(loaders.commands ?? (() => import("./format-commands.js")), onLazyFail);
  const fillTool = lazyModule(loaders.fill ?? (() => import("./fill.js")), onLazyFail);
  const findTool = lazyModule(loaders.find ?? (() => import("./find.js")), onLazyFail);
  const pasteSpecialTool = lazyModule(loaders.pasteSpecial ?? (() => import("./paste-special.js")), onLazyFail);
  const shortcutsTool = lazyModule(loaders.shortcuts ?? (() => import("./shortcuts.js")), onLazyFail);
  // Function help is never asked for, so a failed load stays quiet instead of a notice per keystroke.
  const functionHelpTool = lazyModule(loaders.functionHelp ?? (() => import("./function-help.js")), null);
  const csvTool = lazyModule(
    loaders.csv ??
      (async () => {
        if (!cmdTool.peek()) cmdTool.put(await import("./format-commands.js"));
        return import("./csv.js");
      }),
    onLazyFail,
  );
  let pendingLazy = null;

  function runLazy(holder, fn, { guardSel = false } = {}) {
    const snap = sel;
    const ready = holder.peek();
    if (ready) {
      pendingLazy = null;
      if (!guardSel || sameSelection(sel, snap)) fn(ready);
      return;
    }
    pendingLazy = fn;
    holder.load().then((mod) => {
      if (!alive() || !mod || pendingLazy !== fn) return;
      pendingLazy = null;
      if (guardSel && !sameSelection(sel, snap)) return;
      fn(mod);
    });
  }
  const gridOf = (table) => (table && typeof win.Sap?.grid === "function" ? win.Sap.grid(table) : null);
  const history = createHistory(workbook, gridOf);
  const isMac = () => /mac|iphone|ipad|ipod/i.test(String(platform ?? win.navigator?.platform ?? ""));

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
    if (liveMenu?.isOpen) liveMenu.close({ restoreFocus: false });
    closeDialog();
  }

  function onForeignChange(tabId) {
    if (liveMenu?.isOpen && tabId === sel?.tab) liveMenu.close({ restoreFocus: false });
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

  function computeStatusText() {
    if (!sel || tabs.activeId !== sel.tab) return "";
    const grid = gridOf(tabTable(workbook, sel.tab));
    if (!grid) return "";
    const box = selectionBox(viewOf(sel.tab), sel);
    if (!box) return "";
    const spanCount = (box.bottom - box.top + 1) * (box.right - box.left + 1);
    if (spanCount < 2 || spanCount > STATUS_CELL_CAP) return "";
    if (
      box.top === box.active.r &&
      box.left === box.active.c &&
      box.bottom === box.active.r + box.active.rows - 1 &&
      box.right === box.active.c + box.active.cols - 1
    ) {
      return "";
    }
    let uncovered = 0;
    let filled = 0;
    let nums = 0;
    let sum = 0;
    for (let r = box.top; r <= box.bottom; r++) {
      for (let c = box.left; c <= box.right; c++) {
        const cell = grid.cell(a1(r, c));
        if (!cell || cell.covered) continue;
        uncovered += 1;
        if (cell.content !== null && cell.content !== "") filled += 1;
        if (typeof cell.value === "number" && Number.isFinite(cell.value)) {
          nums += 1;
          sum += cell.value;
        }
      }
    }
    if (uncovered < 2) return "";
    if (nums > 0) {
      const activeFmt = grid.cell(a1(box.active.r, box.active.c))?.effectiveFmt ?? null;
      const sap = win.Sap?.grid;
      const kind = typeof sap?.fmtKind === "function" ? sap.fmtKind(activeFmt) : "auto";
      const numFmt = kind === "number" || kind === "currency" || kind === "percent" ? activeFmt : null;
      const fmtNum = (n) =>
        typeof sap?.formatValue === "function" ? (sap.formatValue(n, numFmt) ?? sap.formatValue(n, null) ?? String(n)) : String(n);
      return `Sum ${fmtNum(Number(sum.toPrecision(15)))} · Average ${fmtNum(Number((sum / nums).toPrecision(15)))} · Count ${nums}`;
    }
    return filled > 0 ? `Count ${filled}` : "";
  }

  const refreshStatus = () => {
    statusCache = computeStatusText();
  };

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
    return {
      tab: point.tab,
      row: point.row,
      col: point.col,
      r,
      c,
      ref,
      text: cell?.text ?? "",
      input: grid ? grid.input(ref) : "",
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
    return `${tab?.name || info.tab}, ${formatCount(view.rows.length, "row", "rows")}, ${formatCount(view.cols.length, "column", "columns")}, ${valuePart}`;
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
    refreshStatus();
    syncUI({ announce: true });
    return true;
  }

  const sharedCtx = () => ({
    doc,
    win,
    workbook,
    chrome,
    overlays,
    editor,
    tabs,
    history,
    getSel: () => sel,
    setSel: (next) => {
      sel = next;
    },
    viewOf,
    gridOf,
    windowOf,
    activeCellInfo,
    ensureReadyForAction,
    runFormat,
    writeGrid,
    withMine,
    commitEdit,
    runTabStep,
    syncUI,
    refreshStatus,
    applySelection,
    applyMove,
    subscribeGrids,
    restart,
    showDialog,
    clearDialog,
    applyPasteData,
    platform: platform ?? win.navigator?.platform ?? "",
    isMac,
    measureText,
  });

  const triggerFillShortcut = (axis) => runLazy(fillTool, (f) => f.runShortcutFill(sharedCtx(), axis), { guardSel: true });

  function ensureCommands(b) {
    liveMenu ??= b.createMenu({
      container: chrome.topRoot,
      theme: chrome.theme,
      getReturnFocus: () => editor.textarea,
    });
    cmdActions ??= b.createCommandActions({
      ...sharedCtx(),
      menu: liveMenu,
      onFillShortcut: triggerFillShortcut,
      onPasteSpecial: (mode) => runLazy(pasteSpecialTool, (ps) => ps.runPasteSpecial(sharedCtx(), mode)),
      onShortcuts: () => runLazy(shortcutsTool, (s) => s.showShortcutsDialog(sharedCtx())),
    });
    return { menu: liveMenu, actions: cmdActions };
  }

  const ensureFind = (f) => (findCtrl ??= f.createFindController(sharedCtx()));

  function ensureFunctionHelp(mod) {
    fnHelp ??= mod.createFunctionHelp({
      container: chrome.topRoot,
      win,
      theme: chrome.theme,
      editor,
      overlays,
    });
    return fnHelp;
  }

  function syncFunctionHelp() {
    if (!editor.editing || editor.isTextCell() || !editor.buffer.startsWith("=")) {
      fnHelp?.update();
      return;
    }
    const ready = functionHelpTool.peek();
    if (ready) {
      ensureFunctionHelp(ready).update();
      return;
    }
    functionHelpTool.load().then((mod) => {
      if (!alive() || !mod) return;
      ensureFunctionHelp(mod).update();
    });
  }

  const overlays = createOverlays(workbook, {
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
    onResizeCol: (c, px) => runLazy(cmdTool, (b) => ensureCommands(b).actions.handleResizeCol(c, px)),
    onResizeRow: (r, px) => runLazy(cmdTool, (b) => ensureCommands(b).actions.handleResizeRow(r, px)),
    onFitCol: (c) => runLazy(cmdTool, (b) => ensureCommands(b).actions.handleFitCol(c)),
    onColMenu: (c, hdr, x, y) => runLazy(cmdTool, (b) => ensureCommands(b).actions.openColHeaderMenu(c, hdr, x, y)),
    onRowMenu: (r, hdr, x, y) => runLazy(cmdTool, (b) => ensureCommands(b).actions.openRowHeaderMenu(r, hdr, x, y)),
    onFillHandleDown(e) {
      if (editor.editing || !sel || sel.whole) return;
      const box = selectionBox(viewOf(sel.tab), sel);
      if (!box) return;
      fillDrag = {
        tab: sel.tab,
        sourceBox: { top: box.top, left: box.left, bottom: box.bottom, right: box.right },
        startX: e.clientX ?? 0,
        startY: e.clientY ?? 0,
        hasCoords: (e.clientX ?? 0) !== 0 || (e.clientY ?? 0) !== 0,
        lastHit: null,
        lastDx: 0,
        lastDy: 0,
        targetBox: null,
      };
      fillTool.load();
    },
    onFillHandleDblClick: () => runLazy(fillTool, (f) => f.runAutoFillDown(sharedCtx()), { guardSel: true }),
  });

  const chrome = createChrome({
    scrollBox,
    commands: externalCommands,
    onSelectTab: handleTabClick,
    onTabMenu: (tabId, btn, x, y) => runLazy(cmdTool, (b) => ensureCommands(b).actions.openTabContextMenu(tabId, btn, x, y)),
    onRenameTab(tabId, nextName) {
      const ready = cmdTool.peek();
      if (ready) return ensureCommands(ready).actions.handleRenameTab(tabId, nextName);
      runLazy(cmdTool, (b) => ensureCommands(b).actions.handleRenameTab(tabId, nextName));
      return true;
    },
    onRenameTabStart(tabId) {
      if (!ensureReadyForAction()) return;
      runLazy(cmdTool, (b) => ensureCommands(b).actions.startTabRename(tabId));
    },
    onGoTo(raw) {
      if (!ensureReadyForAction()) return false;
      runLazy(findTool, (f) => ensureFind(f).goTo(raw));
      return true;
    },
    onCancelGoTo: () => editor.focus(),
    onCommit() {
      if (!editor.editing) return;
      const res = commitEdit();
      if (res.ok) {
        applySelection(moveSelection(viewOf(sel.tab), sel, { dr: 1, dc: 0, extend: false }));
        revealFocus();
        editor.focus();
      }
    },
    onCancel: () => editor.cancel(),
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
    onCaretChange: () => fnHelp?.update(),
    onNotice: (msg) => chrome.showNotice(msg),
    onClearNotice: () => chrome.hideNotice(),
  });

  function syncToolbar(selView) {
    const selGrid = gridOf(tabTable(workbook, sel.tab));
    const canEdit = !editor.editing && Boolean(selGrid);
    if (editor.editing && liveMenu?.isOpen) liveMenu.close({ restoreFocus: false });

    const info = activeCellInfo();
    const st = quickToolbarStyle(info?.cell);
    chrome.setButtonPressed("bold", st.bold);
    chrome.setButtonPressed("italic", st.italic);
    chrome.setButtonPressed("strikethrough", st.strikethrough);
    chrome.setButtonPressed("wrap", st.wrap);
    chrome.setButtonText("number-format", st.formatLabel);

    const mState = canEdit ? quickMergeState(selGrid, selView, sel) : { canAct: false, isSingleMerge: false };
    chrome.setButtonText(
      "merge",
      mState.isSingleMerge ? "Unmerge" : "Merge",
      mState.isSingleMerge ? "Unmerge cells" : "Merge cells",
    );

    chrome.registerCommand("undo", canEdit && history.canUndo(sel.tab) ? () => replayStep("undo") : null);
    chrome.registerCommand("redo", canEdit && history.canRedo(sel.tab) ? () => replayStep("redo") : null);
    for (const id of LAZY_TOOLBAR_IDS) {
      const ok = canEdit && (id !== "merge" || mState.canAct);
      chrome.registerCommand(id, ok ? () => runLazy(cmdTool, (b) => ensureCommands(b).actions.runToolbarCommand(id)) : null);
    }

    const extFind = externalCommands.find;
    chrome.registerCommand(
      "find",
      !editor.editing
        ? typeof extFind === "function"
          ? extFind
          : canEdit
            ? () => ensureReadyForAction() && runLazy(findTool, (f) => ensureFind(f).open({ replace: true }))
            : null
        : null,
    );
    const extImport = externalCommands.import;
    chrome.registerCommand(
      "import",
      !editor.editing
        ? typeof extImport === "function"
          ? extImport
          : canEdit
            ? () => ensureReadyForAction() && sel && runLazy(csvTool, (c) => c.openCsvMenu(sharedCtx(), ensureCommands(cmdTool.peek()).menu))
            : null
        : null,
    );

    for (const extraId of ["filter", "sort", "checkbox", "chart"]) {
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
    chrome.setStatus(statusCache);
    chrome.renderTabs(tabs.list(), shownId);
    if (!editor.editing) editor.refreshReady();

    const speech = cellSpeech(enteredTab);
    editor.setAriaLabel(speech);
    if (announce) overlays.announce(speech);

    const activeInfo = shownId === sel.tab && !editor.editing ? activeCellInfo() : null;
    const linkUrl = activeInfo ? extractCellLink(activeInfo.cell, win.Sap?.grid?.tokenize) : null;

    overlays.render({
      table,
      win: windowOf(table),
      view,
      box,
      whole: shownId === sel.tab ? (sel.whole ?? null) : null,
      editing: editor.editing && shownId === sel.tab,
      refs: editor.refs(),
      shownTab: shownId,
      fillPreviewBox: fillDrag?.tab === shownId ? fillDrag.targetBox : null,
      linkUrl,
    });
    findCtrl?.syncTab();
    syncFunctionHelp();
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
    refreshStatus();
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
    refreshStatus();
    syncUI({ announce: true, enteredTab: true });
  }

  function handleTabClick(tabId) {
    editor.settle();
    const targetTab = tabs.list().find((t) => t.id === tabId);
    if (!targetTab) return;

    if (editor.editing && editor.canPick()) {
      if (tabId === tabs.activeId) return editor.focus();
      tabs.show(tabId);
      editor.pickCell({ tab: tabId, tabName: targetTab.name, r: 0, c: 0, extend: false });
      refreshStatus();
      syncUI({ announce: false });
      return;
    }

    if (editor.editing && !commitEdit().ok) return;
    if (tabId === sel.tab && tabs.activeId === tabId) return editor.focus();

    closeTransient();
    const view = viewOf(tabId);
    tabs.show(tabId);
    applySelection(createSelection(view, tabId), { announce: true, enteredTab: true });
    editor.focus();
  }

  function pageRowsCount() {
    const scroller = scrollerOf(workbook);
    const h = scroller ? scroller.clientHeight : win.innerHeight;
    return Math.max(1, Math.floor((h || 520) / ROW_ESTIMATE));
  }

  function clearSelectedCells() {
    const grid = gridOf(tabTable(workbook, sel.tab));
    if (!grid) return;
    const view = viewOf(sel.tab);
    if (view.rows.length === 0 || view.cols.length === 0) return;
    if (!writeGrid(() => grid.clear(commandArea(view, sel)))) return;
    refreshStatus();
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
    else {
      refreshStatus();
      syncUI({ announce: true });
    }
  }

  function copySelection(cut = false) {
    const grid = gridOf(tabTable(workbook, sel.tab));
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

  function applyPasteData({ html = "", text = "", valuesOnly = false, transpose = false, formatOnly = false } = {}) {
    if (disposed || editor.editing || !sel) return false;
    const grid = gridOf(tabTable(workbook, sel.tab));
    if (!grid) return false;
    const view = viewOf(sel.tab);
    if (view.rows.length === 0 || view.cols.length === 0) return false;
    const box = selectionBox(view, sel);
    if (!box) return false;
    const at = a1(box.top, box.left);
    const singleMerge =
      box.top === box.active.r &&
      box.left === box.active.c &&
      box.bottom === box.active.r + box.active.rows - 1 &&
      box.right === box.active.c + box.active.cols - 1;
    const [selRows, selCols] = singleMerge ? [1, 1] : [box.bottom - box.top + 1, box.right - box.left + 1];
    const parsed = pasteBlock(html, { r: box.top, c: box.left }, { valuesOnly, transpose, formatOnly });
    const uncovered = (write) =>
      write.map((line, i) => line.map((item, j) => (view.cell(box.top + i, box.left + j)?.covered ? undefined : item)));

    let rows = 0;
    let cols = 0;

    if (formatOnly) {
      if (parsed?.kind !== "ours") {
        chrome.showNotice("Format only works with cells copied from a sheet.");
        return false;
      }
      const { block } = parsed;
      const write = block.length === 1 && block[0].length === 1 ? fillBlock(block, selRows, selCols) : block;
      // Formats never grow the sheet: what falls past the last row or column is left off.
      rows = Math.min(write.length, view.rows.length - box.top);
      cols = Math.min(write[0]?.length ?? 0, view.cols.length - box.left);
      if (rows <= 0 || cols <= 0) return false;
      const ok = writeGrid(() =>
        history.group(sel.tab, () => {
          // One source cell formats the whole target in one Grid step; a cell at a time froze large ranges.
          if (block.length === 1 && block[0].length === 1) {
            const item = block[0][0];
            grid.format(`${at}:${a1(box.top + rows - 1, box.left + cols - 1)}`, { fmt: item.fmt ?? null, style: item.style });
            return;
          }
          for (let i = 0; i < rows; i++) {
            for (let j = 0; j < cols; j++) {
              if (view.cell(box.top + i, box.left + j)?.covered) continue;
              const item = write[i]?.[j];
              if (!item) continue;
              grid.format(a1(box.top + i, box.left + j), { fmt: item.fmt ?? null, style: item.style });
            }
          }
        }),
      );
      if (!ok) return false;
    } else if (parsed && (parsed.kind === "ours" || !text)) {
      const { kind, block, origin } = parsed;
      let write = block;
      if (
        kind === "ours" &&
        !valuesOnly &&
        block.length === 1 &&
        block[0].length === 1 &&
        block[0][0]?.content &&
        typeof block[0][0].content === "object" &&
        typeof block[0][0].content.f === "string"
      ) {
        const item = block[0][0];
        write = uncovered(fillFormula(item.content.f, item.fmt, box.top - origin.r, box.left - origin.c, selRows, selCols, item.style));
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
      const options =
        kind === "ours"
          ? valuesOnly
            ? { grow: true, detect: false, formats: false }
            : { grow: true }
          : { grow: true, formulas: !valuesOnly };
      if (!writeGrid(() => grid.setRange(at, write, options))) return false;
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
      const matrix = transpose ? transposeMatrix(lines, "") : lines;
      const one = matrix.length === 1 && (matrix[0]?.length ?? 0) === 1;
      const filled = fillBlock(matrix, selRows, selCols);
      rows = filled.length;
      cols = Math.max(0, ...filled.map((line) => line.length));
      if (!rows || !cols) return false;
      const options = { grow: true, formulas: !valuesOnly };
      let wrote;
      if (one) {
        wrote = writeGrid(() => grid.setRange(at, uncovered(filled), options));
      } else if (!transpose) {
        wrote = writeGrid(() => grid.importDelimited(text, at, { delimiter: "\t", formulas: !valuesOnly }));
      } else if (typeof win.Sap?.grid?.csv?.writeDelimited === "function") {
        const transposedText = win.Sap.grid.csv.writeDelimited(matrix, { delimiter: "\t" });
        wrote = writeGrid(() => grid.importDelimited(transposedText, at, { delimiter: "\t", formulas: !valuesOnly }));
      } else {
        wrote = writeGrid(() => grid.setRange(at, uncovered(filled), options));
      }
      if (!wrote) return false;
    } else {
      return false;
    }

    if (!rows || !cols) return false;
    const nextView = viewOf(sel.tab);
    if (nextView.rows.length === 0 || nextView.cols.length === 0) return false;
    const bottom = Math.min(box.top + rows - 1, nextView.rows.length - 1);
    const right = Math.min(box.left + cols - 1, nextView.cols.length - 1);
    applyMove({
      tab: sel.tab,
      anchor: { row: nextView.rows[box.top], col: nextView.cols[box.left] },
      focus: { row: nextView.rows[bottom], col: nextView.cols[right] },
    });
    return true;
  }

  function onPaste(event) {
    if (disposed || editor.editing || !sel) return;
    event.preventDefault();
    try {
      const html = event.clipboardData?.getData("text/html") ?? "";
      const text = event.clipboardData?.getData("text/plain") ?? "";
      applyPasteData({ html, text, valuesOnly: valuesNext });
    } finally {
      valuesNext = false;
    }
  }

  function runKey(event) {
    if (disposed || seenKeys.has(event)) return;
    seenKeys.add(event);

    if (editor.editing && fnHelp?.handleKeyDown(event)) return;

    const intent = keyIntent(event, {
      platform: platform ?? win.navigator?.platform ?? "",
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
        handleTabClick(list[(idx + intent.delta + list.length) % list.length].id);
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
      case "fillDown":
        triggerFillShortcut("down");
        break;
      case "fillRight":
        triggerFillShortcut("right");
        break;
      case "find":
        if (ensureReadyForAction()) runLazy(findTool, (f) => ensureFind(f).open({ replace: false }));
        break;
      case "findReplace":
        if (ensureReadyForAction()) runLazy(findTool, (f) => ensureFind(f).open({ replace: true }));
        break;
      case "shortcuts":
        if (ensureReadyForAction()) runLazy(shortcutsTool, (s) => s.showShortcutsDialog(sharedCtx()));
        break;
      case "goto":
        chrome.focusNameBox();
        break;
      case "bold":
      case "italic":
      case "underline":
      case "strikethrough":
        runLazy(cmdTool, (b) => runFormat((g, v) => b.applyStyleToggle(g, v, sel, history, intent.type)), { guardSel: true });
        break;
      case "align":
        runLazy(cmdTool, (b) => runFormat((g, v) => b.applyAlign(g, v, sel, intent.align)), { guardSel: true });
        break;
      case "numberFormat":
        runLazy(cmdTool, (b) => runFormat((g, v) => b.applyNumberFormat(g, v, sel, intent.fmt)), { guardSel: true });
        break;
      case "clearFormat":
        runLazy(cmdTool, (b) => runFormat((g, v) => b.applyClearFormatting(g, v, sel, history)), { guardSel: true });
        break;
      case "insertAxis":
        runLazy(cmdTool, (b) => ensureCommands(b).actions.handleInsertAxisShortcut());
        break;
      case "deleteAxis":
        runLazy(cmdTool, (b) => ensureCommands(b).actions.handleDeleteAxisShortcut());
        break;
      case "contextMenu":
        runLazy(cmdTool, (b) => ensureCommands(b).actions.handleContextMenuShortcut());
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
      case "commitAll":
        runLazy(fillTool, (f) => f.runCommitAll(sharedCtx()), { guardSel: true });
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
    if (el) {
      const cellEl = el.closest?.("td, th");
      if (cellEl && workbook.contains(cellEl)) {
        const table = cellEl.closest("table[grid]");
        const section = table?.parentElement;
        const tr = cellEl.parentElement;
        if (table && section?.matches("section[item]") && tr?.localName === "tr") {
          const tab = section.getAttribute("data-id") ?? "";
          const r = tableRows(table).indexOf(tr);
          if (r !== -1) return { tab, r, c: columnOfCell(cellEl) };
        }
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
      if (!commitEdit().ok) return;
    }
    const view = viewOf(hit.tab);
    const entered = hit.tab !== sel.tab;
    if (entered) tabs.show(hit.tab);
    const baseSel = entered ? createSelection(view, hit.tab) : sel;
    applySelection(selectCell(view, baseSel, hit.r, hit.c, { extend: !entered && extend }), {
      announce: true,
      enteredTab: entered,
    });
    editor.focus();
  }

  function openCellLinkIfMod(event, hit) {
    if (editor.editing || event.shiftKey || event.altKey) return false;
    const modClick = isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!modClick) return false;
    const view = viewOf(hit.tab);
    const own = ownerOf(view, hit.r, hit.c);
    const link = extractCellLink(view.cell(own.r, own.c), win.Sap?.grid?.tokenize);
    if (!link) return false;
    win.open?.(link, "_blank", "noopener,noreferrer");
    return true;
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
    const wasPicking = editor.editing && editor.canPick();
    actOnCellPointer(hit, { extend: event.shiftKey });
    if (!wasPicking && openCellLinkIfMod(event, hit)) {
      dragging = false;
      return;
    }
    dragging = true;
  }

  function onMouseMove(event) {
    if (fillDrag) {
      const hit = locateCellEvent(event);
      if (!hit || hit.tab !== fillDrag.tab) return;
      fillDrag.lastHit = hit;
      fillDrag.lastDx = fillDrag.hasCoords ? (event.clientX ?? 0) - fillDrag.startX : 0;
      fillDrag.lastDy = fillDrag.hasCoords ? (event.clientY ?? 0) - fillDrag.startY : 0;
      const fillMod = fillTool.peek();
      if (fillMod) {
        fillDrag.targetBox = fillMod.dragFillTarget(fillDrag.sourceBox, hit, {
          dx: fillDrag.lastDx,
          dy: fillDrag.lastDy,
          view: viewOf(hit.tab),
        });
        syncUI({ announce: false });
      }
      return;
    }
    if (!dragging) return;
    const hit = locateCellEvent(event);
    if (!hit) return;
    if (editor.editing && editor.canPick()) {
      const tabInfo = tabs.list().find((t) => t.id === hit.tab);
      editor.pickCell({ tab: hit.tab, tabName: tabInfo?.name ?? "", r: hit.r, c: hit.c, extend: true });
      return;
    }
    if (!editor.editing && hit.tab === sel.tab) {
      const nextSel = selectCell(viewOf(sel.tab), sel, hit.r, hit.c, { extend: true });
      if (nextSel.focus.row !== sel.focus.row || nextSel.focus.col !== sel.focus.col || nextSel.whole !== sel.whole) {
        applySelection(nextSel, { announce: false });
      }
    }
  }

  function onMouseUp() {
    if (fillDrag) {
      const done = fillDrag;
      fillDrag = null;
      if (done.lastHit) {
        runLazy(fillTool, (f) => {
          const target =
            done.targetBox ??
            f.dragFillTarget(done.sourceBox, done.lastHit, {
              dx: done.lastDx,
              dy: done.lastDy,
              view: viewOf(done.tab),
            });
          if (target) f.applyFillAction(sharedCtx(), done.sourceBox, target);
          else syncUI({ announce: false });
          editor.focus();
        }, { guardSel: true });
      } else {
        syncUI({ announce: false });
      }
    }
    dragging = false;
  }

  function onClick(event) {
    if (handledPointerDown) {
      handledPointerDown = false;
      return;
    }
    const hit = locateCellEvent(event);
    if (!hit) return;
    const wasPicking = editor.editing && editor.canPick();
    actOnCellPointer(hit, { extend: event.shiftKey });
    if (!wasPicking) openCellLinkIfMod(event, hit);
  }

  function onDblClick(event) {
    if (editor.editing && editor.canPick()) return;
    const hit = locateCellEvent(event);
    if (hit) {
      if (editor.editing && !commitEdit().ok) return;
      applySelection(selectCell(viewOf(hit.tab), { ...sel, tab: hit.tab }, hit.r, hit.c, { extend: false }));
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
    const cx = event.clientX ?? 0;
    const cy = event.clientY ?? 0;
    runLazy(cmdTool, (b) => {
      const { actions } = ensureCommands(b);
      if (span?.axis === "rows") actions.openRowHeaderMenu(hit.r, null, cx, cy);
      else if (span?.axis === "cols") actions.openColHeaderMenu(hit.c, null, cx, cy);
      else actions.openCellContextMenu(hit.r, hit.c, cx, cy);
    });
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
            sel = clipSelection(viewOf(sel.tab), sel, lastViews.get(sel.tab) ?? null);
            writeSelection(storage, path, sel);
          }
          if (tab.id === tabs.activeId) refreshStatus();
          findCtrl?.refresh();
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
    refreshStatus();
    findCtrl?.refresh();
    syncUI({ announce: entered, enteredTab: entered });
  }

  const raf = typeof win.requestAnimationFrame === "function" ? win.requestAnimationFrame.bind(win) : null;
  let framePending = false;

  function redraw() {
    if (disposed || framePending) return;
    if (!raf) return syncUI({ announce: false });
    framePending = true;
    raf(() => {
      framePending = false;
      if (!disposed) syncUI({ announce: false });
    });
  }

  const resizeObserver = typeof win.ResizeObserver === "function" ? new win.ResizeObserver(() => redraw()) : null;
  const onViewportMove = () => redraw();
  const cleanups = [];
  const listen = (el, evt, fn, opts) => {
    el.addEventListener(evt, fn, opts);
    cleanups.push(() => el.removeEventListener(evt, fn, opts));
  };

  listen(win, "keydown", onWindowKeyDown, true);
  listen(editor.textarea, "keydown", runKey);
  listen(editor.textarea, "beforecopy", onBeforeClipboard);
  listen(editor.textarea, "beforecut", onBeforeClipboard);
  listen(editor.textarea, "copy", onCopy);
  listen(editor.textarea, "cut", onCut);
  listen(editor.textarea, "paste", onPaste);
  listen(chrome.formulaInput, "keydown", runKey);
  listen(workbook, "mousedown", onMouseDown);
  listen(win, "mousemove", onMouseMove);
  listen(win, "mouseup", onMouseUp);
  listen(workbook, "click", onClick);
  listen(workbook, "dblclick", onDblClick);
  listen(workbook, "contextmenu", onContextMenu);
  listen(scrollTarget, "scroll", onViewportMove, { passive: true });
  listen(win, "resize", onViewportMove);

  initSelection();
  subscribeGrids();

  const menuProxy = {
    open: (opts) => runLazy(cmdTool, (b) => ensureCommands(b).menu.open(opts)),
    close: (opts) => liveMenu?.close(opts),
    get isOpen() {
      return Boolean(liveMenu?.isOpen);
    },
    get surface() {
      return liveMenu?.surface ?? null;
    },
    dispose: () => liveMenu?.dispose(),
  };

  function dispose() {
    if (disposed) return;
    disposed = true;
    fillDrag = null;
    closeDialog();
    liveMenu?.dispose();
    findCtrl?.dispose();
    fnHelp?.dispose();
    fnHelp = null;
    for (const off of unsubGrids.splice(0)) off();
    for (const off of cleanups.splice(0)) off();
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
    menu: menuProxy,
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
  loaders = {},
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
        instances.set(el, createWorkbookInterface(el, { shell, storage, tabOptions, commands, platform, measureText, loaders }));
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
