/**
 * @jest-environment node
 */
// clay.liveRoom's browser transport against the reference host behind a page server: the host
// keeps the region, the page server serves it inside a whole page stamped with its document ETag
// and takes saves of the whole page, as hyperclay and HTML Clay do. The stream is the bridge live
// sync feeds (stream-bridge.js), fed here the way live sync feeds it.
import { JSDOM } from "jsdom";
import { createReferenceHost } from "../../live-room/host/reference-host.mjs";
import { liveRoom, browserTransport } from "../../../src/live-room/browser.js";
import { streamOpened, streamClosed, streamEvent, streamMessage, hostFlush } from "../../../src/live/stream-bridge.js";
import { serialize, parse } from "../../../src/live-room/core/record.js";
import { useCodec } from "../../../src/live-room/core/codec.js";
import { labLimits } from "../../../src/live-room/core/limits.js";
import { findRegion } from "../../../src/live-room/region.js";
import { codec as tiny } from "../../live-room/lab/codec-tiny/reducer.mjs";

const RECORD = { v: 2, doc: "doc0123456789abc", gen: "0.00000000", epoch: 0, commit: "c00000000000", parent: null, through: 0 };
const START = { wb: { rows: { r1: { pos: "1", cells: { c1: "a" } }, r2: { pos: "2", cells: {} } } }, seen: {}, lineage: [], cut: null, floor: -1 };
const URL_OF_PAGE = "https://ana.example/sheet.html";
const set = (row, col, value) => ({ t: "set", row, col, value });
// The page as hyperclay serves it to its owner: stamped with the document ETag, and in an `apps`
// folder with a trial bar that the file does not hold (marked save-remove). Its head carries the
// calculator's stale mark, which a room save keeps (only a repaint of the computed values clears it).
const pageOf = (region, etag) => `<!DOCTYPE html><html lang="en" documentetag="${etag.replace(/"/g, "&quot;")}"><head><title>Budget</title><meta name="clay-stale" clay="no-save"></head><body><h1>Budget</h1><div sheet-workbook>${region}</div><script data-trial-bar save-remove>showTrialBar()</script></body></html>`;

// A browser's DOMParser, which the transport uses to drop served-only markup from a save.
globalThis.DOMParser = new JSDOM().window.DOMParser;

const open = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((one) => one.close()));
  streamClosed();
});

async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("the condition did not hold in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function hosted({ room = true } = {}) {
  let ids = 0;
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", room, rooms: { limits: labLimits(), newId: () => 1000 * ++ids } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  const saved = [];
  const seen = [];
  // The page server: the document is the page; the reference host holds its region.
  const fetch = async (url, init = {}) => {
    const target = new URL(url, URL_OF_PAGE);
    seen.push({ path: target.pathname, method: init.method ?? "GET", headers: init.headers ?? {} });
    if (target.href === URL_OF_PAGE) {
      const { bytes, etag } = host.file("doc");
      return new Response(pageOf(bytes, etag), { status: 200, headers: { "content-type": "text/html", etag: 'W/"served"' } });
    }
    const forwarded = new URL(`${target.pathname}${target.search}`, "http://host.test");
    forwarded.searchParams.set("page", "doc");
    const headers = { "if-match": init.headers?.["If-Match"] };
    if (target.pathname === "/_/save") {
      saved.push(init.body);
      return host.fetch(`/_/save?page=doc`, { method: "POST", headers, body: findRegion(init.body).inner });
    }
    return host.fetch(`${forwarded.pathname}${forwarded.search}`, { method: init.method, headers, body: init.body });
  };
  // Live sync's side of the stream: room events by name (hyperclay), and a change to the file as
  // HTML Clay's live lane tells it, an unnamed notification frame.
  let seq = 0;
  // A save of a sheet with a record is told as a bare stamp, `{ etag }` (HTML Clay, 2026-11-20).
  const notice = (event) => ({ type: "notification", msg: "The file changed on disk", seq: ++seq, data: { kind: "external-change", etag: event.etag } });
  const stamp = (event) => ({ etag: event.etag });
  const stream = (clientId, told = notice) => {
    streamOpened({ clientId, lane: "live" });
    return host.subscribe("doc", clientId, (event) => (event.type === "room" ? streamEvent("room", { gen: event.gen, at: event.at, frame: event.frame }) : streamMessage(told(event))));
  };
  const cell = (row, col) => {
    useCodec(tiny);
    return parse(host.file("doc").bytes).state.wb.rows[row]?.cells[col];
  };
  const join = (options = {}) => {
    const one = liveRoom("sheet", { codec: tiny, documentUrl: URL_OF_PAGE, fetch, onSaved: () => {}, discover: async () => ({ spec: 1, extensions: [room ? "ordered-room" : "ordered-file"] }), limits: labLimits(), idleMs: 5, maxMs: 20, waitMs: 20, firstId: 10_000, ...options });
    open.push(one);
    return one;
  };
  return { host, fetch, saved, seen, stream, stamp, cell, join };
}

