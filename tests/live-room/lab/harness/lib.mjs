export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const byPos = (a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

import { refDoc } from "./lens.mjs";

export function canon(doc) {
  const wb = refDoc(doc);
  const rows = Object.entries(wb.rows).map(([id, row]) => [
    id,
    row.pos,
    Object.entries(row.cells).filter(([, value]) => value !== "" && value != null).sort(([a], [b]) => (a < b ? -1 : 1)),
  ]);
  return JSON.stringify(rows.sort(byPos));
}

export function fromCanon(text) {
  const rows = {};
  for (const [id, pos, cells] of JSON.parse(text)) rows[id] = { pos, cells: Object.fromEntries(cells) };
  return { rows };
}

export const COLS = ["c1", "c2", "c3"];

export function tinyWorkbook() {
  const rows = {};
  for (let r = 1; r <= 4; r++) {
    rows[`r${r}`] = { pos: `${r}`, cells: {} };
    if (r % 2) rows[`r${r}`].cells.c1 = `i${r}`;
  }
  return { rows };
}

export function fromFixture(workbook) {
  const rows = {};
  const cells = [];
  for (const sheet of workbook.sheets) {
    for (const row of sheet.rows) {
      const values = {};
      row.cells.forEach((cell, at) => {
        if (!cell || cell.text === "") return;
        const col = sheet.cols?.[at]?.id ?? `c${at}`;
        values[col] = cell.text;
        cells.push([row.id, col, cell.text]);
      });
      rows[row.id] = { pos: row.pos, cells: values };
    }
  }
  return { wb: { rows }, cells };
}

export const rowsInOrder = (doc) => Object.entries(refDoc(doc).rows).map(([id, row]) => [id, row.pos]).sort(byPos).map(([id]) => id);
