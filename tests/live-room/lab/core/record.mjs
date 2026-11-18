import { codec } from "./codec.mjs";
import { utf8Bytes } from "./lib.mjs";

export const DOC = "doc0123456789abc";

export const serialize = (record, state) => codec().write(state.wb, { ...record, lineage: state.lineage, cut: state.cut, floor: state.floor, opened: state.opened, seen: state.seen });

export function parse(body) {
  const { record, doc } = codec().read(body);
  const { lineage, cut, floor, opened, seen, ...header } = record;
  return { record: header, state: { wb: doc, seen, lineage, cut, floor, ...(opened === undefined ? {} : { opened }) } };
}

export const page = (about, wb) => codec().write(wb, { v: 2, doc: DOC, ...about });

export function parsePage(body) {
  const { record, doc } = codec().read(body);
  return { record, wb: doc };
}

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

export const recordBytes = (record, state) => utf8Bytes(recordTag(record, state));