// Bug it catches: a save that sends the region bytes alone (or the page the tab first loaded)
// instead of the whole page they belong to, so the host stores a page with no head or heading; a
// save that keeps the host's served-only trial bar, so every save adds one more to the file; a
// save marked as a background one, which a host's data loss guard never takes as its baseline; a
// save that drops the calculator's stale mark, so old computed values pass as current.
test("an edit saves the whole page with the new region and without served-only markup, through the host's save route as a person's save", async () => {
  const w = hosted();
  w.stream("ana");
  const ana = w.join();
  await ana.ready;
  expect(ana.status.mode).toBe("ordered");
  const typed = ana.submit(set("r1", "c1", "ana"));
  expect(await ana.flush()).toEqual({ [typed.id]: "saved" });
  expect(w.cell("r1", "c1")).toBe("ana");
  const page = w.saved.at(-1);
  expect(page).toMatch(/^<!DOCTYPE html><html lang="en" documentetag="[^"]*"><head><title>Budget<\/title><meta name="clay-stale" clay="no-save"><\/head><body><h1>Budget<\/h1><div sheet-workbook(="")?>/);
  expect(page).not.toContain("data-trial-bar");
  const save = w.seen.find((one) => one.path === "/_/save");
  expect(save.headers).toEqual(expect.objectContaining({ "Document-URL": URL_OF_PAGE, "If-Match": expect.stringMatching(/^"e\d+"$/), "Save-Trigger": "user" }));
  expect(w.seen.filter((one) => one.path === "/_/sync/room").every((one) => one.headers["Document-URL"] === URL_OF_PAGE)).toBe(true);
});

// Bug it catches: a tab that takes the served bytes' HTTP ETag (which the stamp changes) instead of
// the document ETag on <html>, so every save is refused for a moved file.
test("the document ETag comes from the page's documentetag, not the served bytes' ETag header", async () => {
  const w = hosted();
  w.stream("ana");
  const ana = w.join();
  await ana.ready;
  const typed = ana.submit(set("r2", "c1", "x"));
  expect(await ana.flush()).toEqual({ [typed.id]: "saved" });
  expect(w.seen.some((one) => one.headers["If-Match"] === 'W/"served"')).toBe(false);
});

// Bug it catches: room events on the live stream never reach the room client, so a coworker's
// edit shows only after the next file read.
test("a coworker's edit arrives as a room event on the live stream", async () => {
  const w = hosted();
  w.stream("ana");
  const ana = w.join({ idleMs: 60_000, maxMs: 120_000 });
  await ana.ready;
  const typed = ana.submit(set("r1", "c1", "first"));
  await ana.flush();
  expect(typed.id).toBeTruthy();
  const reads = () => w.seen.filter((one) => one.path === "/sheet.html").length;
  // The save's own answer can land after the room's receipt settled the edit; let it land first.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = reads();
  const room = w.host.rooms.get("doc");
  await w.host.fetch("/_/sync/room?page=doc&client-id=ben");
  await w.host.fetch("/_/sync/room?page=doc&client-id=ben", { method: "POST", body: JSON.stringify({ frames: [{ k: "req", gen: room.gen, c: "ben", n: 1, p: 0, b: room.epoch, e: "ben:1", action: set("r2", "c2", "ben"), saw: tiny.seen(room.state.wb, set("r2", "c2", "ben")) }] }) });
  await until(() => ana.view().rows.r2.cells.c2 === "ben");
  expect(reads()).toBe(before);
});

// Bug it catches: a host's flush before it quits is ignored, so the quit waits out its full
// timeout and the tab's last edits are not saved first.
test("a host's flush saves what the tab holds before it lets the stream close", async () => {
  const w = hosted();
  w.stream("ana");
  const ana = w.join({ idleMs: 60_000, maxMs: 120_000 });
  await ana.ready;
  const typed = ana.submit(set("r1", "c1", "before quit"));
  await typed.admitted;
  await hostFlush({ type: "flush", seq: 7 });
  expect(w.cell("r1", "c1")).toBe("before quit");
});

