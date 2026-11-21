/**
 * @jest-environment node
 */
// The ordered room type is what a host process calls: no I/O, the host reports every
// accepted write. These tests drive it the way a host would, with the lab's small
// workbook codec and a fake clock.
import { createOrderedRooms, createRooms, LIVE_LIMITS } from "../../../src/server/rooms/index.js";
import { serialize, parse } from "../../../src/live-room/core/record.js";
import { useCodec } from "../../../src/live-room/core/codec.js";
import { labLimits } from "../../../src/live-room/core/limits.js";
import { explode } from "../../../src/live-room/core/frames.js";
import { stateReserve } from "../../../src/live-room/core/room.js";
import { codec as tiny } from "../../live-room/lab/codec-tiny/reducer.mjs";

const RECORD = { v: 2, doc: "doc0123456789abc", gen: "0.00000000", epoch: 0, commit: "c00000000000", parent: null, through: 0 };
const START = { wb: { rows: { r1: { pos: "1", cells: { c1: "a" } }, r2: { pos: "2", cells: {} } } }, seen: {}, lineage: [], cut: null, floor: -1 };

function setup(options = {}) {
  let time = 1000;
  let ids = 0;
  const rooms = createOrderedRooms({ codecs: { tiny }, limits: labLimits(), now: () => time, newId: () => 1000 * ++ids, retainMs: 60_000, ...options });
  useCodec(tiny);
  const file = serialize(RECORD, START);
  return { rooms, file, tick: (ms) => (time += ms) };
}

function opened(options) {
  const s = setup(options);
  const est = s.rooms.establish("doc", { bytes: s.file, etag: "e0", codec: "tiny" });
  const room = s.rooms.open("doc", { bytes: est.bytes, etag: "e1" });
  return { ...s, est, room, bytes: est.bytes };
}

function request(room, c, n, action) {
  return { k: "req", gen: room.gen, c, n, p: n - 1, b: room.epoch, e: `${c}:${n}`, action, saw: tiny.seen(room.state.wb, action) };
}

function saved(room, bytes) {
  useCodec(tiny);
  const { record, state } = parse(bytes);
  return serialize({ ...record, commit: "c99999999990", parent: room.base.commit, through: room.seq }, { ...state, wb: structuredClone(room.state.wb), seen: structuredClone(room.state.seen) });
}

const set = (row, col, value) => ({ t: "set", row, col, value });

test("a session: the host establishes, opens after its write, admits frames and makes the receipt when it accepts the save", () => {
  const { rooms, room, bytes, est } = opened();
  expect(est.record.room).toBe(room.id);
  expect(rooms.get("doc")).toBe(room);
  const ana = rooms.attach(room, "ana", "conn-ana");
  rooms.attach(room, "ben", "conn-ben");
  expect(ana).toEqual({ gen: room.gen, base: room.base, tail: [] });
  const sent = rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "ben")));
  expect(sent.answer).toBe("ok");
  expect(sent.send).toEqual([expect.objectContaining({ k: "act", seq: 1, c: "ben" })]);
  expect(rooms.leave(room, "conn-ben")).toEqual({ empty: false, dirty: true, send: [] });
  const file = saved(room, bytes);
  const told = rooms.fileAccepted("doc", { bytes: file, etag: "e2" });
  expect(told.answer).toBe("commit");
  expect(told.send).toEqual([expect.objectContaining({ k: "receipt", through: 1, etag: "e2" })]);
  expect(room.base).toEqual(expect.objectContaining({ through: 1, etag: "e2" }));
  expect(rooms.leave(room, "conn-ana")).toEqual({ empty: true, dirty: false, send: [] });
});

test("no frame is admitted before the host opens the room, and open refuses bytes that do not name the room", () => {
  const { rooms, file } = setup();
  rooms.establish("doc", { bytes: file, etag: "e0", codec: "tiny" });
  expect(rooms.get("doc")).toBeNull();
  expect(rooms.open("doc", { bytes: file, etag: "e0" })).toBeNull();
  expect(rooms.get("doc")).toBeNull();
});

test("a receipt a client reports is refused unless it names the commit the host accepted", () => {
  const { rooms, room } = opened();
  rooms.attach(room, "ben", "conn-ben");
  rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "ben")));
  const claim = rooms.frame(room, "ben", { k: "receipt", gen: room.gen, commit: "c12345678901", etag: "e9", through: 1 });
  expect(claim.answer).toBe("unseen");
  expect(room.base.through).toBe(0);
});

test("malformed frames, invalid actions and frames of another generation are refused before they reach the room", () => {
  const { rooms, room } = opened();
  rooms.attach(room, "ben", "conn-ben");
  expect(rooms.frame(room, "ben", { k: "req", gen: room.gen, c: "ben" }).answer).toBe("bad-frame");
  expect(rooms.frame(room, "ben", { k: "nonsense", gen: room.gen }).answer).toBe("bad-frame");
  expect(rooms.frame(room, "ben", request(room, "ben", 1, { t: "set", row: 7, col: "c1", value: "x" })).answer).toBe("bad-action");
  expect(rooms.frame(room, "ben", { ...request(room, "ben", 1, set("r1", "c1", "x")), gen: "9.00000001" }).answer).toBe("stale");
  expect(room.seq).toBe(0);
});

