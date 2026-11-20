/**
 * @jest-environment node
 */
// Two headless room clients against the reference host: every edit is kept through lost
// answers, refused saves, moved ETags and a generation change. The htmlclay and hyperclay lanes
// start when this file passes in the shared clayjs checkout.
import { createReferenceHost } from "../../live-room/host/reference-host.mjs";
import { createRoomClient } from "../../../src/live-room/room-client.js";
import { serialize, parse } from "../../../src/live-room/core/record.js";
import { useCodec } from "../../../src/live-room/core/codec.js";
import { labLimits } from "../../../src/live-room/core/limits.js";
import { codec as tiny } from "../../live-room/lab/codec-tiny/reducer.mjs";

const RECORD = { v: 2, doc: "doc0123456789abc", gen: "0.00000000", epoch: 0, commit: "c00000000000", parent: null, through: 0 };
const START = { wb: { rows: { r1: { pos: "1", cells: { c1: "a" } }, r2: { pos: "2", cells: {} } } }, seen: {}, lineage: [], cut: null, floor: -1 };
const set = (row, col, value) => ({ t: "set", row, col, value });

const open = [];
async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("the condition did not hold in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
afterEach(() => Promise.all(open.splice(0).map((one) => one.close())));

function world() {
  let ids = 0;
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits(), newId: () => 1000 * ++ids } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  const clients = [];
  const join = (clientId) => {
    const client = createRoomClient({ page: "doc", codec: tiny, clientId, fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), firstId: 10_000 * (clients.length + 1), idleMs: 5, maxMs: 20, waitMs: 20 });
    clients.push(client);
    open.push(client);
    return client;
  };
  const cell = (row, col) => {
    useCodec(tiny);
    return parse(host.file("doc").bytes).state.wb.rows[row]?.cells[col];
  };
  const saves = () => host.versions("doc").filter((one) => one.kind === "save").length;
  return { host, join, cell, saves, close: () => Promise.all(clients.map((one) => one.close())) };
}

test("an edit in one tab reaches the other tab and is saved in the file", async () => {
  const w = world();
  const ana = w.join("ana");
  const ben = w.join("ben");
  await Promise.all([ana.ready, ben.ready]);
  const typed = ana.submit(set("r1", "c1", "ana"));
  await expect(typed.admitted).resolves.toBe("shared");
  expect(await ana.flush()).toEqual({ [typed.id]: "saved" });
  expect(w.cell("r1", "c1")).toBe("ana");
  await until(() => ben.view().rows.r1.cells.c1 === "ana");
  await w.close();
});

const isSave = (request) => request.method === "POST" && request.url.includes("/_/save");
const isFrames = (request) => request.method === "POST" && request.url.includes("/_/sync/room") && !request.url.includes("op=");

// Bug it catches: a client that sends a save again after its answer was lost (the second copy
// would be refused or, without If-Match, overwrite a peer's commit).
test("a save whose answer was lost is settled from the file, not sent again", async () => {
  const w = world();
  const ana = w.join("ana");
  await ana.ready;
  w.host.fault("lose", isSave);
  const typed = ana.submit(set("r1", "c1", "ana"));
  expect(await ana.flush()).toEqual({ [typed.id]: "saved" });
  expect(w.cell("r1", "c1")).toBe("ana");
  expect(w.saves()).toBe(1);
  const next = ana.submit(set("r2", "c1", "next"));
  expect(await ana.flush()).toEqual({ [typed.id]: "saved", [next.id]: "saved" });
  expect(w.cell("r2", "c1")).toBe("next");
  await w.close();
});

// Bug it catches: a refused save that is repeated as it was, or that drops the edit.
test("a save refused because the ETag moved is not repeated: the tab reads the file and saves again from it, keeping the edit", async () => {
  const w = world();
  const ana = w.join("ana");
  await ana.ready;
  w.host.fault("move", isSave);
  const typed = ana.submit(set("r2", "c1", "kept"));
  expect(await ana.flush()).toEqual({ [typed.id]: "saved" });
  expect(w.cell("r2", "c1")).toBe("kept");
  await w.close();
});

// Bug it catches: a client that forgets frames it posted when the request fails.
test("a frame dropped on its way is sent again when the wait runs out", async () => {
  const w = world();
  const ana = w.join("ana");
  await ana.ready;
  for (let i = 0; i < 3; i++) w.host.fault("drop", isFrames);
  const typed = ana.submit(set("r1", "c1", "again"));
  await expect(typed.admitted).resolves.toBe("shared");
  expect(await ana.flush()).toEqual({ [typed.id]: "saved" });
  expect(w.cell("r1", "c1")).toBe("again");
  await w.close();
});