// Bug it catches: a sheet save that leaves ClayJS's page ETag at the file before it, so the
// person's next ordinary save outside the sheet is refused as a conflict with their own save.
test("a sheet save moves the page's ETag to the file it wrote", async () => {
  const w = hosted();
  w.stream("ana");
  const recorded = [];
  const ana = w.join({ onSaved: (etag) => recorded.push(etag) });
  await ana.ready;
  ana.submit(set("r1", "c1", "x"));
  await ana.flush();
  // The room's receipt can settle the edit before the save's own answer arrives; establish
  // advances the page ETag first ("e2") and the save advances it to the saved file ("e3").
  await until(() => recorded.at(-1) === w.host.file("doc").etag);
  expect(recorded.length).toBeGreaterThanOrEqual(2);
  expect(recorded.at(-1)).toBe(w.host.file("doc").etag);
});

test("the mode follows what the host announces: file-only on a host with the file contract, unavailable on one with neither", async () => {
  const w = hosted({ room: false });
  w.stream("ana");
  const ana = w.join();
  await ana.ready;
  expect(ana.status.mode).toBe("file");
  const typed = ana.submit(set("r1", "c1", "file"));
  expect(await ana.flush()).toEqual({ [typed.id]: "saved" });
  expect(w.cell("r1", "c1")).toBe("file");
  const none = w.join({ discover: async () => ({ spec: 1, extensions: ["conditional"] }) });
  await none.ready;
  expect(none.status.mode).toBe("unavailable");
  expect(() => none.submit(set("r1", "c1", "x"))).toThrow(/no live room or file contract/);
});

// Bug it catches: HTML Clay's notice that the file changed on disk is ignored (it is a notification
// frame, not a push with an ETag), so an agent's write to the file never shows until a reload and
// the next edit is made against values the person never saw.
test("an outside change to the file, told the way HTML Clay tells it, shows in the tab", async () => {
  const w = hosted({ room: false });
  w.stream("ana");
  const ana = w.join({ idleMs: 60_000, maxMs: 120_000 });
  await ana.ready;
  useCodec(tiny);
  const { record, state } = parse(w.host.file("doc").bytes);
  state.wb.rows.r2.cells.c2 = "agent";
  await w.host.outside("doc", serialize(record, state), "agent");
  await until(() => ana.view()?.rows.r2.cells.c2 === "agent");
});

// Bug it catches: HTML Clay tells a file-mode window about another window's save with a bare
// stamp (`{ etag }`, no type), and a transport that only reacts to notification frames never shows
// the save, so the person edits values a coworker already changed.
test("another window's save, told as a bare stamp, shows in the tab", async () => {
  const w = hosted({ room: false });
  w.stream("ana", w.stamp);
  const ana = w.join({ idleMs: 60_000, maxMs: 120_000 });
  await ana.ready;
  useCodec(tiny);
  const { record, state } = parse(w.host.file("doc").bytes);
  state.wb.rows.r2.cells.c2 = "ben";
  await w.host.outside("doc", serialize(record, state), "save");
  await until(() => ana.view()?.rows.r2.cells.c2 === "ben");
});

// Bug it catches: every keystroke reads the whole page from the host before it acts, so typing on
// a slow connection waits on page downloads (a 556 KB sheet costs megabytes per sentence).
test("typing ten edits reads the page far fewer times than once per edit", async () => {
  const w = hosted();
  w.stream("ana");
  const ana = w.join({ idleMs: 60_000, maxMs: 120_000 });
  await ana.ready;
  const reads = () => w.seen.filter((one) => one.path === "/sheet.html").length;
  const before = reads();
  const typed = [];
  for (let i = 0; i < 10; i++) {
    typed.push(ana.submit(set("r1", "c1", `v${i}`)));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await Promise.all(typed.map((one) => one.admitted));
  expect(reads() - before).toBeLessThan(5);
});

// Bug it catches: on a host that mints save tokens (HTML Clay) the copy routes go out with no
// token, so the host cannot tell which document a recovery copy belongs to and refuses it.
test("on a token host the copy routes carry the save token in the path, and no cookies", async () => {
  const sent = [];
  const transport = browserTransport({ documentUrl: URL_OF_PAGE, token: () => "tok-1", fetch: async (url, init) => (sent.push({ path: new URL(url, URL_OF_PAGE).pathname, credentials: init.credentials }), new Response("{}", { status: 200 })) });
  await transport.fetch("/_/copies?page=doc");
  await transport.fetch("/_/copies/r12?page=doc", { method: "PUT", body: "<html></html>" });
  await transport.fetch("/_/copies/r12/done?page=doc", { method: "POST", body: "{}" });
  expect(sent).toEqual([
    { path: "/_/copies/tok-1", credentials: "omit" },
    { path: "/_/copies/tok-1/r12", credentials: "omit" },
    { path: "/_/copies/tok-1/r12/done", credentials: "omit" },
  ]);
});
