/**
 * @jest-environment node
 */
// File-only mode: a host with no room (HTML Clay today) that announces the file contract. Every
// save is a conditional write of the whole file, and a save settles only from committed bytes.
import { createReferenceHost } from "../../live-room/host/reference-host.mjs";
import { connect } from "../../../src/live-room/room-client.js";
import { serialize, parse } from "../../../src/live-room/core/record.js";
import { useCodec } from "../../../src/live-room/core/codec.js";
import { labLimits } from "../../../src/live-room/core/limits.js";
import { codec as tiny } from "../../live-room/lab/codec-tiny/reducer.mjs";

const RECORD = { v: 2, doc: "doc0123456789abc", gen: "0.00000000", epoch: 0, commit: "c00000000000", parent: null, through: 0 };
const START = { wb: { rows: { r1: { pos: "1", cells: { c1: "a" } }, r2: { pos: "2", cells: {} } } }, seen: {}, lineage: [], cut: null, floor: -1 };
const set = (row, col, value) => ({ t: "set", row, col, value });
const isSave = (request) => request.method === "POST" && request.url.includes("/_/save");

const open = [];
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("the condition did not hold in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
afterEach(() => Promise.all(open.splice(0).map((one) => one.close())));

function world(room = false) {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", room, rooms: { limits: labLimits() } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  let n = 0;
  const join = async (clientId) => {
    const client = await connect({ page: "doc", codec: tiny, clientId, fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), firstId: 10_000 * ++n, idleMs: 5, maxMs: 20, waitMs: 20 });
    open.push(client);
    await client.ready;
    return client;
  };
  const cell = (row, col) => {
    useCodec(tiny);
    return parse(host.file("doc").bytes).state.wb.rows[row]?.cells[col];
  };
  return { host, join, cell, saves: () => host.versions("doc").filter((one) => one.kind === "save").length };
}

test("the mode follows what the host announces and is fixed for the page load", async () => {
  expect((await world(false).join("ana")).status.mode).toBe("file");
  expect((await world(true).join("ana")).status.mode).toBe("ordered");
});

// Bug it catches: a second tab's save built on the file it opened erases the first tab's save.
test("two tabs save in turn: the second builds on the first tab's commit and both edits are in the file", async () => {
  const w = world();
  const ana = await w.join("ana");
  const ben = await w.join("ben");
  const a = ana.submit(set("r1", "c1", "ana"));
  expect(await ana.flush()).toEqual({ [a.id]: "saved" });
  const b = ben.submit(set("r2", "c1", "ben"));
  expect(await ben.flush()).toEqual({ [b.id]: "saved" });
  expect([w.cell("r1", "c1"), w.cell("r2", "c1")]).toEqual(["ana", "ben"]);
});

// Bug it catches: a save refused for a moved ETag that is sent again unchanged, or whose edit is lost.
test("a save refused because another writer moved the file is rebuilt on the new file and keeps both changes", async () => {
  const w = world();
  const ana = await w.join("ana");
  const agent = (bytes) => {
    useCodec(tiny);
    const { record, state } = parse(bytes);
    state.wb.rows.r1.cells.c2 = "agent";
    return serialize(record, state);
  };
  w.host.fault("move", isSave, agent);
  const a = ana.submit(set("r2", "c2", "kept"));
  expect(await ana.flush()).toEqual({ [a.id]: "saved" });
  expect([w.cell("r2", "c2"), w.cell("r1", "c2")]).toEqual(["kept", "agent"]);
});

// Bug it catches: a version restored right after a save whose answer was lost, written as it is,
// lets the tab save its edit again on top of the restored version.
test("a version restored after a save whose answer was lost stays restored", async () => {
  const w = world();
  const ana = await w.join("ana");
  const original = w.host.file("doc").bytes;
  w.host.fault("lose", isSave);
  ana.submit(set("r1", "c1", "edited"));
  await until(() => w.cell("r1", "c1") === "edited");
  await w.host.outside("doc", original, "restore");
  await new Promise((resolve) => setTimeout(resolve, 60));
  await ana.flush();
  expect(w.cell("r1", "c1")).toBe("a");
});

// Bug it catches: a save whose answer was lost is written a second time, or shown saved before the
// file says so.
test("a save whose answer was lost is settled from the committed file, not written twice", async () => {
  const w = world();
  const ana = await w.join("ana");
  w.host.fault("lose", isSave);
  const a = ana.submit(set("r1", "c1", "once"));
  const b = ana.submit(set("r2", "c1", "next"));
  expect(await ana.flush()).toEqual({ [a.id]: "saved", [b.id]: "saved" });
  expect([w.cell("r1", "c1"), w.cell("r2", "c1")]).toEqual(["once", "next"]);
  expect(w.saves()).toBe(1);
});
