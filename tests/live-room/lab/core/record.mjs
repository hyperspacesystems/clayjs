import { codec } from "./codec.mjs";
import { utf8Bytes } from "./lib.mjs";

export const DOC = "doc0123456789abc";

export const serialize = (record, state, extras) => codec().write(state.wb, { ...record, lineage: state.lineage, cut: state.cut, floor: state.floor, opened: state.opened, seen: state.seen }, extras);

// The record of a document no room has written yet: generation zero, nothing admitted, an empty
// ledger. Hosts that make a document (a template, a copy, a new blank one) write it with their own
// document id; a file whose record has no ledger (a template's placeholder `{"rev":1}`) reads as it.
export const freshRecord = (doc = DOC) => ({ v: 2, doc, gen: "0.00000000", epoch: 0, commit: "c00000000000", parent: null, through: 0, lineage: [], cut: null, floor: -1, seen: {} });

const hasLedger = (record) => record?.v === 2 && record.seen !== null && typeof record.seen === "object";

export function parse(body) {
  const read = codec().read(body);
  const record = hasLedger(read.record) ? read.record : freshRecord(typeof read.record?.doc === "string" ? read.record.doc : DOC);
  const doc = read.doc;
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
