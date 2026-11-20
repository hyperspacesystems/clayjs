/**
 * @jest-environment node
 */
// The reference host (tests/live-room/host/reference-host.mjs) is what the host lanes copy.
// These tests drive it through its routes the way a room client does.
import { createReferenceHost } from "../../live-room/host/reference-host.mjs";
import { serialize, parse } from "../../../src/live-room/core/record.js";
import { useCodec } from "../../../src/live-room/core/codec.js";
import { labLimits } from "../../../src/live-room/core/limits.js";
import { codec as tiny } from "../../live-room/lab/codec-tiny/reducer.mjs";

const RECORD = { v: 2, doc: "doc0123456789abc", gen: "0.00000000", epoch: 0, commit: "c00000000000", parent: null, through: 0 };
const START = { wb: { rows: { r1: { pos: "1", cells: { c1: "a" } }, r2: { pos: "2", cells: {} } } }, seen: {}, lineage: [], cut: null, floor: -1 };
const set = (row, col, value) => ({ t: "set", row, col, value });

function hosted(options = {}) {
  let ids = 0;
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits(), newId: () => 1000 * ++ids }, ...options });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  return host;
}

const call = async (host, path, init) => {
  const answer = await host.fetch(path, init);
  return { status: answer.status, etag: answer.headers.get("etag"), body: answer.headers.get("content-type")?.includes("json") ? await answer.json() : await answer.text() };
};

async function opened(host) {
  const { etag } = host.file("doc");
  const made = await call(host, "/_/sync/room?page=doc&op=establish", { method: "POST", headers: { "if-match": etag } });
  expect(made.status).toBe(200);
  return host.rooms.get("doc");
}

function request(room, c, n, action) {
  return { k: "req", gen: room.gen, c, n, p: n - 1, b: room.epoch, e: `${c}:${n}`, action, saw: tiny.seen(room.state.wb, action) };
}

function savedOf(room, bytes) {
  useCodec(tiny);
  const { record, state } = parse(bytes);
  return serialize({ ...record, commit: "c99999999990", parent: room.base.commit, through: room.seq }, { ...state, wb: structuredClone(room.state.wb), seen: structuredClone(room.state.seen) });
}

test("a client joins, the host writes the establishing commit before it opens the room, admits frames and broadcasts its own receipt after a save", async () => {
  const host = hosted();
  const before = await call(host, "/_/sync/room?page=doc&client-id=ana");
  expect(before.body).toEqual(expect.objectContaining({ gen: null, tail: [] }));
  const room = await opened(host);
  expect(parse(host.file("doc").bytes).record).toEqual(expect.objectContaining({ gen: room.gen, room: before.body.id }));
  const heard = [];
  host.subscribe("doc", "ana", (event) => heard.push(event));
  const join = await call(host, "/_/sync/room?page=doc&client-id=ana");
  expect(join.body).toEqual(expect.objectContaining({ id: room.id, gen: room.gen, tail: [] }));
  const sent = await call(host, "/_/sync/room?page=doc&client-id=ana", { method: "POST", body: JSON.stringify({ frames: [request(room, "ana", 1, set("r1", "c1", "ana"))] }) });
  expect(sent.body.answers).toEqual(["ok"]);
  expect(heard).toEqual([{ type: "room", gen: room.gen, at: 0, frame: expect.objectContaining({ k: "act", seq: 1, c: "ana" }) }]);
  const { bytes, etag } = host.file("doc");
  const save = await call(host, "/_/save?page=doc", { method: "POST", headers: { "if-match": etag }, body: savedOf(room, bytes) });
  expect(save.status).toBe(200);
  expect(heard.at(-1)).toEqual({ type: "room", gen: room.gen, at: 1, frame: expect.objectContaining({ k: "receipt", through: 1, etag: save.body.etag }) });
});

test("a save on a moved ETag is refused with the current ETag and changes nothing", async () => {
  const host = hosted();
  const room = await opened(host);
  const { bytes } = host.file("doc");
  const refused = await call(host, "/_/save?page=doc", { method: "POST", headers: { "if-match": '"e0"' }, body: savedOf(room, bytes) });
  expect(refused).toEqual(expect.objectContaining({ status: 412, body: { etag: host.file("doc").etag } }));
  expect(host.file("doc").bytes).toBe(bytes);
});

test("an agent's write goes through the outside write step: the dirty room is backed up, the tabs are told of the new file, and the room reopens on it", async () => {
  const host = hosted();
  const room = await opened(host);
  const heard = [];
  host.subscribe("doc", "ana", (event) => heard.push(event));
  await call(host, "/_/sync/room?page=doc&client-id=ana", { method: "POST", body: JSON.stringify({ frames: [request(room, "ana", 1, set("r1", "c1", "ana"))] }) });
  useCodec(tiny);
  const { record, state } = parse(host.file("doc").bytes);
  state.wb.rows.r2.cells.c2 = "agent";
  const written = await host.outside("doc", serialize(record, state), "agent");
  expect(written.backup).toBe(true);
  expect(parse(host.versions("doc").find((one) => one.kind === "backup").bytes).state.wb.rows.r1.cells.c1).toBe("ana");
  expect(heard.at(-1)).toEqual({ type: "file", etag: written.etag });
  const now = parse(host.file("doc").bytes);
  expect(host.rooms.get("doc").gen).toBe(now.record.gen);
  expect(now.state.wb.rows.r2.cells.c2).toBe("agent");
});

