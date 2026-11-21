/**
 * @jest-environment node
 */
// Recovery copies on the host and restore jobs (plan 09 sections 1.12, 2.8, 3.2 and 3.4): a tab
// whose edits the protocol moves to a recovery copy stores it, reads it back, and restores it by
// itself; a person decides each conflict. Headless, against the reference host.
import { createReferenceHost } from "../../live-room/host/reference-host.mjs";
import { createRoomClient } from "../../../src/live-room/room-client.js";
import { serialize, parse, parsePage } from "../../../src/live-room/core/record.js";
import { useCodec } from "../../../src/live-room/core/codec.js";
import { labLimits } from "../../../src/live-room/core/limits.js";
import { codec as tiny } from "../../live-room/lab/codec-tiny/reducer.mjs";

const RECORD = { v: 2, doc: "doc0123456789abc", gen: "0.00000000", epoch: 0, commit: "c00000000000", parent: null, through: 0 };
const START = { wb: { rows: { r1: { pos: "1", cells: { c1: "a" } }, r2: { pos: "2", cells: {} } } }, seen: {}, lineage: [], cut: null, floor: -1 };
const set = (row, col, value) => ({ t: "set", row, col, value });
const CLOSING = ["kept", "saved", "taken", "misfit"];

const open = [];
async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("the condition did not hold in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function untilDone(work, check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await work();
    if (check(value)) return value;
    if (Date.now() > end) throw new Error("the condition did not hold in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
afterEach(() => Promise.all(open.splice(0).map((one) => one.close())));

// A person saving: the tabs that strand an edit do not save on their own (their idle pause is a
// minute), and a restore job is finished only by a save that holds its edits.
const saving = (client, work) => async () => (await client.flush(), work());

const isCopy = (request) => new URL(request.url).pathname.startsWith("/_/copies");
const isCopyWrite = (request) => request.method === "PUT" && isCopy(request);
const isCopyRead = (request) => request.method === "GET" && new URL(request.url).pathname.startsWith("/_/copies/");
const isFrame = (request) => request.method === "POST" && new URL(request.url).pathname === "/_/sync/room" && !new URL(request.url).searchParams.has("op");

// The host's faults are one-shot; these hold every matching request or cut every matching answer
// while the flag is set.
const gated = (host, matches, flag) => (url, init = {}) => {
  if (flag() && matches(new Request(new URL(url, "http://host.test"), init))) return Promise.reject(new TypeError("fetch failed: the request was dropped"));
  return host.fetch(url, init);
};
const clipped = (host, matches, flag) => async (url, init = {}) => {
  const answer = await host.fetch(url, init);
  if (!flag() || !matches(new Request(new URL(url, "http://host.test"), init))) return answer;
  return new Response((await answer.text()).slice(0, -40), { status: answer.status, headers: answer.headers });
};

function world() {
  let ids = 0;
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits(), newId: () => 1000 * ++ids } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  const clients = [];
  const join = (clientId, options = {}) => {
    const client = createRoomClient({ page: "doc", codec: tiny, clientId, fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), firstId: 10_000 * (clients.length + 1), idleMs: 5, maxMs: 20, waitMs: 50, ...options });
    clients.push(client);
    open.push(client);
    return client;
  };
  const cell = (row, col) => {
    useCodec(tiny);
    return parse(host.file("doc").bytes).state.wb.rows[row]?.cells[col];
  };
  const copies = async () => (await (await host.fetch("/_/copies?page=doc")).json()).copies;
  const copyEdits = async (id) => {
    useCodec(tiny);
    return parsePage(await (await host.fetch(`/_/copies/${id}?page=doc`)).text()).record.edits.map((one) => one.e);
  };
  const ledger = (client) => {
    useCodec(tiny);
    return parse(host.file("doc").bytes).state.seen[client] ?? null;
  };
  return { host, join, cell, copies, copyEdits, ledger, close: () => Promise.all(clients.map((one) => one.close())) };
}