test("a room refuses a frame it has no space for", () => {
  const { rooms, room } = opened();
  rooms.attach(room, "ben", "conn-ben");
  const answers = [];
  for (let n = 1; n <= 40; n++) answers.push(rooms.frame(room, "ben", request(room, "ben", n, set("r1", "c1", "x".repeat(200)))).answer);
  expect(answers).toContain("full");
  expect(answers.indexOf("full")).toBeGreaterThan(0);
});

test("sweep never drops a room with unsaved edits, and drops a clean idle room only after retainMs", () => {
  const { rooms, room, tick } = opened();
  rooms.attach(room, "ben", "conn-ben");
  rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "ben")));
  rooms.leave(room, "conn-ben");
  tick(10 * 60_000);
  expect(rooms.sweep()).toEqual([]);
  expect(rooms.get("doc")).toBe(room);
  const clean = opened();
  clean.rooms.attach(clean.room, "ana", "conn-ana");
  clean.rooms.leave(clean.room, "conn-ana");
  clean.tick(30_000);
  expect(clean.rooms.sweep()).toEqual([]);
  clean.tick(31_000);
  expect(clean.rooms.sweep()).toEqual(["doc"]);
  expect(clean.rooms.get("doc")).toBeNull();
});

test("a write that changes only bytes outside the tables keeps the room; a changed table under a kept record ends it", () => {
  const { rooms, room, bytes } = opened();
  const titled = bytes.replace("<!doctype html>", "<!doctype html><title>t</title>");
  expect(rooms.fileAccepted("doc", { bytes: titled, etag: "e5" }).answer).toBe("same");
  expect(rooms.get("doc")).toBe(room);
  expect(room.base.etag).toBe("e5");
  useCodec(tiny);
  const { record, state } = parse(bytes);
  state.wb.rows.r2.cells.c2 = "agent";
  expect(rooms.fileAccepted("doc", { bytes: serialize(record, state), etag: "e6" }).answer).toBe("outside");
  expect(rooms.get("doc")).toBeNull();
});

test("only codecs on the allowed list are announced or established", () => {
  const { rooms, file } = setup();
  expect(rooms.capability("tiny")).toBe(true);
  expect(rooms.capability("sheet")).toBe(false);
  expect(rooms.establish("doc", { bytes: file, etag: "e0", codec: "sheet" })).toBeNull();
});

test("ordered rooms and live rooms charge one byte total and one room count", () => {
  const full = setup({ liveBytes: 10_000, others: { used: () => 10_000, size: () => 0 } });
  expect(full.rooms.establish("doc", { bytes: full.file, etag: "e0", codec: "tiny" })).toBeNull();
  const counted = setup({ maxRooms: 3, others: { used: () => 0, size: () => 3 } });
  expect(counted.rooms.establish("doc", { bytes: counted.file, etag: "e0", codec: "tiny" })).toBeNull();
  const { rooms } = opened();
  expect(rooms.used()).toBeGreaterThan(0);
  expect(rooms.size()).toBe(1);
  const live = createRooms({ others: { used: () => 0, size: () => LIVE_LIMITS.rooms } });
  expect(live.open("page", "<!doctype html><html><body></body></html>", { nodeId: "n" })).toBeNull();
  const roomy = createRooms({ others: { used: () => 0, size: () => 0 } });
  expect(roomy.open("page", "<!doctype html><html><body></body></html>", { nodeId: "n" })).not.toBeNull();
});

const paste = (count) => ({ t: "paste", cells: Array.from({ length: count }, (_, i) => ["r1", `c${i}`, `v${i}`]) });

function parts(room, c, n, action) {
  useCodec(tiny);
  return explode(request(room, c, n, action), `q:${c}:${n}`, labLimits());
}

test("a paste in parts is admitted when its last part lands, and parts that would hold memory the room does not count are refused", () => {
  const { rooms, room } = opened();
  rooms.attach(room, "ben", "conn-ben");
  const pieces = parts(room, "ben", 1, paste(6));
  expect(pieces.length).toBeGreaterThan(1);
  for (const piece of pieces.slice(0, -1)) expect(rooms.frame(room, "ben", piece).answer).toBe("staged");
  expect(rooms.frame(room, "ben", pieces.at(-1)).answer).toBe("ok");
  expect(room.seq).toBe(1);
  const tampered = parts(room, "ben", 2, paste(6));
  for (const piece of tampered.slice(0, -1)) rooms.frame(room, "ben", piece);
  expect(rooms.frame(room, "ben", { ...tampered.at(-1), cells: [[7, 8, 9]] }).answer).toBe("bad-action");
  expect(room.seq).toBe(1);
  const [first] = parts(room, "ben", 3, paste(6));
  expect(rooms.frame(room, "ben", { ...first, m: 100_000_000 }).answer).toBe("bad-frame");
  expect(rooms.frame(room, "ben", { ...first, order: undefined }).answer).toBe("bad-frame");
  expect(rooms.frame(room, "ben", { ...first, key: "q:ben:9", pad: "x".repeat(60_000) }).answer).toBe("bad-size");
  expect(rooms.frame(room, "ben", { ...first, key: "q:ben:8", size: 0 }).answer).toBe("bad-frame");
  expect(room.staging.size).toBe(0);
  expect(rooms.frame(room, "ben", { ...first, size: 2 ** 40 }).answer).toBe("bad-size");
});

