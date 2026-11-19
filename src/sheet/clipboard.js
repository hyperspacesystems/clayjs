import { shiftFormula } from "./refs.js";

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// The two clipboard parts for an area of a Grid: tab-separated shown values, and a table whose
// cells carry their content, value and format, from which a paste rebuilds them (formulas moved
// by the distance to where they land).
export function copyParts(grid, { top, left, bottom, right }, a1, { cut = false } = {}) {
  const rows = [];
  for (let r = top; r <= bottom; r++) {
    const cells = [];
    for (let c = left; c <= right; c++) {
      const cell = grid.cell(a1(r, c));
      const attrs = [`data-content="${escapeHtml(JSON.stringify(cell.content ?? null))}"`, `data-value="${escapeHtml(JSON.stringify(cell.value ?? null))}"`];
      if (cell.effectiveFmt !== null && cell.effectiveFmt !== undefined) attrs.push(`data-fmt="${escapeHtml(cell.effectiveFmt)}"`);
      cells.push(`<td ${attrs.join(" ")}>${escapeHtml(cell.text)}</td>`);
    }
    rows.push(`<tr>${cells.join("")}</tr>`);
  }
  const html = `<table data-sheet-origin="${top},${left}"${cut ? " data-sheet-cut" : ""}><tbody>${rows.join("")}</tbody></table>`;
  const text = grid.toDelimited(`${a1(top, left)}:${a1(bottom, right)}`, { delimiter: "\t", values: "shown" }).replace(/(^|\r\n)""$/, "$1");
  return { html, text };
}

const parseJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

// The block a paste writes at (r, c), or null when the HTML holds no single table. Our own table
// gives { kind: "ours", block, origin }: items { content, fmt }, with formulas moved by the
// distance from the source, or plain values when `valuesOnly`. A one-cell table keeps its raw
// formula so a larger selection can move it per cell with `fillFormula`. Any other table gives
// { kind: "foreign", block } of shown texts, typed as input.
export function pasteBlock(html, at, { valuesOnly = false } = {}) {
  if (!html) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tables = [...doc.body.querySelectorAll("table")].filter((t) => !t.parentElement.closest("table"));
  if (tables.length !== 1) return null;
  const table = tables[0];
  const rows = [...table.rows].map((tr) => [...tr.cells]);
  if (rows.length === 0) return null;
  if (rows.every((cells) => cells.length === 0)) return null;
  const rawOrigin = table.getAttribute("data-sheet-origin");
  if (!rawOrigin || !/^\d+,\d+$/.test(rawOrigin)) {
    return { kind: "foreign", block: rows.map((cells) => cells.map((td) => td.textContent ?? "")) };
  }
  const [or, oc] = rawOrigin.split(",").map(Number);
  const cut = table.hasAttribute("data-sheet-cut");
  const [dr, dc] = cut ? [0, 0] : [at.r - or, at.c - oc];
  const one = rows.length === 1 && rows[0].length === 1;
  const block = rows.map((cells) =>
    cells.map((td) => {
      if (valuesOnly) return parseJson(td.getAttribute("data-value"));
      const content = parseJson(td.getAttribute("data-content"));
      const moved = !one && content !== null && typeof content === "object" && typeof content.f === "string" ? { f: shiftFormula(content.f, dr, dc) } : content;
      return { content: moved, fmt: td.getAttribute("data-fmt") };
    }),
  );
  return { kind: "ours", block, origin: cut ? { r: at.r, c: at.c } : { r: or, c: oc } };
}

// One cell's item repeated over a larger selection, as a one-cell paste fills it.
export function fillBlock(block, rows, cols) {
  if (block.length !== 1 || block[0].length !== 1 || (rows === 1 && cols === 1)) return block;
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => block[0][0]));
}

// A one-cell formula repeated over a larger selection, moved from the source origin to each target.
export const fillFormula = (rawF, fmt, dr, dc, rows, cols) =>
  Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => ({ content: { f: shiftFormula(rawF, dr + i, dc + j) }, fmt })));