// The lab's `copied()` scenario: Ana's edit is in the room and not saved, the room is lost, and a
// version of the document is put back, so the edit has no backup version to be recovered from. A
// program's write first gives the version restore a document to change: the reference host makes
// the establishing bytes itself, so a restore of the same tables is answered "same" and writes
// nothing, and the tab would hand its edit to the next generation instead.
async function strand(w, ana, { admitted } = {}) {
  const base = w.host.file("doc").bytes;
  useCodec(tiny);
  const { record, state } = parse(base);
  state.wb.rows.r2.cells.c1 = "agent";
  await w.host.outside("doc", serialize(record, state), "agent");
  const typed = ana.submit(set("r1", "c1", "mine"));
  await expect(typed.admitted).resolves.toBe("shared");
  admitted?.();
  w.host.loseRoom("doc");
  await w.host.outside("doc", base, "restore");
  return typed;
}

// Bug it catches: a store that keeps recovery copies in the tab's own memory (a reload loses them)
// and never reads them back, and a client that stores a copy but never restores it.
test("a stranded edit is stored on the host, read back, and restored by itself", async () => {
  const w = world();
  const ana = w.join("ana", { idleMs: 60_000, maxMs: 120_000 });
  await ana.ready;
  await strand(w, ana);
  await until(() => ana.status.copies === 1);
  const listed = await w.copies();
  expect(listed).toHaveLength(1);
  expect(await w.copyEdits(listed[0].id)).toEqual(["ana:1"]);
  await untilDone(saving(ana, () => w.cell("r1", "c1")), (cell) => cell === "mine");
  const restored = ana.notices().filter((one) => one.kind === "restored");
  expect(restored).toHaveLength(1);
  expect([...restored[0].applied, ...restored[0].saved]).toContain("ana:1");
  await w.close();
});

// Bug it catches: a store that keeps the bytes it sent and calls the copy stored without reading
// them back, so a host that answered with a page cut short counts as holding the edit.
test("a read back that does not match is not stored", async () => {
  const w = world();
  // A read back that answers with a page cut short, for as long as `torn` is set.
  let torn = true;
  const fetch = clipped(w.host, isCopyRead, () => torn);
  const ana = w.join("ana", { idleMs: 60_000, maxMs: 120_000, fetch });
  await ana.ready;
  let settled = null;
  const reported = [];
  ana.subscribe(() => reported.push(ana.status.unstored));
  const typed = await strand(w, ana);
  typed.durable.then((state) => (settled = state));
  await until(() => reported.includes(1));
  await untilDone(() => w.copies(), (list) => list.length === 1);
  expect(ana.status.copies).toBe(0);
  expect(settled).toBeNull();
  torn = false;
  await until(() => ana.status.copies === 1);
  expect(await w.copies()).toHaveLength(1);
  await w.close();
});

// Bug it catches: a store that treats a lost answer as a failed write and stores the copy again
// under another id, so the document ends up with two copies of the same edits.
test("a lost answer to the write is not a second copy", async () => {
  const w = world();
  const ana = w.join("ana", { idleMs: 60_000, maxMs: 120_000 });
  await ana.ready;
  w.host.fault("lose", isCopyWrite);
  await strand(w, ana);
  await until(() => ana.status.copies === 1);
  expect(await w.copies()).toHaveLength(1);
  await w.close();
});

