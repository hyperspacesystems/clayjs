import { a1, colIndex, rowIndex, tabTable } from "./commit.js";

const LIMIT = 200;
const TAB_ACTIONS = new Set(["insertSheet", "deleteSheet", "renameSheet", "moveSheet"]);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

function actionCoords(action) {
  if (!action || typeof action !== "object") return [];
  if (action.t === "batch" && Array.isArray(action.actions)) return action.actions.flatMap(actionCoords);
  if (action.t === "merge" && Array.isArray(action.from)) return [{ row: action.from[0], col: action.from[1] }];
  if (action.t === "unmerge" && action.row && action.col) return [{ row: action.row, col: action.col }];
  return [];
}

function collectCoords(events) {
  const removedRows = new Set();
  const removedCols = new Set();
  const seen = new Map();
  for (const event of events) {
    for (const id of event.rows?.removed ?? []) removedRows.add(id);
    for (const id of event.cols?.removed ?? []) removedCols.add(id);
    for (const { row, col } of [...(event.cells ?? []), ...actionCoords(event.action)]) {
      if (!row || !col) continue;
      seen.set(`${row}\u0000${col}`, { row, col });
    }
  }
  return [...seen.values()].filter(({ row, col }) => !removedRows.has(row) && !removedCols.has(col));
}

function axisEl(table, kind, id) {
  if (!table) return null;
  const tag = kind === "col" ? "col" : "tr";
  return table.querySelector(`${kind === "col" ? "colgroup > " : ""}${tag}[data-id="${id}"]`);
}

function collectAdded(events, key) {
  const set = new Set();
  for (const event of events) {
    for (const id of event[key]?.added ?? []) set.add(id);
    for (const id of event[key]?.removed ?? []) set.delete(id);
  }
  return [...set];
}

// The sheet's own undo: one list per tab of the actions this interface made, each a Grid change
// event's inverse (or a group's inverses) and the cells it wrote. An undo applies the inverse only
// when every one of those cells still holds what the action wrote (content, fmt, style and merge
// state), so a peer's later edit is never undone (C10 replaces this guard with the room's guarded
// revert). Undo and redo return { ok, cells } or { ok: false, why } with why "empty" or "changed".
export function createHistory(root, gridOf) {
  const tabs = new Map();
  const openGroups = new Map();
  let replaying = false;

  const listOf = (tab) => {
    if (!tabs.has(tab)) tabs.set(tab, { done: [], undone: [] });
    return tabs.get(tab);
  };

  function buildEntry(tab, events) {
    const table = tabTable(root, tab);
    const grid = table ? gridOf(table) : null;
    const coords = collectCoords(events);
    const cells = coords.map(({ row, col }) => {
      const r = table ? rowIndex(table, row) : -1;
      const c = table ? colIndex(table, col) : -1;
      const cell = grid && r >= 0 && c >= 0 ? grid.cell(a1(r, c)) : null;
      return {
        row,
        col,
        after: cell ? cell.content : null,
        fmt: cell ? cell.fmt : null,
        style: cell ? cell.style : null,
        span: cell ? cell.span : null,
        covered: Boolean(cell?.covered),
      };
    });
    const axisStates = [];
    for (const [kind, changed] of [["row", events.flatMap((e) => e.rows?.changed ?? [])], ["col", events.flatMap((e) => e.cols?.changed ?? [])]]) {
      for (const id of new Set(changed)) {
        const el = axisEl(table, kind, id);
        axisStates.push({ kind, id, fmt: el?.getAttribute("fmt") ?? null, style: el?.getAttribute("style") ?? null });
      }
    }
    return {
      inverses: events.map((ev) => ev.inverse),
      cells,
      rows: collectAdded(events, "rows"),
      cols: collectAdded(events, "cols"),
      axisStates,
    };
  }

  function pushDone(tab, entry) {
    const list = listOf(tab);
    list.done.push(entry);
    if (list.done.length > LIMIT) list.done.shift();
    list.undone.length = 0;
  }

  // Called with every change event of a tab's Grid that the interface caused.
  function record(tab, event) {
    if (replaying || event?.source !== "api" || !event.inverse || TAB_ACTIONS.has(event.action?.t)) return;
    const bucket = openGroups.get(tab);
    if (bucket) {
      bucket.push(event);
      return;
    }
    pushDone(tab, buildEntry(tab, [event]));
  }

  function group(tab, fn) {
    if (openGroups.has(tab)) return fn();
    const bucket = [];
    openGroups.set(tab, bucket);
    try {
      return fn();
    } finally {
      openGroups.delete(tab);
      if (bucket.length > 0) pushDone(tab, buildEntry(tab, bucket));
    }
  }

  function addedHoldOnlyOurs(table, grid, entry) {
    const ours = (key, id) => entry.cells.filter((cell) => cell[key] === id && cell.after !== null).length;
    const { rows, cols } = grid.size;
    for (const id of entry.rows) {
      const r = rowIndex(table, id);
      let filled = 0;
      if (r !== -1) for (let c = 0; c < cols; c++) if (grid.cell(a1(r, c)).content !== null) filled += 1;
      if (filled > ours("row", id)) return false;
    }
    for (const id of entry.cols) {
      const c = colIndex(table, id);
      let filled = 0;
      if (c !== -1) for (let r = 0; r < rows; r++) if (grid.cell(a1(r, c)).content !== null) filled += 1;
      if (filled > ours("col", id)) return false;
    }
    return true;
  }

  function stillHolds(table, grid, entry) {
    for (const { row, col, after, fmt, style, span, covered } of entry.cells) {
      const r = rowIndex(table, row);
      const c = colIndex(table, col);
      if (r === -1 || c === -1) return false;
      const cell = grid.cell(a1(r, c));
      if (
        !same(cell.content, after) ||
        cell.fmt !== fmt ||
        !same(cell.style, style) ||
        !same(cell.span, span) ||
        Boolean(cell.covered) !== Boolean(covered)
      ) {
        return false;
      }
    }
    for (const { kind, id, fmt, style } of entry.axisStates ?? []) {
      const el = axisEl(table, kind, id);
      if (!el) return false;
      if ((el.getAttribute("fmt") ?? null) !== fmt || (el.getAttribute("style") ?? null) !== style) return false;
    }
    return addedHoldOnlyOurs(table, grid, entry);
  }

  function replay(tab, from, to) {
    const list = listOf(tab);
    const entry = list[from].pop();
    if (!entry) return { ok: false, why: "empty" };
    const table = tabTable(root, tab);
    const grid = table ? gridOf(table) : null;
    if (!grid || !stillHolds(table, grid, entry)) return { ok: false, why: "changed" };
    replaying = true;
    const events = [];
    try {
      for (let i = entry.inverses.length - 1; i >= 0; i--) {
        const curTable = tabTable(root, tab);
        const curGrid = curTable ? gridOf(curTable) : grid;
        const event = curGrid.apply(entry.inverses[i]);
        if (event?.inverse) events.push(event);
      }
    } finally {
      replaying = false;
    }
    if (events.length > 0) list[to].push(buildEntry(tab, events));
    return { ok: true, cells: collectCoords(events) };
  }

  return {
    record,
    group,
    undo: (tab) => replay(tab, "done", "undone"),
    redo: (tab) => replay(tab, "undone", "done"),
    canUndo: (tab) => listOf(tab).done.length > 0,
    canRedo: (tab) => listOf(tab).undone.length > 0,
    get replaying() {
      return replaying;
    },
  };
}
