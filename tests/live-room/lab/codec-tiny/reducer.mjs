import { planted } from "../core/planted.mjs";

const put = (row, col, value) => {
  if (value === "") delete row.cells[col];
  else row.cells[col] = value;
};

export function act(wb, action) {
  if (action.t === "paste") {
    if (action.cells.some(([id]) => !wb.rows[id])) return false;
    for (const [id, col, value] of action.cells) put(wb.rows[id], col, value);
    return true;
  }
  const row = wb.rows[action.row];
  if (action.t === "set") {
    if (!row) return false;
    if (planted("row-granularity")) row.cells = {};
    put(row, action.col, action.value);
    return true;
  }
  if (action.t === "ins") {
    if (row) return false;
    wb.rows[action.row] = { pos: action.pos, cells: { ...action.cells } };
    return true;
  }
  if (action.t === "del") {
    if (!row) return false;
    delete wb.rows[action.row];
    return true;
  }
  throw new Error(`unknown action ${action.t}`);
}

export const codec = { name: "tiny", act };