// Bug it catches: a client that calls a stranded edit recovered on a host that cannot store copies,
// so the edit is gone from the tab as well as from the file.
test("a host without recovery-copies keeps the edit in the tab", async () => {
  const w = world();
  let asked = 0;
  const fetch = (url, init) => {
    if (String(url).includes("/_/copies")) asked++;
    return w.host.fetch(url, init);
  };
  const ana = w.join("ana", { idleMs: 60_000, maxMs: 120_000, copies: false, fetch });
  await ana.ready;
  const typed = await strand(w, ana);
  let settled = null;
  typed.durable.then((state) => (settled = state));
  await until(() => ana.status.unstored === 1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(settled).toBeNull();
  expect(ana.status.copies).toBe(0);
  expect(asked).toBe(0);
  await w.close();
});

// Bug it catches: a restore job that writes the copy's value over a cell a coworker changed since
// the edit was made, instead of leaving the conflict for a person.
test("a conflict waits for a person, and keep current changes no cell", async () => {
  const w = world();
  let blocked = true;
  const fetch = gated(w.host, isCopyWrite, () => blocked);
  const ana = w.join("ana", { idleMs: 60_000, maxMs: 120_000, fetch });
  await ana.ready;
  await strand(w, ana);
  const ben = w.join("ben");
  await ben.ready;
  const theirs = ben.submit(set("r1", "c1", "ben"));
  expect(await ben.flush()).toEqual({ [theirs.id]: "saved" });
  blocked = false;
  const conflicted = () => ana.notices().find((one) => one.kind === "restored" && one.conflicts.length > 0);
  const notice = await untilDone(saving(ana, conflicted), Boolean);
  expect(notice.conflicts.map((one) => one.e)).toEqual(["ana:1"]);
  await expect(ana.decide(notice.job, [["ana:1", "keep"]])).resolves.toBe(true);
  await untilDone(saving(ana, () => ana.notices().filter((one) => one.kind === "restored").length), (count) => count === 2);
  const booked = (list) => list.some((one) => one.done.some((mark) => mark.e === "ana:1" && CLOSING.includes(mark.kind)));
  await untilDone(() => w.copies(), booked);
  expect(booked(await w.copies())).toBe(true);
  expect(w.cell("r1", "c1")).toBe("ben");
  expect(w.ledger("ana")[0]).toBeGreaterThanOrEqual(1);
  await w.close();
}, 15_000);

// Bug it catches: a "take copy" decision that is dropped, or that writes the copy's value even
// when the person had not seen the cell it lands on.
test('"take copy" applies the stored value when nobody changed the cell since the person looked', async () => {
  const w = world();
  let blocked = true;
  const fetch = gated(w.host, isCopyWrite, () => blocked);
  const ana = w.join("ana", { idleMs: 60_000, maxMs: 120_000, fetch });
  await ana.ready;
  await strand(w, ana);
  const ben = w.join("ben");
  await ben.ready;
  const theirs = ben.submit(set("r1", "c1", "ben"));
  expect(await ben.flush()).toEqual({ [theirs.id]: "saved" });
  blocked = false;
  const conflicted = () => ana.notices().find((one) => one.kind === "restored" && one.conflicts.length > 0);
  const notice = await untilDone(saving(ana, conflicted), Boolean);
  await expect(ana.decide(notice.job, [["ana:1", "take"]])).resolves.toBe(true);
  await untilDone(saving(ana, () => w.cell("r1", "c1")), (cell) => cell === "mine");
  const booked = (list) => list.some((one) => one.done.some((mark) => mark.e === "ana:1" && CLOSING.includes(mark.kind)));
  await untilDone(() => w.copies(), booked);
  expect(booked(await w.copies())).toBe(true);
  await w.close();
}, 15_000);

// Bug it catches: a tab with no edits keeps its establish held, so a person's restore of another
// tab's stored copy never reaches the room.
test("another tab lists a stored copy, and a tab with no edits can restore it", async () => {
  const w = world();
  let blocked = false;
  const fetch = gated(w.host, isFrame, () => blocked);
  const ana = w.join("ana", { idleMs: 60_000, maxMs: 120_000, fetch });
  await ana.ready;
  await strand(w, ana, { admitted: () => (blocked = true) });
  await until(() => ana.status.copies === 1);
  expect(ana.notices().some((one) => one.kind === "restored")).toBe(false);
  await ana.close();
  blocked = false;
  w.host.loseRoom("doc");
  const [copy] = await w.copies();
  const cy = w.join("cy");
  await cy.ready;
  expect(cy.copies().map((one) => one.id)).toContain(copy.id);
  expect(cy.copies().find((one) => one.id === copy.id).edits.map((one) => one.e)).toEqual(["ana:1"]);
  await expect(cy.restore(copy.id)).resolves.toBe(true);
  await until(() => w.cell("r1", "c1") === "mine");
  await w.close();
});

// Bug it catches: the copies list read inside every refresh throws on a dropped request or a body
// cut short, which stops the tab's step after a save answer, so the tab never saves again.
test("a copies list that cannot be read does not stop the tab saving", async () => {
  const w = world();
  let saves = 0;
  let drop = false;
  const isList = (request) => request.method === "GET" && new URL(request.url).pathname === "/_/copies";
  const fetch = async (url, init = {}) => {
    if (drop && isList(new Request(new URL(url, "http://host.test"), init))) {
      drop = false;
      throw new TypeError("fetch failed: dropped");
    }
    const answer = await w.host.fetch(url, init);
    if (new URL(url, "http://host.test").pathname === "/_/save" && ++saves === 1) drop = true;
    return answer;
  };
  const ana = w.join("ana", { fetch });
  const errors = [];
  ana.subscribe((event) => event.type === "error" && errors.push(event.error));
  await ana.ready;
  await ana.submit(set("r1", "c1", "one")).durable;
  const two = ana.submit(set("r1", "c1", "two"));
  await untilDone(saving(ana, () => w.cell("r1", "c1")), (cell) => cell === "two");
  await expect(two.durable).resolves.toBe("saved");
  expect(errors).toEqual([]);
  await w.close();
});

// Bug it catches: a store that retries a copy the host refused as too big, uploading the whole
// copy again every pause for as long as the tab stays open.
test("a copy the host refuses as too big is not uploaded again", async () => {
  const w = world();
  let puts = 0;
  const fetch = async (url, init = {}) => {
    if (isCopyWrite(new Request(new URL(url, "http://host.test"), init))) {
      puts++;
      return new Response(JSON.stringify({ error: "too-big" }), { status: 413, headers: { "content-type": "application/json" } });
    }
    return w.host.fetch(url, init);
  };
  const ana = w.join("ana", { idleMs: 60_000, maxMs: 120_000, fetch });
  await ana.ready;
  await strand(w, ana);
  await until(() => puts === 1);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(puts).toBe(1);
  expect(ana.status.copies).toBe(0);
  expect(ana.status.unstored).toBeGreaterThan(0);
  await w.close();
});

// Bug it catches: a tab that never reads the host's decision marks after it opened: a coworker's
// restore job marks this tab's edit "open" (a conflict waiting for a person), the edit comes back
// in an adopt frame, and the tab, judging it with no mark, settles it as dropped and tells the
// person it was refused.
test("an edit a coworker's job left open is not reported refused to its author", async () => {
  const w = world();
  let anaHeld = false;
  let danaHeld = false;
  const ana = w.join("ana", { idleMs: 60_000, maxMs: 120_000, fetch: gated(w.host, isFrame, () => anaHeld) });
  const dana = w.join("dana", { idleMs: 60_000, maxMs: 120_000, fetch: gated(w.host, isFrame, () => danaHeld) });
  await Promise.all([ana.ready, dana.ready]);
  const base = w.host.file("doc").bytes;
  useCodec(tiny);
  const { record, state } = parse(base);
  state.wb.rows.r2.cells.c2 = "prep";
  await w.host.outside("doc", serialize(record, state), "agent");
  await ana.submit(set("r1", "c1", "ana1")).admitted;
  await until(() => dana.view().rows.r1.cells.c1 === "ana1");
  w.host.loseRoom("doc");
  await w.host.outside("doc", base, "restore");
  await until(() => ana.status.copies >= 1);
  await until(() => dana.view().rows.r1.cells.c1 === "ana1");
  anaHeld = true;
  danaHeld = true;
  w.host.loseRoom("doc");
  const tom = w.join("tom", { idleMs: 60_000, maxMs: 120_000 });
  await tom.ready;
  await tom.submit(set("r1", "c1", "tom")).admitted;
  await new Promise((resolve) => setTimeout(resolve, 30));
  danaHeld = false;
  await untilDone(() => w.copies(), (list) => list.some((copy) => copy.done.some((mark) => mark.e === "ana:1" && mark.kind === "open")));
  await until(() => (w.host.rooms.get("doc")?.seq ?? 0) >= 2);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(ana.notices().filter((one) => one.kind === "refused" && one.edits.includes("ana:1"))).toEqual([]);
  await w.close();
});
