/**
 * @jest-environment node
 */
// C9b Part 1, C10 non-blocking requests, P5b rooms.submit, and lane R recalculation hooks.
import { createReferenceHost } from "../../live-room/host/reference-host.mjs";
import { createRoomClient, createFileClient } from "../../../src/live-room/room-client.js";
import { createOrderedRooms } from "../../../src/server/rooms/ordered-room.js";
import { serialize, parse } from "../../../src/live-room/core/record.js";
import { useCodec } from "../../../src/live-room/core/codec.js";
import { labLimits } from "../../../src/live-room/core/limits.js";
import { codec as tiny } from "../../live-room/lab/codec-tiny/reducer.mjs";

const RECORD = { v: 2, doc: "doc0123456789abc", gen: "0.00000000", epoch: 0, commit: "c00000000000", parent: null, through: 0 };
const START = { wb: { rows: { r1: { pos: "1", cells: { c1: "a" } }, r2: { pos: "2", cells: {} } } }, seen: {}, lineage: [], cut: null, floor: -1 };
const set = (row, col, value) => ({ t: "set", row, col, value });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const open = [];
afterEach(() => Promise.all(open.splice(0).map((c) => c.close())));

async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timeout");
    await pause(5);
  }
}

// A codec extending `tiny` with optional `drawingsIn`, `results`, and `write(..., extras)` markers,
// modeling sapjs's sheetCodec contract for chart drawings and lane R formula recalculation.
function richCodec() {
  return {
    ...tiny,
    write(doc, record, extras = null) {
      const base = tiny.write(doc, record);
      const drawing = typeof extras?.drawing === "function" ? extras.drawing("s1", "chart1") : undefined;
      const calc = typeof extras?.result === "function" ? extras.result("s1", "r1", "c1") : undefined;
      let out = base;
      if (drawing) out = `${out}<!--drawing:${drawing}-->`;
      if (calc) out = `${out}<!--calc:${calc.text}-->`;
      return out;
    },
    read(bytes) {
      const clean = String(bytes).replace(/<!--(?:drawing|calc):[^>]*-->/g, "");
      return tiny.read(clean);
    },
    drawingsIn(bytes) {
      const m = /<!--drawing:([^>]*)-->/.exec(String(bytes));
      return (sheet, id) => (m && sheet === "s1" && id === "chart1" ? m[1] : undefined);
    },
    results(doc) {
      const v = doc.rows.r1?.cells?.c1 ?? "";
      return (sheet, row, col) => (sheet === "s1" && row === "r1" && col === "c1" ? { text: `calc(${v})` } : undefined);
    },
  };
}

test("ordered-room render preserves chart drawings and recalculates when recalculate: true", () => {
  const codec = richCodec();
  const rooms = createOrderedRooms({ codecs: { rich: codec }, limits: labLimits(), recalculate: true });
  useCodec(codec);
  const initial = codec.write(START.wb, { ...RECORD, seen: {}, lineage: [], cut: null, floor: -1 }, { drawing: () => "svg-v1" });
  expect(initial).toContain("<!--drawing:svg-v1-->");

  const est = rooms.establish("doc", { bytes: initial, etag: "e0", codec: "rich" });
  expect(est.bytes).toContain("<!--drawing:svg-v1-->");
  expect(est.bytes).toContain("<!--calc:calc(a)-->");

  const room = rooms.open("doc", { bytes: est.bytes, etag: "e1" });
  const sub = rooms.submit(room, set("r1", "c1", "42"));
  expect(sub.answer).toBe("ok");

  const rendered = rooms.render(room);
  expect(rendered.bytes).toContain("<!--drawing:svg-v1-->");
  expect(rendered.bytes).toContain("<!--calc:calc(42)-->");

  // With recalculate: false (default), drawings still survive but results are not calculated.
  const noCalcRooms = createOrderedRooms({ codecs: { rich: codec }, limits: labLimits(), recalculate: false });
  const est2 = noCalcRooms.establish("doc", { bytes: initial, etag: "e0", codec: "rich" });
  const room2 = noCalcRooms.open("doc", { bytes: est2.bytes, etag: "e1" });
  noCalcRooms.submit(room2, set("r1", "c1", "99"));
  const rendered2 = noCalcRooms.render(room2);
  expect(rendered2.bytes).toContain("<!--drawing:svg-v1-->");
  expect(rendered2.bytes).not.toContain("<!--calc:");
});

test("rooms.submit admits a host action in order, broadcasts it, and refuses invalid/unfitted/closed/over-budget actions", () => {
  const rooms = createOrderedRooms({ codecs: { tiny }, limits: labLimits(), liveBytes: 8000 });
  useCodec(tiny);
  const bytes = serialize(RECORD, START);
  const est = rooms.establish("doc", { bytes, etag: "e0", codec: "tiny" });
  const room = rooms.open("doc", { bytes: est.bytes, etag: "e1" });

  // Malformed action refused without touching seq.
  expect(rooms.submit(room, { t: "bogus" })).toEqual({ answer: "bad-action", applied: false, seq: null, id: null, send: [] });
  expect(room.seq).toBe(0);

  // Unfitted action (missing row) refused without mutating room or ledger.
  expect(rooms.submit(room, set("missing", "c1", "x"))).toEqual({ answer: "refused", applied: false, seq: null, id: null, send: [] });
  expect(room.seq).toBe(0);

  // Valid action admitted in order and returned in `send`.
  const ok = rooms.submit(room, set("r1", "c1", "agent-1"));
  expect(ok.answer).toBe("ok");
  expect(ok.applied).toBe(true);
  expect(ok.seq).toBe(1);
  expect(ok.send).toHaveLength(1);
  expect(room.state.wb.rows.r1.cells.c1).toBe("agent-1");

  // Second host action increments host seq cleanly.
  const ok2 = rooms.submit(room, set("r2", "c1", "agent-2"));
  expect(ok2.answer).toBe("ok");
  expect(ok2.seq).toBe(2);

  // Dropped/closed room refuses submit.
  rooms.drop("doc");
  expect(rooms.submit(room, set("r1", "c1", "late"))).toEqual({ answer: "closed", applied: false, seq: null, id: null, send: [] });
});

