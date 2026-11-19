import { a1, colIndex, rowIndex, tabTable } from "./commit.js";

const LIMIT = 200;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The sheet's own undo: one list per tab of the actions this interface made, each a Grid change
// event's inverse and the cells it wrote. An undo applies the inverse only when every one of those
// cells still holds what the action wrote, so a peer's later edit is never undone (C10 replaces
// this guard with the room's guarded revert). Undo and redo return { ok, cells } or
// { ok: false, why } with why "empty" or "changed" (the step was dropped).
export function createHistory(root, gridOf) {
  const tabs = new Map();
  let replaying = false;

  const listOf = (tab) => {
    if (!tabs.has(tab)) tabs.set(tab, { done: [], undone: [] });
    return tabs.get(tab);
  };

  function entryOf(tab, event) {
    const table = tabTable(root, tab);
    const grid = table ? gridOf(table) : null;
    const cells = (event.cells ?? []).map(({ row, col, after }) => {
      const r = table ? rowIndex(table, row) : -1;
      const c = table ? colIndex(table, col) : -1;
      const fmt = grid && r >= 0 && c >= 0 ? grid.cell(a1(r, c)).fmt : null;
      return { row, col, after, fmt };
    });
    return { inverse: event.inverse, cells, rows: [...(event.rows?.added ?? [])], cols: [...(event.cols?.added ?? [])] };
  }

  // Called with every change event of a tab's Grid that the interface caused.
  function record(tab, event) {
    if (replaying || event?.source !== "api" || !event.inverse) return;
    const list = listOf(tab);
    list.done.push(entryOf(tab, event));
    if (list.done.length > LIMIT) list.done.shift();
    list.undone.length = 0;
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
    for (const { row, col, after, fmt } of entry.cells) {
      const r = rowIndex(table, row);
      const c = colIndex(table, col);
      if (r === -1 || c === -1) return false;
      const cell = grid.cell(a1(r, c));
      if (!same(cell.content, after) || cell.fmt !== fmt) return false;
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
    let event;
    try {
      event = grid.apply(entry.inverse);
    } finally {
      replaying = false;
    }
    if (event?.inverse) list[to].push(entryOf(tab, event));
    return { ok: true, cells: event?.cells ?? [] };
  }

  return {
    record,
    undo: (tab) => replay(tab, "done", "undone"),
    redo: (tab) => replay(tab, "undone", "done"),
    canUndo: (tab) => listOf(tab).done.length > 0,
    canRedo: (tab) => listOf(tab).undone.length > 0,
    get replaying() {
      return replaying;
    },
  };
}