test("an adopt offer whose held frame was a duplicate is admitted with the rest of the offer", () => {
  const { rooms, room } = opened();
  rooms.attach(room, "ben", "conn-ben");
  const from = RECORD.gen;
  const offer = { k: "adopt", gen: room.gen, from, items: [
    { n: 1, c: "ana", rn: 1, org: [from, 1], e: "ana:1", action: null, saw: null },
    { n: 2, c: "ben", rn: 1, org: [from, 2], e: "ben:1", action: set("r1", "c1", "held"), saw: tiny.seen(room.state.wb, set("r1", "c1", "held")) },
  ] };
  expect(rooms.frame(room, "ben", offer).answer).toBe("ok");
  expect(room.state.wb.rows.r1.cells.c1).toBe("held");
});

test("client frames that the core cannot read are refused, and none of them changes the room", () => {
  const { rooms, room } = opened();
  rooms.attach(room, "ben", "conn-ben");
  const before = JSON.stringify(room.state);
  expect(rooms.frame(room, "ben", { ...request(room, "ben", 1, set("r1", "c1", "x")), c: "__proto__" }).answer).toBe("bad-frame");
  const copy = { k: "copy", gen: room.gen, job: "j1", copy: "x", i: 0, p: 0, n: 1, c: "ben", e: "ben:1", via: [] };
  expect(rooms.frame(room, "ben", copy).answer).toBe("bad-action");
  expect(rooms.frame(room, "ben", { ...copy, e: undefined, action: set("r1", "c1", "x") }).answer).toBe("bad-frame");
  expect(rooms.frame(room, "ben", { ...request(room, "ben", 1, set("r1", "c1", "x")), c: "toString" }).answer).toBe("bad-frame");
  const from = RECORD.gen;
  const half = { k: "adopt", gen: room.gen, from, items: [
    { n: 1, c: "ana", rn: 1, org: [from, 1], e: "ana:1", action: set("r1", "c1", "half"), saw: tiny.seen(room.state.wb, set("r1", "c1", "half")) },
    { n: 2, c: "toString", rn: 1, org: [from, 2], e: "t:1", action: set("r1", "c1", "y"), saw: null },
  ] };
  expect(rooms.frame(room, "ben", half).answer).toBe("bad-frame");
  expect(rooms.frame(room, "ben", { k: "copy", gen: room.gen, via: 5, action: set("r1", "c1", "x") }).answer).toBe("bad-frame");
  expect(rooms.frame(room, "ben", { k: "adopt", gen: room.gen, from: "x", items: [{ n: 1, c: "ana", rn: "x", action: null }] }).answer).toBe("bad-frame");
  expect(rooms.frame(room, "ben", { k: "adopt", gen: room.gen, from: "x", items: [{ n: 1, c: "ana", rn: 1, via: 5, action: null }] }).answer).toBe("bad-frame");
  expect(JSON.stringify(room.state)).toBe(before);
  expect(rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "x"))).answer).toBe("ok");
});

test("an older commit put back, or a file whose tag is gone or torn, ends the room and reports what was unsaved", () => {
  const { rooms, room, bytes } = opened();
  rooms.attach(room, "ben", "conn-ben");
  rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "one")));
  const first = saved(room, bytes);
  expect(rooms.fileAccepted("doc", { bytes: first, etag: "e2" }).answer).toBe("commit");
  rooms.frame(room, "ben", request(room, "ben", 2, set("r1", "c1", "two")));
  useCodec(tiny);
  const second = serialize({ ...parse(first).record, commit: "c99999999991", parent: room.base.commit, through: 2 }, { ...room.state });
  expect(rooms.fileAccepted("doc", { bytes: second, etag: "e3" }).answer).toBe("commit");
  expect(rooms.fileAccepted("doc", { bytes: first, etag: "e4" })).toEqual({ answer: "outside", send: [], dirty: false });
  expect(rooms.get("doc")).toBeNull();
  for (const broken of [bytes.replace(/<script[^]*<\/script>/, ""), bytes.replace("</script>", "")]) {
    const fresh = opened();
    fresh.rooms.attach(fresh.room, "ben", "conn-ben");
    fresh.rooms.frame(fresh.room, "ben", request(fresh.room, "ben", 1, set("r1", "c1", "x")));
    expect(fresh.rooms.fileAccepted("doc", { bytes: broken, etag: "e9" })).toEqual({ answer: "outside", send: [], dirty: true });
    expect(fresh.rooms.get("doc")).toBeNull();
  }
});