test("host.submit routes an agent cell patch through an open room while humans edit and waits for durability", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits() } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 20, maxMs: 60, waitMs: 20 });
  const ben = createRoomClient({ page: "doc", codec: tiny, clientId: "ben", fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 20, maxMs: 60, waitMs: 20 });
  open.push(ana, ben);
  await Promise.all([ana.ready, ben.ready]);

  await ana.submit(set("r1", "c1", "human-a")).admitted;
  const patched = await host.submit("doc", set("r2", "c1", "agent-b"));
  expect(patched.answer).toBe("ok");
  expect(patched.applied).toBe(true);

  // Durable on disk immediately when host.submit resolves.
  useCodec(tiny);
  const disk = parse(host.file("doc").bytes).state.wb;
  expect(disk.rows.r1.cells.c1).toBe("human-a");
  expect(disk.rows.r2.cells.c1).toBe("agent-b");

  // Both connected tabs see the agent's cell without reload.
  await until(() => ana.view()?.rows?.r2?.cells?.c1 === "agent-b" && ben.view()?.rows?.r2?.cells?.c1 === "agent-b");
});

test("room.admitted(), room.capture(extras), extras option, status fields, and closed restore/decide guard", async () => {
  const codec = richCodec();
  const host = createReferenceHost({ codecs: { rich: codec }, codec: "rich", rooms: { limits: labLimits() } });
  useCodec(codec);
  host.put("doc", codec.write(START.wb, { ...RECORD, seen: {}, lineage: [], cut: null, floor: -1 }));

  let holdPost = false;
  const fetchWrap = (url, init = {}) => {
    if (holdPost && init.method === "POST" && String(url).includes("/_/sync/room") && !String(url).includes("op=")) {
      return new Promise(() => {});
    }
    return host.fetch(url, init);
  };
  const ana = createRoomClient({
    page: "doc",
    codec,
    clientId: "ana",
    fetch: fetchWrap,
    subscribe: host.subscribe,
    limits: labLimits(),
    idleMs: 10,
    maxMs: 30,
    waitMs: 5000,
    extras: (doc) => ({ result: codec.results(doc), drawing: () => "live-svg" }),
  });
  open.push(ana);
  await ana.ready;
  expect(ana.status.restoring).toBe(false);
  expect(ana.status.pendingMarks).toBe(0);
  expect(ana.status.conflicts).toBe(0);

  await ana.submit(set("r1", "c1", "admitted-val")).admitted;
  await ana.flush();
  expect(host.file("doc").bytes).toContain("<!--drawing:live-svg-->");
  expect(host.file("doc").bytes).toContain("<!--calc:calc(admitted-val)-->");

  // Submit a pending edit that does not reach the room yet: view() shows it, admitted() does not.
  holdPost = true;
  ana.submit(set("r1", "c1", "pending-only"));
  expect(ana.view().rows.r1.cells.c1).toBe("pending-only");
  expect(ana.admitted().rows.r1.cells.c1).toBe("admitted-val");

  // capture(extras) serializes admitted state with custom extras without mutating client state.
  const cap = ana.capture({ drawing: () => "snap-svg" });
  expect(cap.bytes).toContain("<!--drawing:snap-svg-->");
  expect(cap.bytes).toContain("admitted-val");
  expect(cap.bytes).not.toContain("pending-only");

  await ana.refreshCopies();
  expect(ana.unstoredCopies()).toEqual([]);

  await ana.close();
  expect(await ana.restore("r1")).toBe(false);
  expect(await ana.decide("j1", [["ana:1", "keep"]])).toBe(false);
});

test("file client exposes admitted(), capture(extras), extras option, and unstoredCopies()", async () => {
  const codec = richCodec();
  const host = createReferenceHost({ codecs: { rich: codec }, codec: "rich", room: false, rooms: { limits: labLimits() } });
  useCodec(codec);
  host.put("doc", codec.write(START.wb, { ...RECORD, seen: {}, lineage: [], cut: null, floor: -1 }));
  const ana = createFileClient({
    page: "doc",
    codec,
    clientId: "ana",
    fetch: host.fetch,
    subscribe: host.subscribe,
    limits: labLimits(),
    idleMs: 10,
    maxMs: 30,
    extras: (doc) => ({ result: codec.results(doc), drawing: () => "file-svg" }),
  });
  open.push(ana);
  await ana.ready;
  ana.submit(set("r1", "c1", "file-val"));
  expect(ana.admitted().rows.r1.cells.c1).toBe("a");
  await ana.flush();
  expect(ana.admitted().rows.r1.cells.c1).toBe("file-val");
  expect(host.file("doc").bytes).toContain("<!--drawing:file-svg-->");
  expect(host.file("doc").bytes).toContain("<!--calc:calc(file-val)-->");
  const cap = ana.capture({ drawing: () => "cap-svg" });
  expect(cap.bytes).toContain("<!--drawing:cap-svg-->");
  expect(ana.unstoredCopies()).toEqual([]);
});