// Bug it catches: edits admitted to the old generation are lost when an agent's write moves the
// document to a new one.
test("an agent's write through the host step keeps the tab's edits and the agent's cell", async () => {
  const w = world();
  const ana = w.join("ana");
  await ana.ready;
  const typed = ana.submit(set("r1", "c1", "before"));
  await typed.admitted;
  useCodec(tiny);
  const { record, state } = parse(w.host.file("doc").bytes);
  state.wb.rows.r2.cells.c2 = "agent";
  await w.host.outside("doc", serialize(record, state), "agent");
  const later = ana.submit(set("r2", "c1", "after"));
  const settled = await ana.flush();
  expect(settled).toEqual({ [typed.id]: "recovered", [later.id]: "saved" });
  expect(w.cell("r2", "c2")).toBe("agent");
  expect(w.cell("r2", "c1")).toBe("after");
  useCodec(tiny);
  expect(parse(w.host.versions("doc").find((one) => one.kind === "backup").bytes).state.wb.rows.r1.cells.c1).toBe("before");
  await w.close();
});

// Bug it catches: two tabs saving at once, where the second save overwrites the first.
test("two tabs typing at once both end up in the file", async () => {
  const w = world();
  const ana = w.join("ana");
  const ben = w.join("ben");
  await Promise.all([ana.ready, ben.ready]);
  const a = ana.submit(set("r1", "c1", "ana"));
  const b = ben.submit(set("r2", "c1", "ben"));
  const [fa, fb] = await Promise.all([ana.flush(), ben.flush()]);
  expect([fa[a.id], fb[b.id]]).toEqual(["saved", "saved"]);
  expect([w.cell("r1", "c1"), w.cell("r2", "c1")]).toEqual(["ana", "ben"]);
  await w.close();
});

// Bug it catches: a tab that missed room events which a save then trimmed reads holes in its room
// copy and stops for good, so its later edits never leave it.
test("a tab that missed frames a save trimmed catches up from the file and its next edit saves", async () => {
  const w = world();
  let deaf = false;
  const subscribe = (page, clientId, listener) => w.host.subscribe(page, clientId, (event) => (deaf ? undefined : listener(event)));
  const ana = w.join("ana");
  const ben = createRoomClient({ page: "doc", codec: tiny, clientId: "ben", fetch: w.host.fetch, subscribe, limits: labLimits(), firstId: 90_000, idleMs: 5, maxMs: 20, waitMs: 20 });
  open.push(ben);
  await Promise.all([ana.ready, ben.ready]);
  deaf = true;
  for (let i = 0; i < 4; i++) ana.submit(set("r1", "c1", `ana${i}`));
  await ana.flush();
  deaf = false;
  const typed = ben.submit(set("r2", "c1", "ben"));
  expect(await ben.flush()).toEqual({ [typed.id]: "saved" });
  expect(ben.status.error).toBeNull();
  expect([w.cell("r1", "c1"), w.cell("r2", "c1")]).toEqual(["ana3", "ben"]);
});

// Bug it catches: a refused establish followed by another at once, flooding a host that cannot
// hold the room with thousands of requests a second.
test("a host that cannot hold the room gets at most one establish per wait", async () => {
  let ids = 0;
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits(), newId: () => 1000 * ++ids } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  let asks = 0;
  // Past 50 asks the answer never comes, so a flood ends instead of starving the timers.
  const fetch = (url, init) => {
    if (!String(url).includes("op=establish")) return host.fetch(url, init);
    if (++asks > 50) return new Promise(() => {});
    return Promise.resolve(new Response(JSON.stringify({ error: "the host cannot hold this room now" }), { status: 503 }));
  };
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch, subscribe: host.subscribe, limits: labLimits(), firstId: 10_000, idleMs: 5, maxMs: 20, waitMs: 20 });
  open.push(ana);
  await ana.ready;
  ana.submit(set("r1", "c1", "ana"));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(asks).toBeGreaterThan(0);
  expect(asks).toBeLessThanOrEqual(7);
});

// Bug it catches: opening a sheet to read it writes a new generation into the file.
test("a tab that only looks changes nothing, and sees a coworker's edit once the coworker's first edit opens the room", async () => {
  const w = world();
  const before = w.host.file("doc").etag;
  const ana = w.join("ana");
  const ben = w.join("ben");
  await Promise.all([ana.ready, ben.ready]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(w.host.file("doc").etag).toBe(before);
  const typed = ben.submit(set("r2", "c1", "ben"));
  expect(await ben.flush()).toEqual({ [typed.id]: "saved" });
  await until(() => ana.view().rows.r2.cells.c1 === "ben");
});

// Bug it catches: flush waits out the idle pause (seconds by default) before it saves.
test("flush saves at once instead of waiting for the idle pause", async () => {
  const w = world();
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: w.host.fetch, subscribe: w.host.subscribe, limits: labLimits(), firstId: 10_000, idleMs: 60_000, maxMs: 120_000, waitMs: 20 });
  open.push(ana);
  await ana.ready;
  const typed = ana.submit(set("r1", "c1", "now"));
  expect(await ana.flush()).toEqual({ [typed.id]: "saved" });
  expect(w.cell("r1", "c1")).toBe("now");
}, 3000);