test("frames are refused while the process is over its byte total, and the live rooms count the ordered rooms' bytes", () => {
  let other = 0;
  const { rooms, room } = opened({ liveBytes: 50_000, others: { used: () => other, size: () => 0 } });
  rooms.attach(room, "ben", "conn-ben");
  expect(rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "x"))).answer).toBe("ok");
  other = 50_000 - rooms.used();
  expect(rooms.frame(room, "ben", request(room, "ben", 2, set("r1", "c1", "y"))).answer).toBe("full");
  const live = createRooms({ liveBytes: 1000, others: { used: () => 5000, size: () => 0 } });
  expect(live.open("page", "<!doctype html><html><body><p>x</p></body></html>", { nodeId: "n" })).toBeNull();
});

test("leave finds the room by its connection, sweep keeps a room the host still has connections to, and drop reports unsaved edits", () => {
  const { rooms, room, tick } = opened();
  rooms.attach(room, "ben", "conn-ben");
  rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "x")));
  expect(rooms.leave({}, "conn-ben")).toEqual({ empty: true, dirty: true, send: [] });
  expect(room.gone?.has("ben")).toBe(true);
  expect(rooms.drop("doc")).toEqual({ dirty: true });
  const clean = opened();
  clean.tick(10 * 60_000);
  expect(clean.rooms.sweep(() => 1)).toEqual([]);
  expect(clean.rooms.sweep(() => 0)).toEqual(["doc"]);
});

test("the host may report its establishing write before it opens the room, and open never ends a room that is already open", () => {
  const { rooms, file } = setup();
  const est = rooms.establish("doc", { bytes: file, etag: "e0", codec: "tiny" });
  expect(rooms.fileAccepted("doc", { bytes: est.bytes, etag: "e1" }).answer).toBe("establishing");
  const room = rooms.open("doc", { bytes: est.bytes, etag: "e1" });
  expect(room).toBe(rooms.get("doc"));
  rooms.attach(room, "ben", "conn-ben");
  rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "x")));
  expect(rooms.open("doc", { bytes: file, etag: "e0" })).toBeNull();
  expect(rooms.get("doc")).toBe(room);
  expect(rooms.leave(room, "conn-ben").dirty).toBe(true);
});

test("an earlier generation of the room put back by a sync ends the room instead of reopening it", () => {
  const { rooms, room, bytes } = opened();
  const turned = rooms.establish("doc", { bytes, etag: "e1", codec: "tiny" });
  expect(rooms.fileAccepted("doc", { bytes: turned.bytes, etag: "e2" }).answer).toBe("establishing");
  const newer = rooms.get("doc");
  expect(newer.gen).not.toBe(room.gen);
  rooms.attach(newer, "ben", "conn-ben");
  rooms.frame(newer, "ben", request(newer, "ben", 1, set("r1", "c1", "x")));
  expect(rooms.fileAccepted("doc", { bytes, etag: "e3" })).toEqual({ answer: "outside", send: [], dirty: true });
});

test("the host's commits keep the document's own id", () => {
  const { rooms } = setup();
  useCodec(tiny);
  const mine = serialize({ ...RECORD, doc: "docZZZZZZZZZZZZZ" }, START);
  const est = rooms.establish("doc", { bytes: mine, etag: "e0", codec: "tiny" });
  expect(est.record.doc).toBe("docZZZZZZZZZZZZZ");
});

test("a paste over filled cells and a part sent again are admitted; establish on a file without a tag is refused without holding a room", () => {
  const { rooms, room, file } = opened({ limits: labLimits({ roomBytes: 64 * 1024, storeBytes: 32 * 1024 }) });
  rooms.attach(room, "ben", "conn-ben");
  const pieces = parts(room, "ben", 1, paste(6));
  for (let again = 0; again < 40; again++) expect(rooms.frame(room, "ben", pieces[0]).answer).toBe("staged");
  for (const piece of pieces.slice(1, -1)) rooms.frame(room, "ben", piece);
  expect(rooms.frame(room, "ben", pieces.at(-1)).answer).toBe("ok");
  const wide = (v) => ({ t: "paste", cells: Array.from({ length: 6 }, (_, i) => ["r2", `c${i}`, v.repeat(120)]) });
  for (const [n, v] of [[2, "a"], [3, "b"]]) {
    const chunk = parts(room, "ben", n, wide(v));
    if (n === 3) expect(chunk[0].size).toBeGreaterThan(labLimits().actionBytes);
    let answer;
    for (const piece of chunk) answer = rooms.frame(room, "ben", piece).answer;
    expect(answer).toBe("ok");
  }
  const fresh = setup({ maxRooms: 1 });
  expect(fresh.rooms.establish("doc", { bytes: "<!doctype html><p>no tag</p>", etag: "e0", codec: "tiny" })).toBeNull();
  expect(fresh.rooms.size()).toBe(0);
  expect(fresh.rooms.mayFit("other", file)).toBe(true);
  expect(fresh.rooms.mayFit("other", 10 ** 9)).toBe(false);
});

