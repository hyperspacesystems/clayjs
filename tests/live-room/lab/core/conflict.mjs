import { cellsOf } from "./limits.mjs";

const shown = (wb, row, col) => wb.rows[row]?.cells[col] ?? "";

const filled = (cells) => Object.entries(cells ?? {}).filter(([, value]) => value !== "" && value != null);

export function seenBy(wb, action) {
  if (action.t === "ins") return null;
  if (action.t === "del") return Object.fromEntries(filled(wb.rows[action.row]?.cells));
  return cellsOf(action).map(([row, col]) => shown(wb, row, col));
}

export const rowsOf = (action) => (action.t === "ins" ? [] : action.t === "del" ? [action.row] : [...new Set(cellsOf(action).map(([row]) => row))]);

export function fitsNow(wb, action) {
  if (action.t === "ins") return !wb.rows[action.row];
  return rowsOf(action).every((row) => wb.rows[row]);
}

const keysOf = (action) => cellsOf(action).map(([row, col]) => `${row}/${col}`);

export const marksOf = (action) => (action.t === "ins" ? [action.row] : keysOf(action));

export function waitsFor(wb, action, waiting) {
  const mark = rowsOf(action).find((row) => !wb.rows[row] && waiting.has(row)) ?? keysOf(action).find((key) => waiting.has(key));
  return mark === undefined ? null : waiting.get(mark);
}

export function conflicts(wb, action, saw) {
  if (action.t === "ins") return [];
  if (action.t === "del") {
    if (!saw) return [[action.row, null, "", ""]];
    const now = Object.fromEntries(filled(wb.rows[action.row]?.cells));
    return Object.keys(saw)
      .sort()
      .filter((col) => (now[col] ?? "") !== saw[col])
      .map((col) => [action.row, col, now[col] ?? "", ""]);
  }
  return cellsOf(action).flatMap(([row, col, value], at) => (saw && shown(wb, row, col) === saw[at] ? [] : [[row, col, shown(wb, row, col), value]]));
}

export function unseenBy(wb, action, saw) {
  if (action.t !== "del" || !saw) return [];
  return filled(wb.rows[action.row]?.cells)
    .filter(([col]) => !(col in saw))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([col, value]) => [action.row, col, value]);
}

export function lateCells(wb, action, saw) {
  const changed = conflicts(wb, action, saw);
  return changed.length ? changed : conflicts(wb, action, null);
}

export function reviewed(action, saw, cells) {
  if (action.t === "ins" || !saw) return null;
  if (action.t === "del") {
    const row = { ...saw };
    for (const [, col, now] of cells) {
      if (now === "") delete row[col];
      else row[col] = now;
    }
    return row;
  }
  const now = new Map(cells.map(([row, col, value]) => [`${row}/${col}`, value]));
  return cellsOf(action).map(([row, col], at) => now.get(`${row}/${col}`) ?? saw[at]);
}

export function stillOpen(wb, action, saw, looked) {
  const cells = conflicts(wb, action, saw);
  return cells.length && looked && !conflicts(wb, action, looked).length ? [] : cells;
}

export function holds(wb, action) {
  if (action.t === "ins") return Boolean(wb.rows[action.row]);
  const cells = cellsOf(action);
  return cells.length > 0 && cells.every(([row, col, value]) => value !== "" && shown(wb, row, col) === value);
}
