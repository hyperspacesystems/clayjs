// Step P4: what an ordered room really costs. Run with --expose-gc on a box:
//   testbox run --small --command 'node --expose-gc tests/live-room/measure-rooms.mjs'
// Uses the lab's small codec until the sheet's room codec exists; the numbers are repeated then.
import { writeFileSync } from "node:fs";
import { createOrderedRooms } from "../../src/server/rooms/index.js";
import { serialize, parse } from "../../src/live-room/core/record.js";
import { useCodec } from "../../src/live-room/core/codec.js";
import { REAL_LIMITS } from "../../src/live-room/core/limits.js";
import { stateReserve } from "../../src/live-room/core/room.js";
import { explode } from "../../src/live-room/core/frames.js";
import { codec as tiny } from "./lab/codec-tiny/reducer.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((arg) => arg.replace(/^--/, "").split("=")));
const ROOMS = Number(args.rooms ?? 200);
const CLIENTS = Number(args.clients ?? 1000);
const SIZES = (args.cells ?? "20000,100000").split(",").map(Number);
const COLS = Number(args.cols ?? 20);

if (!global.gc) throw new Error("run with node --expose-gc");
const heap = () => {
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
};
const utf8 = (text) => Buffer.byteLength(text, "utf8");
const json = (value) => utf8(JSON.stringify(value));

function workbook(cells, fill = "v") {
  const rows = {};
  const count = Math.ceil(cells / COLS);
  for (let r = 0; r < count; r++) {
    const row = {};
    for (let c = 0; c < COLS && r * COLS + c < cells; c++) row[`c${c}`] = `${fill}${r}x${c}`;
    rows[`r${r}`] = { pos: String(r).padStart(6, "0"), cells: row };
  }
  return rows;
}

function file(cells) {
  useCodec(tiny);
  const record = { v: 2, doc: "doc0123456789abc", gen: "0.00000000", epoch: 0, commit: "c00000000000", parent: null, through: 0 };
  return serialize(record, { wb: { rows: workbook(cells) }, seen: {}, lineage: [], cut: null, floor: -1 });
}

function registry(options = {}) {
  let ids = 0;
  return createOrderedRooms({ codecs: { tiny }, limits: REAL_LIMITS, liveBytes: Number.MAX_SAFE_INTEGER, maxRooms: 1e9, newId: () => 1000 * ++ids, ...options });
}

function openRoom(rooms, key, bytes) {
  const est = rooms.establish(key, { bytes, etag: "e0", codec: "tiny" });
  return { room: rooms.open(key, { bytes: est.bytes, etag: "e1" }), bytes: est.bytes };
}

function request(room, c, n, action) {
  useCodec(tiny);
  return { k: "req", gen: room.gen, c, n, p: n - 1, b: room.epoch, e: `${c}:${n}`, action, saw: tiny.seen(room.state.wb, action) };
}

function pasteOver(cells, fill, col = (i) => `c${i % COLS}`) {
  const out = [];
  for (let i = 0; i < cells; i++) out.push([`r${Math.floor(i / COLS)}`, col(i), `${fill}${i}`]);
  return { t: "paste", cells: out };
}

function pasteEmpty(cells) {
  const bytes = file(cells);
  const rooms = registry();
  const { room } = openRoom(rooms, "doc", bytes);
  rooms.attach(room, "ana", "conn-ana");
  const pasteCells = Math.min(20000, cells);
  const before = heap();
  const one = send(rooms, room, "ana", 1, pasteOver(pasteCells, "e", (i) => `e${i % COLS}`));
  const after = heap();
  return { cells, answer: one.answer, declaredBytes: one.declared, tailBytes: room.bytes.tail, heapForOnePaste: after - before, heapPerCountedByte: Number(((after - before) / room.bytes.tail).toFixed(2)) };
}

function send(rooms, room, c, n, action) {
  useCodec(tiny);
  const parts = explode(request(room, c, n, action), `q:${c}:${n}`, REAL_LIMITS);
  let answer;
  let wire = 0;
  for (const part of parts) {
    wire += json(part);
    answer = rooms.frame(room, c, part).answer;
  }
  return { answer, parts: parts.length, wire, declared: parts[0].size ?? json(parts[0]) };
}

function perRoom(cells) {
  const bytes = file(cells);
  const rooms = registry();
  const before = heap();
  for (let i = 0; i < ROOMS; i++) openRoom(rooms, `doc${i}`, bytes);
  const after = heap();
  const charged = rooms.used() / ROOMS;
  const measured = (after - before) / ROOMS;
  return { cells, cols: COLS, fileBytes: utf8(bytes), rooms: ROOMS, heapPerRoom: Math.round(measured), heapPerFileByte: Number((measured / utf8(bytes)).toFixed(2)), chargedPerRoom: Math.round(charged), heapOverCharge: Number((measured / charged).toFixed(2)), stateReserve: stateReserve(REAL_LIMITS) };
}

function paste(cells) {
  const bytes = file(cells);
  const rooms = registry();
  const { room } = openRoom(rooms, "doc", bytes);
  rooms.attach(room, "ana", "conn-ana");
  const pasteCells = Math.min(20000, cells);
  const before = heap();
  const first = send(rooms, room, "ana", 1, pasteOver(pasteCells, "p"));
  const after = heap();
  const tailAfterOne = room.bytes.tail;
  const kept = [first.answer];
  for (let n = 2; n <= 200 && kept.at(-1) === "ok"; n++) kept.push(send(rooms, room, "ana", n, pasteOver(pasteCells, `q${n}`)).answer);
  return {
    cells,
    pasteCells,
    answer: first.answer,
    parts: first.parts,
    wireBytes: first.wire,
    declaredBytes: first.declared,
    tailBytesForOnePaste: tailAfterOne,
    heapForOnePaste: after - before,
    pastesKeptBeforeFull: kept.filter((answer) => answer === "ok").length,
    lastAnswer: kept.at(-1),
    tailLimit: REAL_LIMITS.storeBytes,
  };
}

function clients(cells) {
  const bytes = file(cells);
  const rooms = registry();
  const { room } = openRoom(rooms, "doc", bytes);
  const answers = {};
  for (let i = 0; i < CLIENTS; i++) {
    const c = `tab${String(i).padStart(6, "0")}`;
    rooms.attach(room, c, `conn-${i}`);
    const answer = rooms.frame(room, c, request(room, c, 1, { t: "set", row: `r${i % 50}`, col: `c${i % COLS}`, value: `x${i}` })).answer;
    answers[answer] = (answers[answer] ?? 0) + 1;
    rooms.leave(room, `conn-${i}`);
  }
  useCodec(tiny);
  const { record } = parse(bytes);
  const saved = serialize({ ...record, commit: "c99999999990", parent: room.base.commit, through: room.seq }, { ...room.state });
  return { cells, clients: CLIENTS, answers, seq: room.seq, ledgerEntries: Object.keys(room.state.seen).length, recordBytes: utf8(saved) - utf8(bytes), heapUsed: heap() };
}

const report = { at: new Date().toISOString(), node: process.version, codec: "tiny (the lab's small codec; repeat with the sheet codec)", limits: REAL_LIMITS, perRoom: [], paste: [], pasteEmpty: [], clients: [] };
for (const cells of SIZES) {
  report.perRoom.push(perRoom(cells));
  report.paste.push(paste(cells));
  report.pasteEmpty.push(pasteEmpty(cells));
  report.clients.push(clients(cells));
}
const out = args.out ?? `${process.env.TESTBOX_OUT ?? "."}/measure-rooms.json`;
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