test("when the last client leaves a dirty room the host makes its own commit of everything admitted", async () => {
  const host = hosted();
  const room = await opened(host);
  const leave = host.subscribe("doc", "ana", () => {});
  await call(host, "/_/sync/room?page=doc&client-id=ana");
  await call(host, "/_/sync/room?page=doc&client-id=ana", { method: "POST", body: JSON.stringify({ frames: [request(room, "ana", 1, set("r2", "c1", "kept"))] }) });
  await leave();
  useCodec(tiny);
  const file = parse(host.file("doc").bytes);
  expect(file.record).toEqual(expect.objectContaining({ gen: room.gen, through: 1 }));
  expect(file.state.wb.rows.r2.cells.c1).toBe("kept");
  expect(host.versions("doc").at(-1).kind).toBe("final");
});

test("a frame delivered twice is admitted once, and a frame whose answer was lost is in the room", async () => {
  const host = hosted();
  const room = await opened(host);
  const frame = request(room, "ana", 1, set("r1", "c1", "ana"));
  host.fault("twice", (one) => one.method === "POST" && one.url.includes("/_/sync/room"));
  const doubled = await call(host, "/_/sync/room?page=doc&client-id=ana", { method: "POST", body: JSON.stringify({ frames: [frame] }) });
  expect(doubled.body.answers).toEqual(["dup"]);
  expect(room.seq).toBe(1);
  host.fault("lose", (one) => one.method === "POST");
  await expect(host.fetch("/_/sync/room?page=doc&client-id=ana", { method: "POST", body: JSON.stringify({ frames: [request(room, "ana", 2, set("r2", "c1", "two"))] }) })).rejects.toThrow("answer was lost");
  expect(room.seq).toBe(2);
});

test("a host with no room announces the file contract and answers no room routes", async () => {
  const host = hosted({ room: false });
  expect((await call(host, "/_/announce")).body).toEqual({ extensions: ["ordered-file"] });
  expect((await call(host, "/_/sync/room?page=doc&client-id=ana")).status).toBe(404);
});

// Bug it catches: a tab from before the room opened saves with a matching ETag, and the host's
// fileAccepted ends the room, dropping what it admitted since the last commit.
test("a browser save that is not the room's next commit is refused and the room keeps its edits", async () => {
  const host = hosted();
  const room = await opened(host);
  await call(host, "/_/sync/room?page=doc&client-id=ana", { method: "POST", body: JSON.stringify({ frames: [request(room, "ana", 1, set("r2", "c1", "shared"))] }) });
  useCodec(tiny);
  const { bytes, etag } = host.file("doc");
  const old = parse(bytes);
  const stale = serialize({ ...RECORD, commit: "c00000000077", parent: RECORD.commit }, old.state);
  const refused = await call(host, "/_/save?page=doc", { method: "POST", headers: { "if-match": etag }, body: stale });
  expect(refused.status).toBe(409);
  expect(host.rooms.get("doc")).toBe(room);
  expect(room.state.wb.rows.r2.cells.c1).toBe("shared");
});

// Bug it catches: a tab closes with a frame on the way; the frame lands after the last stream
// closed, and the room holds it with nobody left to save it.
test("a frame that lands after the last stream closed is saved by the host", async () => {
  const host = hosted();
  const room = await opened(host);
  const leave = host.subscribe("doc", "ana", () => {});
  await call(host, "/_/sync/room?page=doc&client-id=ana");
  await leave();
  await call(host, "/_/sync/room?page=doc&client-id=ana", { method: "POST", body: JSON.stringify({ frames: [request(room, "ana", 1, set("r2", "c1", "late"))] }) });
  useCodec(tiny);
  expect(parse(host.file("doc").bytes).state.wb.rows.r2.cells.c1).toBe("late");
});

// Bug it catches: a reconnect opens the new stream before the old one closes, and closing the old
// one removes the new listener, so the tab hears nothing more.
test("closing an old stream after a reconnect keeps the new stream", async () => {
  const host = hosted();
  const room = await opened(host);
  const closeOld = host.subscribe("doc", "ana", () => {});
  const heard = [];
  host.subscribe("doc", "ana", (event) => heard.push(event));
  await closeOld();
  await call(host, "/_/sync/room?page=doc&client-id=ana");
  await call(host, "/_/sync/room?page=doc&client-id=ana", { method: "POST", body: JSON.stringify({ frames: [request(room, "ana", 1, set("r2", "c1", "heard"))] }) });
  expect(heard.at(-1)).toEqual(expect.objectContaining({ type: "room", frame: expect.objectContaining({ k: "act" }) }));
});