test("a client that leaves with a staged paste frees its space and tells the others; a connection that moves rooms leaves the first", () => {
  const { rooms, room } = opened();
  rooms.attach(room, "ana", "conn-ana");
  rooms.attach(room, "ben", "conn-ben");
  const pieces = parts(room, "ana", 1, paste(6));
  rooms.frame(room, "ana", pieces[0]);
  expect(room.bytes.staged).toBeGreaterThan(0);
  expect(rooms.leave(room, "conn-ana").send).toEqual([{ to: "*", k: "space" }]);
  expect(room.bytes.staged).toBe(0);
  const est = rooms.establish("doc2", { bytes: serialize(RECORD, START), etag: "f0", codec: "tiny" });
  const second = rooms.open("doc2", { bytes: est.bytes, etag: "f1" });
  const shared = { id: "socket" };
  rooms.attach(room, "cy", shared);
  expect(rooms.attach(second, "cy", shared)).not.toBeNull();
  expect(rooms.leave(room, "conn-ben")).toEqual(expect.objectContaining({ empty: true }));
});

test("a room is charged its file and twice its unsaved bytes, and a frame that would pass the process total is refused", () => {
  const reserve = stateReserve(labLimits());
  const { rooms, room, bytes } = opened();
  const empty = rooms.used();
  expect(empty).toBe(Buffer.byteLength(bytes, "utf8") + reserve);
  rooms.attach(room, "ben", "conn-ben");
  rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "x")));
  expect(rooms.used() - empty).toBe(2 * room.bytes.tail);
  const frame = request(room, "ben", 2, set("r1", "c1", "y"));
  const wire = Buffer.byteLength(JSON.stringify(frame), "utf8");
  const tight = opened({ liveBytes: empty + 2 * room.bytes.tail + wire + 1 });
  tight.rooms.attach(tight.room, "ben", "conn-ben");
  tight.rooms.frame(tight.room, "ben", request(tight.room, "ben", 1, set("r1", "c1", "x")));
  expect(tight.rooms.frame(tight.room, "ben", request(tight.room, "ben", 2, set("r1", "c1", "y"))).answer).toBe("full");
});

test("part frames that would make the room hold memory it does not charge are refused", () => {
  const { rooms, room } = opened();
  rooms.attach(room, "ben", "conn-ben");
  const [first] = parts(room, "ben", 1, paste(6));
  expect(rooms.frame(room, "ben", { ...first, m: 6000 }).answer).toBe("bad-frame");
  const answers = [];
  const quiet = rooms.used();
  for (let n = 0; n < 12; n++) answers.push(rooms.frame(room, "ben", { ...first, key: `flood:${n}` }).answer);
  expect(answers.slice(0, 8).every((answer) => answer === "staged")).toBe(true);
  expect(answers.slice(8)).toEqual(["full", "full", "full", "full"]);
  expect(rooms.used() - quiet).toBeGreaterThanOrEqual(8 * 1024);
  const before = rooms.used();
  rooms.leave(room, "conn-ben");
  expect(rooms.used()).toBeLessThan(before);
});

test("a room refused for the process total is woken when another room frees space", () => {
  const woken = [];
  let other = 0;
  const { rooms, room, bytes } = opened({ liveBytes: 40_000, others: { used: () => other, size: () => 0 }, onSpace: (key) => woken.push(key) });
  rooms.attach(room, "ben", "conn-ben");
  other = 40_000 - rooms.used();
  expect(rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "x"))).answer).toBe("full");
  rooms.wake();
  expect(woken).toEqual([]);
  rooms.attach(room, "cy", "conn-cy");
  other = 0;
  rooms.leave(room, "conn-cy");
  expect(woken).toEqual(["doc"]);
  rooms.wake();
  expect(woken).toEqual(["doc"]);
  expect(rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "x"))).answer).toBe("ok");
  void bytes;
});

// Bug it catches: the room keeps every judged restore offer and its answer until the next
// generation, so a registry that charges nothing for them lets restore jobs fill the heap; and
// a registry whose ids refuse the tab's job ids ("tab#1") never lets a restore reach the room.
test("a restore offer with the tab's job id reaches the room, and its bytes stay charged while the room keeps the job", () => {
  const { rooms, room } = opened();
  rooms.attach(room, "ben", "conn-ben");
  const before = rooms.used();
  const offer = { k: "copy", gen: room.gen, job: "ben#1", copy: "x", i: 0, p: 0, n: 1, c: "ben", e: "ben:1", via: [], origin: [], action: set("r1", "c1", "x".repeat(4000)), saw: ["not what the room holds"] };
  expect(rooms.frame(room, "ben", offer).answer).toEqual(expect.objectContaining({ how: expect.any(String) }));
  expect(room.restores.size).toBe(1);
  expect(rooms.used() - before).toBeGreaterThanOrEqual(2 * Buffer.byteLength(JSON.stringify(offer), "utf8"));
});

// Bug it catches: a stage that reserved its space when it opened is checked against the process
// total again for every later part, so a paste that fits is refused partway and left staged.
test("a paste whose stage fit when it opened is admitted to its last part", () => {
  const probe = opened();
  probe.rooms.attach(probe.room, "ben", "conn-ben");
  const [head] = parts(probe.room, "ben", 1, paste(6));
  const reserve = 2 * 2 * head.size + 64 * head.m + 1024;
  const { rooms, room } = opened({ liveBytes: probe.rooms.used() + reserve + 16 });
  rooms.attach(room, "ben", "conn-ben");
  const pieces = parts(room, "ben", 1, paste(6));
  for (const piece of pieces.slice(0, -1)) expect(rooms.frame(room, "ben", piece).answer).toBe("staged");
  expect(rooms.frame(room, "ben", pieces.at(-1)).answer).toBe("ok");
});

