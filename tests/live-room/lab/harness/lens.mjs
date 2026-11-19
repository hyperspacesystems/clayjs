// Which codec the lab runs (LAB_CODEC=list picks the list codec, the default is the small
// workbook), and the lens between that codec's shapes and the small workbook's. The harness
// builds and checks workbook actions and documents; the core sees only the chosen codec's.
// The list codec is a renaming of the workbook (items for rows, fields for cells), so each
// direction is exact, and each function leaves a shape it does not convert unchanged.
import { codec as tiny } from "../codec-tiny/reducer.mjs";
import { codec as list } from "../codec-list/reducer.mjs";

export const CODEC = process.env.LAB_CODEC === "list" ? "list" : "tiny";
export const labCodec = CODEC === "list" ? list : tiny;

const LIST = new Set(["put", "puts", "add", "cut"]);

export function refAction(action) {
  if (!action || !LIST.has(action.t)) return action;
  if (action.t === "put") return { t: "set", row: action.id, col: action.field, value: action.text };
  if (action.t === "puts") return { t: "paste", cells: action.writes };
  if (action.t === "add") return { t: "ins", row: action.id, pos: action.at, cells: action.fields };
  return { t: "del", row: action.id };
}

export function codecAction(action) {
  if (CODEC === "tiny" || !action) return action;
  if (action.t === "set") return { t: "put", id: action.row, field: action.col, text: action.value };
  if (action.t === "paste") return { t: "puts", writes: action.cells };
  if (action.t === "ins") return { t: "add", id: action.row, at: action.pos, fields: action.cells };
  if (action.t === "del") return { t: "cut", id: action.row };
  return action;
}

export function refDoc(doc) {
  if (!doc?.items) return doc;
  return { rows: Object.fromEntries(Object.entries(doc.items).map(([id, item]) => [id, { pos: item.at, cells: { ...item.fields } }])) };
}

export function codecDoc(wb) {
  if (CODEC === "tiny" || !wb?.rows) return wb;
  return { items: Object.fromEntries(Object.entries(wb.rows).map(([id, row]) => [id, { at: row.pos, fields: { ...row.cells } }])) };
}
