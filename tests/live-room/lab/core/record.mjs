import { planted } from "./planted.mjs";

export const DOC = "doc0123456789abc";

const esc = (text) => (planted("no-escape") ? String(text) : String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"));

const unesc = (text) => text.replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&");

const byPos = ([a, x], [b, y]) => (x.pos < y.pos ? -1 : x.pos > y.pos ? 1 : a < b ? -1 : a > b ? 1 : 0);

const cell = ([col, value]) => `<td data-col="${esc(col)}">${esc(value)}</td>`;

const tr = ([id, row]) => `<tr data-id="${esc(id)}" data-pos="${esc(row.pos)}">${Object.entries(row.cells).filter(([, value]) => value !== "" && value != null).sort(([a], [b]) => (a < b ? -1 : 1)).map(cell).join("")}</tr>`;

const html = (record, wb) =>
  `<!doctype html><table>${Object.entries(wb.rows).sort(byPos).map(tr).join("")}</table><script type="application/json" id="commit">${JSON.stringify(record).replaceAll("<", "\\u003c")}</script>`;

function read(body) {
  const record = JSON.parse(body.match(/<script type="application\/json" id="commit">(.*?)<\/script>/s)[1]);
  const rows = {};
  for (const [, id, pos, inner] of body.matchAll(/<tr data-id="([^"]*)" data-pos="([^"]*)">(.*?)<\/tr>/gs)) {
    const cells = {};
    for (const [, col, value] of inner.matchAll(/<td data-col="([^"]*)">(.*?)<\/td>/gs)) cells[unesc(col)] = unesc(value);
    rows[unesc(id)] = { pos: unesc(pos), cells };
  }
  return { record, wb: { rows } };
}

export const serialize = (record, state) => html({ ...record, lineage: state.lineage, cut: state.cut, floor: state.floor, opened: state.opened, seen: state.seen }, state.wb);

export function parse(body) {
  const { record, wb } = read(body);
  const { lineage, cut, floor, opened, seen, ...header } = record;
  return { record: header, state: { wb, seen, lineage, cut, floor, ...(opened === undefined ? {} : { opened }) } };
}

export const page = (about, wb) => html({ v: 2, doc: DOC, ...about }, wb);

export const parsePage = (body) => read(body);

const padClient = (id) => id.padEnd(16, "x");

export const entryBytes = (client, [n, at]) => padClient(client).length + String(n).length + String(at).length + 7;

export const ledgerBytes = (seen) => Object.entries(seen).reduce((sum, [client, value]) => sum + entryBytes(client, value), 2);

export const recordBudget = (ledgerCap, window) => 360 + 28 * window + Math.ceil(2.25 * ledgerCap);

export function recordTag(record, state) {
  const seen = Object.fromEntries(Object.entries(state.seen).map(([client, value]) => [padClient(client), value]));
  const cut = state.cut && [state.cut[0], state.cut[1], Object.fromEntries(Object.entries(state.cut[2]).map(([client, value]) => [padClient(client), value]))];
  const full = { ...record, lineage: state.lineage, cut, floor: state.floor, opened: state.opened, seen };
  return `<script type="application/json" commit="sheet">${JSON.stringify(full)}</script>`;
}

export const recordBytes = (record, state) => Buffer.byteLength(recordTag(record, state), "utf8");
