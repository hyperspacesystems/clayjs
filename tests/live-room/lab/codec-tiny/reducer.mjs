import { planted } from "../core/planted.mjs";
import { clone, utf8Bytes } from "../core/lib.mjs";

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
    wb.rows[action.row] = { pos: action.pos, cells: Object.fromEntries(filled(action.cells)) };
    return true;
  }
  if (action.t === "del") {
    if (!row) return false;
    delete wb.rows[action.row];
    return true;
  }
  throw new Error(`unknown action ${action.t}`);
}

export const cellsOf = (action) => (action?.t === "paste" ? action.cells : action?.t === "set" ? [[action.row, action.col, action.value]] : []);

const shown = (wb, row, col) => wb.rows[row]?.cells[col] ?? "";

const filled = (cells) => Object.entries(cells ?? {}).filter(([, value]) => value !== "" && value != null);

const keyOf = (row, col) => `${row}/${col}`;

const json = (value) => JSON.stringify(value ?? null);

function fits(wb, action) {
  if (action.t === "ins") return !wb.rows[action.row];
  return needs(action).every((row) => wb.rows[row]);
}

const needs = (action) => (action.t === "ins" ? [] : action.t === "del" ? [action.row] : [...new Set(cellsOf(action).map(([row]) => row))]);

function inverse(wb, action) {
  if (action.t === "paste") return { t: "paste", cells: action.cells.map(([row, col]) => [row, col, shown(wb, row, col)]) };
  if (action.t === "set") return { t: "set", row: action.row, col: action.col, value: shown(wb, action.row, action.col) };
  if (action.t === "ins") return { t: "del", row: action.row };
  return { t: "ins", row: action.row, pos: wb.rows[action.row].pos, cells: { ...wb.rows[action.row].cells } };
}

function conflicts(wb, action, saw) {
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

const esc = (text) => (planted("no-escape") ? String(text) : String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"));

const unesc = (text) => text.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

const byPos = ([a, x], [b, y]) => (x.pos < y.pos ? -1 : x.pos > y.pos ? 1 : a < b ? -1 : a > b ? 1 : 0);

const cell = ([col, value]) => `<td data-col="${esc(col)}">${esc(value)}</td>`;

const tr = ([id, row]) => `<tr data-id="${esc(id)}" data-pos="${esc(row.pos)}">${filled(row.cells).sort(([a], [b]) => (a < b ? -1 : 1)).map(cell).join("")}</tr>`;

const write = (wb, record) =>
  `<!doctype html><table>${Object.entries(wb.rows).sort(byPos).map(tr).join("")}</table><script type="application/json" id="commit">${JSON.stringify(record).replaceAll("<", "\\u003c")}</script>`;

function read(body) {
  const record = JSON.parse(body.match(/<script type="application\/json" id="commit">(.*?)<\/script>/s)[1]);
  const rows = {};
  for (const [, id, pos, inner] of body.matchAll(/<tr data-id="([^"]*)" data-pos="([^"]*)">(.*?)<\/tr>/gs)) {
    const cells = {};
    for (const [, col, value] of inner.matchAll(/<td data-col="([^"]*)">(.*?)<\/td>/gs)) cells[unesc(col)] = unesc(value);
    rows[unesc(id)] = { pos: unesc(pos), cells };
  }
  return { record, doc: { rows } };
}

const text = (value) => typeof value === "string";

function validate(action) {
  if (!action || typeof action !== "object") return false;
  if (action.t === "set") return text(action.row) && text(action.col) && text(action.value);
  if (action.t === "paste") return Array.isArray(action.cells) && action.cells.every((one) => Array.isArray(one) && one.length === 3 && one.every(text));
  if (action.t === "ins") return text(action.row) && text(action.pos) && Boolean(action.cells) && typeof action.cells === "object" && Object.values(action.cells).every(text);
  if (action.t === "del") return text(action.row);
  return false;
}

export const codec = {
  name: "tiny",
  version: 1,
  read,
  write,
  docBytes: (wb) => utf8Bytes(json(wb)),
  validate,
  apply(wb, action) {
    const undo = fits(wb, action) ? inverse(wb, action) : null;
    return act(wb, action) ? { out: "applied", inverse: undo } : { out: "refused", inverse: null };
  },
  size: (action) => utf8Bytes(json(action)),
  ops: (action) => (action.t === "paste" ? Math.max(1, action.cells.length) : 1),
  split({ action, saw, reviewed }, limits) {
    const size = limits.opsPerFrame;
    const cut = (list, i) => list?.slice(i * size, (i + 1) * size);
    return {
      head: { action: { ...action, cells: [] }, saw: saw && [], reviewed: reviewed && [] },
      parts: Array.from({ length: Math.ceil(action.cells.length / size) }, (_, i) => ({ cells: cut(action.cells, i), saw: cut(saw, i), reviewed: cut(reviewed, i) })),
    };
  },
  assemble(head, parts) {
    const all = (field) => parts.flatMap((part) => part?.[field] ?? []);
    return { action: { ...head.action, cells: all("cells") }, saw: head.saw && all("saw"), reviewed: head.reviewed && all("reviewed") };
  },
  partOps: (part) => part.cells.length,
  targets: (action) => cellsOf(action).map(([row, col]) => keyOf(row, col)),
  creates: (action) => (action.t === "ins" ? [action.row] : []),
  needs,
  removes: (action) => (action.t === "del" ? [action.row] : []),
  has: (wb, row) => Boolean(wb.rows[row]),
  seen(wb, action) {
    if (action.t === "ins") return null;
    if (action.t === "del") return Object.fromEntries(filled(wb.rows[action.row]?.cells));
    return cellsOf(action).map(([row, col]) => shown(wb, row, col));
  },
  fits,
  conflicts,
  unseen(wb, action, saw) {
    if (action.t !== "del" || !saw) return [];
    return filled(wb.rows[action.row]?.cells)
      .filter(([col]) => !(col in saw))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([col, value]) => [action.row, col, value]);
  },
  review(action, saw, cells) {
    if (action.t === "ins" || !saw) return null;
    if (action.t === "del") {
      const row = { ...saw };
      for (const [, col, now] of cells) {
        if (now === "") delete row[col];
        else row[col] = now;
      }
      return row;
    }
    const now = new Map(cells.map(([row, col, value]) => [keyOf(row, col), value]));
    return cellsOf(action).map(([row, col], at) => now.get(keyOf(row, col)) ?? saw[at]);
  },
  holds(wb, action) {
    if (action.t === "ins") return Boolean(wb.rows[action.row]);
    const cells = cellsOf(action);
    return cells.length > 0 && cells.every(([row, col, value]) => value !== "" && shown(wb, row, col) === value);
  },
  describe: (action) => ({ title: { set: "Set a cell", paste: "Paste", ins: "Insert a row", del: "Delete a row" }[action.t], cells: cellsOf(action).map(([row, col, value]) => ({ target: keyOf(row, col), label: `${row} ${col}`, stored: value })) }),
  current(wb, target) {
    const at = target.indexOf("/");
    return shown(wb, target.slice(0, at), target.slice(at + 1));
  },
  preview(wb, actions) {
    const doc = clone(wb);
    for (const action of actions) act(doc, action);
    return doc;
  },
};