function agentWrote(bytes, row, col, value) {
  useCodec(tiny);
  const { record, state } = parse(bytes);
  state.wb.rows[row].cells[col] = value;
  return serialize(record, state);
}

test("an agent's write while the room holds unsaved edits: the host keeps them in a backup, writes a new generation with a cut, and the room reopens on it", () => {
  const { rooms, room, bytes } = opened();
  rooms.attach(room, "ben", "conn-ben");
  rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "ben")));
  const step = rooms.outsideWrite("doc", { bytes: agentWrote(bytes, "r2", "c2", "agent"), current: bytes, codec: "tiny" });
  expect(step).toEqual(expect.objectContaining({ same: false, dirty: true, kept: true }));
  useCodec(tiny);
  const backup = parse(step.backup);
  expect(backup.record).toEqual(expect.objectContaining({ gen: room.gen, through: 1, parent: room.base.commit }));
  expect(backup.state.wb.rows.r1.cells.c1).toBe("ben");
  const written = parse(step.bytes);
  expect(written.record).toEqual(expect.objectContaining({ epoch: room.epoch + 1, through: 0, room: room.id }));
  expect(written.record.gen).not.toBe(room.gen);
  expect(written.state.cut).toEqual([room.gen, 1, { ben: [0, 1] }]);
  expect(written.state.wb.rows.r2.cells.c2).toBe("agent");
  expect(written.state.wb.rows.r1.cells.c1).toBe("a");
  expect(rooms.fileAccepted("doc", { bytes: step.bytes, etag: "e3" }).answer).toBe("establishing");
  expect(rooms.get("doc").gen).toBe(written.record.gen);
});

test("an outside write on a host that does not reopen drops the room now, and the file names no instance", () => {
  const { rooms, room, bytes } = opened();
  rooms.attach(room, "ben", "conn-ben");
  rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "ben")));
  const step = rooms.outsideWrite("doc", { bytes: agentWrote(bytes, "r2", "c2", "upload"), current: bytes, codec: "tiny", keep: false });
  expect(step).toEqual(expect.objectContaining({ same: false, dirty: true, kept: false }));
  expect(step.backup).not.toBeNull();
  expect(step.record.room).toBeNull();
  expect(rooms.get("doc")).toBeNull();
  expect(rooms.fileAccepted("doc", { bytes: step.bytes, etag: "e3" }).answer).toBe("none");
});

test("an outside write that changes only bytes outside the tables keeps the room and its generation", () => {
  const { rooms, room, bytes } = opened();
  const titled = bytes.replace("<!doctype html>", "<!doctype html><title>t</title>");
  expect(rooms.outsideWrite("doc", { bytes: titled, current: bytes, codec: "tiny" })).toEqual({ same: true, bytes: titled });
  expect(rooms.fileAccepted("doc", { bytes: titled, etag: "e4" }).answer).toBe("same");
  expect(rooms.get("doc")).toBe(room);
});

test("the host's own commit covers every admitted edit and is the room's next commit; a clean room has none to make", () => {
  const { rooms, room, est } = opened();
  expect(rooms.render(room)).toBeNull();
  rooms.attach(room, "ben", "conn-ben");
  rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "ben")));
  rooms.frame(room, "ben", request(room, "ben", 2, set("r2", "c1", "two")));
  const own = rooms.render(room);
  expect(own.record).toEqual(expect.objectContaining({ gen: room.gen, through: 2, parent: est.record.commit, room: room.id }));
  useCodec(tiny);
  expect(parse(own.bytes).state.wb.rows.r2.cells.c1).toBe("two");
  const told = rooms.fileAccepted("doc", { bytes: own.bytes, etag: "e7" });
  expect(told.answer).toBe("commit");
  expect(told.send).toEqual([expect.objectContaining({ k: "receipt", through: 2, etag: "e7" })]);
  expect(rooms.render(room)).toBeNull();
});

// Bug it catches: a version restored over equal tables is written with its old record, so the
// host's next fileAccepted ends the dirty room with no backup and a coworker's edit is lost.
test("a version restored over equal tables keeps the current record, the room and its unsaved edits", () => {
  const { rooms, room, bytes } = opened();
  useCodec(tiny);
  const older = serialize({ ...RECORD, commit: "c00000000007" }, START);
  rooms.attach(room, "ben", "conn-ben");
  rooms.frame(room, "ben", request(room, "ben", 1, set("r2", "c2", "ben")));
  const step = rooms.outsideWrite("doc", { bytes: older, current: bytes, codec: "tiny" });
  expect(step).toEqual({ same: true, bytes });
  expect(rooms.fileAccepted("doc", { bytes: step.bytes, etag: "e8" }).answer).toBe("same");
  expect(rooms.get("doc")).toBe(room);
  expect(room.state.wb.rows.r2.cells.c2).toBe("ben");
});

