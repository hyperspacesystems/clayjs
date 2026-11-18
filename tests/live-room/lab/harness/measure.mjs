import { writeFileSync } from "node:fs";
import { FIXTURES } from "./vendor/fixtures.mjs";
import { toHtml } from "./vendor/write-html.mjs";
import { recordBytes, DOC } from "../core/record.mjs";
import { fromFixture } from "./lib.mjs";

const bytes = (value) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
const LIMITS = { opsPerFrame: 128, storeBytes: 4 * 1024 * 1024, roomBytes: 6 * 1024 * 1024, logEntries: 4096, logBytes: 256 * 1024 };
const share = (part, whole) => Number(((100 * part) / whole).toFixed(3));
const client = (i) => `tab${String(i).padStart(13, "0")}`;
const id26 = (i) => `${String(i).padStart(4, "0")}.${"g".repeat(21)}`;
const stamp = (n, i) => `${n.toString(36).padStart(8, "0")}_${client(i)}`;

function orderedRecord(clients, lineage, cutClients) {
  const seen = {};
  for (let i = 0; i < clients; i++) seen[client(i)] = [1000 + i, 40];
  const bounds = {};
  for (let i = 0; i < cutClients; i++) bounds[client(i)] = [900 + i, 1000 + i];
  const state = {
    seen,
    lineage: Array.from({ length: lineage }, (_, i) => [id26(40 - i), 4000 + i]),
    cut: cutClients ? [id26(36), 4100, bounds] : null,
  };
  const record = { v: 2, doc: DOC, gen: id26(41), epoch: 41, commit: `c${"0".repeat(25)}`, parent: `c${"1".repeat(25)}`, through: 4096 };
  return recordBytes(record, state);
}

function unionMeta(perSave, clients, window = 4, keep = 2) {
  const rev = (i) => stamp(5000 + i, i % clients);
  const stamps = (i) => Array.from({ length: perSave }, (_, k) => stamp(100 + i * perSave + k, k % clients));
  const revs = {};
  for (let i = 0; i < window; i++) revs[rev(i + 1)] = { prev: rev(i), stamps: stamps(i), done: true };
  const recs = Array.from({ length: keep }, (_, i) => ({ rev: rev(window - i), prev: rev(window - i - 1), stamps: stamps(window - i - 1) }));
  const grouped = (list) =>
    list.map(([name, one]) => {
      const by = {};
      for (const s of one.stamps) {
        const [count, who] = s.split("_");
        (by[who] ||= []).push(parseInt(count, 36).toString(36));
      }
      return [name, one.prev, Object.fromEntries(Object.entries(by).map(([who, list]) => [who, list.join(",")]))];
    });
  const plain = bytes({ revs, recs });
  const compact = bytes(grouped(Object.entries(revs))) + bytes(grouped(recs.map((one) => [one.rev, one]))) + 2 * 12;
  return { plain, compact };
}

function measureFixture(name) {
  const workbook = FIXTURES[name]();
  const html = bytes(toHtml(workbook));
  const { wb, cells } = fromFixture(workbook);
  const rowIds = Object.keys(wb.rows);
  const frame = ([row, col, value], i) => ({ k: "act", seq: 4096 + i, c: client(i % 5), n: 1000 + i, action: { t: "set", row, col, value } });
  const patch = ([row, col, value], i) => [stamp(1000 + i, i % 5), { by: client(i % 5), cells: { [`${row}/${col}`]: value } }];
  const pasteAction = { k: "act", seq: 4097, c: client(0), n: 1001, action: { t: "paste", cells: cells.map(([row, col, value]) => [row, col, value]) } };
  const pastePatch = { [stamp(1001, 0)]: { by: client(0), cells: Object.fromEntries(cells.map(([row, col, value]) => [`${row}/${col}`, value])) } };
  const ledger = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [client(i), [1000 + i, 40]]));
  const tails = {};
  for (const unsaved of [100, 1000, 4096]) {
    const picked = Array.from({ length: unsaved }, (_, i) => cells[(i * 7919) % cells.length]);
    const orderedTail = bytes(picked.map(frame));
    const patches = Object.fromEntries(picked.map(patch));
    const unionRevs = {};
    for (let i = 0; i < 4; i++) unionRevs[stamp(5000 + i, 0)] = { prev: stamp(4999 + i, 0), stamps: Object.keys(patches).slice(0, Math.min(unsaved, 1000)), done: true };
    tails[unsaved] = {
      orderedTail,
      orderedTailOverLogCap: orderedTail > LIMITS.logBytes,
      unionPatches: bytes(patches),
      unionStoreWithRevs: bytes({ revs: unionRevs, patches }),
    };
  }
  const fullState = bytes(wb);
  const minimalRoom = bytes({ seen: ledger, lineage: [[id26(40), 4000], [id26(39), 3990], [id26(38), 3980], [id26(37), 3970]], rows: rowIds });
  return {
    fixture: name,
    cells: cells.length,
    rows: rowIds.length,
    htmlBytes: html,
    orderedRoomFullState: { bytes: fullState, ofStoreCap: share(fullState, LIMITS.storeBytes), ofRoomCap: share(fullState + LIMITS.logBytes, LIMITS.roomBytes) },
    orderedRoomMinimal: { bytes: minimalRoom, ofStoreCap: share(minimalRoom, LIMITS.storeBytes) },
    unsavedSingleCellEdits: tails,
    wholeSheetPaste: {
      orderedOneAction: bytes(pasteAction),
      unionOnePatch: bytes(pastePatch),
      ops: cells.length,
      overOpsPerFrame: cells.length > LIMITS.opsPerFrame,
      overLogBytes: bytes(pasteAction) > LIMITS.logBytes,
      ofStoreCap: share(bytes(pastePatch), LIMITS.storeBytes),
    },
  };
}

const standard = measureFixture("standard");
const stretch = measureFixture("stretch");
const records = {};
for (const [name, clients, lineage, cut] of [["one writer", 1, 0, 0], ["five tabs, full lineage", 5, 4, 0], ["twenty tabs, full lineage, after a restore", 20, 4, 20], ["one hundred tabs, full lineage, after a restore", 100, 4, 100]]) {
  const size = orderedRecord(clients, lineage, cut);
  records[name] = { bytes: size, percentOfStandardFile: share(size, standard.htmlBytes) };
}
const union = {};
for (const [name, perSave, clients] of [["1 edit per save, 1 tab", 1, 1], ["20 edits per save, 5 tabs", 20, 5], ["100 edits per save, 5 tabs", 100, 5], ["1000 edits per save, 20 tabs", 1000, 20]]) {
  const size = unionMeta(perSave, clients);
  union[name] = { ...size, compactPercentOfStandardFile: share(size.compact, standard.htmlBytes) };
}

const result = { limits: LIMITS, orderedCommitRecord: records, unionFileMetadata: union, standard, stretch };
const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result, null, 1));