// Bug it catches: a sheet made from a template whose record is a placeholder (`{"rev":1}`, no
// ledger) cannot open a room: establishing reads the missing ledger and throws, so nobody can
// co-edit a new sheet.
test("a template's placeholder record opens a room as a fresh document", () => {
  const { rooms } = setup();
  useCodec(tiny);
  const placeholder = tiny.write(START.wb, { rev: 1 });
  const est = rooms.establish("doc", { bytes: placeholder, etag: "e0", codec: "tiny" });
  const room = rooms.open("doc", { bytes: est.bytes, etag: "e1" });
  expect(room.gen).toBeTruthy();
  const { record, state } = parse(est.bytes);
  expect(record).toEqual(expect.objectContaining({ v: 2, epoch: 1 }));
  expect(state.wb).toEqual(START.wb);
  rooms.attach(room, "ben", "conn-ben");
  expect(rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "ben"))).answer).toBe("ok");
});

// Bug it catches: rooms.submit (P5b) admitted invalid/unfitted actions or failed to broadcast and
// advance room.seq for host-side agent cell patches, or bypassed process liveBytes caps.
test("rooms.submit admits valid host actions in order, broadcasts to tabs, and refuses invalid, unfitted, closed, or over-budget actions", () => {
  const { rooms, room } = opened();
  rooms.attach(room, "ben", "conn-ben");
  expect(rooms.submit(room, { t: "bogus" })).toEqual({ answer: "bad-action", applied: false, seq: null, id: null, send: [] });
  expect(rooms.submit(room, set("no-such-row", "c1", "x"))).toEqual({ answer: "refused", applied: false, seq: null, id: null, send: [] });
  expect(room.seq).toBe(0);

  const ok = rooms.submit(room, set("r1", "c1", "agent-patch"));
  expect(ok.answer).toBe("ok");
  expect(ok.applied).toBe(true);
  expect(ok.seq).toBe(1);
  expect(ok.id).toMatch(/^h:/);
  expect(ok.send.length).toBeGreaterThanOrEqual(1);
  expect(room.state.wb.rows.r1.cells.c1).toBe("agent-patch");

  const rendered = rooms.render(room);
  expect(rendered.record.through).toBe(1);
  useCodec(tiny);
  expect(parse(rendered.bytes).state.wb.rows.r1.cells.c1).toBe("agent-patch");

  // Closed room refuses.
  rooms.drop("doc");
  expect(rooms.submit(room, set("r1", "c1", "late"))).toEqual({ answer: "closed", applied: false, seq: null, id: null, send: [] });

  // Over process liveBytes cap refuses with "full".
  let other = 0;
  const tight = opened({ liveBytes: 40_000, others: { used: () => other, size: () => 0 } });
  other = 40_000 - tight.rooms.used();
  expect(tight.rooms.submit(tight.room, set("r1", "c1", "x")).answer).toBe("full");
});

// Bug it catches: ends() allowed a POST /_/save carrying epoch > room.epoch to bypass 409 and wipe a
// dirty room without backup, and allowed an out-of-range through to desynchronize room.base.commit.
test("ends() rejects forged establishing commits and out-of-range through values on an open room", () => {
  const { rooms, room, bytes } = opened();
  rooms.attach(room, "ben", "conn-ben");
  rooms.frame(room, "ben", request(room, "ben", 1, set("r1", "c1", "ben")));
  useCodec(tiny);
  const parsed = parse(bytes);
  const forgedEstablish = serialize(
    { ...parsed.record, gen: `${room.epoch + 1}.00000099`, epoch: room.epoch + 1, commit: "c99999999901", parent: room.base.commit, through: 0, room: room.id },
    parsed.state,
  );
  expect(rooms.ends("doc", forgedEstablish)).toBe(true);

  const staleThrough = serialize(
    { ...parsed.record, commit: "c99999999902", parent: room.base.commit, through: 0, room: room.id },
    parsed.state,
  );
  const beyondThrough = serialize(
    { ...parsed.record, commit: "c99999999903", parent: room.base.commit, through: 99, room: room.id },
    parsed.state,
  );
  expect(rooms.ends("doc", staleThrough)).toBe(true);
  expect(rooms.ends("doc", beyondThrough)).toBe(true);
  expect(rooms.fileAccepted("doc", { bytes: staleThrough, etag: "e-bad" }).answer).toBe("outside");
});

// Bug it catches: admitPart did not verify frame.size stayed consistent across parts of one stage or
// cap frame.made, letting one client inflate rooms.used() far past liveBytes.
test("admitPart rejects mismatched part sizes and oversized made payloads", () => {
  const limits = labLimits();
  const { rooms, room } = opened({ limits, liveBytes: 28_000 });
  rooms.attach(room, "eve", "conn-eve");
  const p0 = {
    k: "part",
    gen: room.gen,
    of: "req",
    key: "stage-0",
    order: { c: "eve", p: 0 },
    i: 0,
    m: 3,
    size: 48,
    frame: { k: "req", c: "eve", n: 1, p: 0, b: room.epoch, e: "eve:1", action: { t: "paste", cells: [] }, saw: [] },
    cells: [["r1", "c1", "x"]],
    saw: ["a"],
  };
  const p1 = { ...p0, i: 1, size: limits.roomBytes, frame: null, cells: [["r1", "c2", "Y".repeat(5000)]], saw: [""] };
  expect(rooms.frame(room, "eve", p0).answer).toBe("staged");
  expect(rooms.frame(room, "eve", p1).answer).toBe("bad-size");
  expect(rooms.used()).toBeLessThanOrEqual(28_000);
});

// Bug it catches: un-established viewer slots counted against maxRooms and sweep() skipped them while
// SSE stayed open, letting passive viewers lock out real editors with 503.
test("passive viewer slots do not exhaust maxRooms and sweep evicts idle un-established slots", () => {
  let clock = 1000;
  const { rooms } = setup({ maxRooms: 2, now: () => clock, retainMs: 60_000 });
  const v1 = rooms.instance("doc1", "tiny");
  const v2 = rooms.instance("doc2", "tiny");
  const v3 = rooms.instance("doc3", "tiny");
  expect(v1 && v2 && v3).toBeTruthy();
  expect(rooms.size()).toBe(0);
  expect(rooms.used()).toBe(0);
  clock += 120_000;
  rooms.sweep(() => 1);
  expect(rooms.instance("doc1", "tiny")).not.toBe(v1);
});

// Bug it catches: re-attaching the same conn to the same room under a new clientId overwrote the old
// clientId without dropping its staged parts or parked requests, leaking bytes after leave().
test("re-attaching the same connection under a new clientId frees the previous clientId's staged bytes", () => {
  const { rooms, room } = opened();
  const baseline = rooms.used();
  rooms.attach(room, "ana", "conn-1");
  const [first] = parts(room, "ana", 1, paste(6));
  expect(rooms.frame(room, "ana", first).answer).toBe("staged");
  expect(room.bytes.staged).toBeGreaterThan(0);

  rooms.attach(room, "ben", "conn-1");
  expect(room.bytes.staged).toBe(0);
  rooms.leave(room, "conn-1");
  expect(rooms.used()).toBe(baseline);
});

// Bug it catches: establish() on an open dirty room overwrote the room from stale disk bytes,
// silently destroying unsaved admitted edits (X1 round 5 #2).
test("establish() carries unsaved admitted edits when the open room is dirty and refuses stale-generation bytes", () => {
  const { rooms, room, bytes } = opened();
  rooms.attach(room, "ana", "conn-ana");
  const admitted = rooms.submit(room, set("r1", "c1", "CRITICAL_PATCH"));
  expect(admitted.answer).toBe("ok");

  // Stale bytes from an earlier generation are refused while the open room is dirty.
  expect(rooms.establish("doc", { bytes: serialize(RECORD, START), etag: "e0", codec: "tiny" })).toBeNull();

  // Same-generation establish carries the dirty tail into the new generation and records lineage through room.seq.
  const next = rooms.establish("doc", { bytes, etag: "e1", codec: "tiny" });
  expect(next).not.toBeNull();
  useCodec(tiny);
  const parsed = parse(next.bytes);
  expect(parsed.state.wb.rows.r1.cells.c1).toBe("CRITICAL_PATCH");
  expect(parsed.state.lineage[0]).toEqual([room.gen, admitted.seq]);
  expect(rooms.fileAccepted("doc", { bytes: next.bytes, etag: "e2" }).answer).toBe("establishing");
  expect(rooms.get("doc").state.wb.rows.r1.cells.c1).toBe("CRITICAL_PATCH");
});

// Bug it catches: establish() and outsideWrite() hardcoded calc=false even when recalculate:true,
// stamping <table grid stale> on clean sheets and leaving dependent formulas stale (X1 round 5 #4).
test("establish() and outsideWrite() honor recalculate: true without stamping stale on clean sheets", async () => {
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  const gridPlugin = (await import("../../../src/vendor/sap-grid.vendor.js")).default;
  if (!Sap.grid) Sap.use(gridPlugin);
  const sheetCodec = Sap.grid.roomCodec;
  const cleanHtml =
    `<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2>` +
    `<table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>` +
    `<tbody><tr data-id="r1" data-pos="V"><td n v="5">5</td><td n f="=A1*2">10</td></tr></tbody></table></section>` +
    `<script type="application/json" sheet-commit>{"rev":1}</script>`;

  const rooms = createOrderedRooms({ codecs: { sheet: sheetCodec }, recalculate: true });
  const est = rooms.establish("doc", { bytes: cleanHtml, etag: '"e0"', codec: "sheet" });
  expect(est.bytes).not.toMatch(/<table\b[^>]*\bstale\b/i);
  rooms.open("doc", { bytes: est.bytes, etag: '"e1"' });

  const { doc, record } = sheetCodec.read(est.bytes);
  sheetCodec.apply(doc, { v: 1, t: "set", sheet: "s1", cells: [["r1", "c1", 50]] });
  const incoming = sheetCodec.write(doc, record);
  const step = rooms.outsideWrite("doc", { bytes: incoming, current: est.bytes, codec: "sheet" });
  expect(step.same).toBe(false);
  expect(step.bytes).toMatch(/f="=A1\*2">100<\/td>|v="100"/);
  expect(step.bytes).not.toMatch(/<table\b[^>]*\bstale\b/i);
});
