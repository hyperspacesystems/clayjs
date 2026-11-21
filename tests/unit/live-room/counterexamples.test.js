/**
 * @jest-environment node
 */
// X1 round 1's counterexamples: eight reproductions a hunt wrote as scripts, one test per scenario,
// each failing on the code that has the bug and passing once it is fixed. Headless, against the
// reference host.
import { createReferenceHost } from "../../live-room/host/reference-host.mjs";
import { createRoomClient, createFileClient, connect } from "../../../src/live-room/room-client.js";
import { liveRoom } from "../../../src/live-room/browser.js";
import { streamOpened, streamClosed } from "../../../src/live/stream-bridge.js";
import { serialize, parse } from "../../../src/live-room/core/record.js";
import { useCodec } from "../../../src/live-room/core/codec.js";
import { labLimits, REAL_LIMITS } from "../../../src/live-room/core/limits.js";
import { findRegion } from "../../../src/live-room/region.js";
import { codec as tiny } from "../../live-room/lab/codec-tiny/reducer.mjs";

const RECORD = { v: 2, doc: "doc0123456789abc", gen: "0.00000000", epoch: 0, commit: "c00000000000", parent: null, through: 0 };
const START = { wb: { rows: { r1: { pos: "1", cells: { c1: "a" } }, r2: { pos: "2", cells: {} } } }, seen: {}, lineage: [], cut: null, floor: -1 };
const START_OLD = { wb: { rows: { r1: { pos: "1", cells: { c1: "old" } }, r2: { pos: "2", cells: {} } } }, seen: {}, lineage: [], cut: null, floor: -1 };
const set = (row, col, value) => ({ t: "set", row, col, value });
const paste6 = () => ({ t: "paste", cells: Array.from({ length: 6 }, (_, i) => ["r1", `c${i + 1}`, `p${i + 1}`]) });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const open = [];
afterEach(() => Promise.all(open.splice(0).map((one) => one.close())));

async function until(check, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("the condition did not hold in time");
    await pause(5);
  }
}
function inTime(work, ms, message) {
  let timer;
  const late = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

// The offline blip the two saves below share: the first POST /_/save is dropped and every request
// for the next 30ms fails, then the network is healthy again.
function blipping(host) {
  let offline = false;
  let blipped = false;
  return async (url, init) => {
    if (offline) throw new TypeError("fetch failed: network offline");
    if (init?.method === "POST" && String(url).includes("/_/save") && !blipped) {
      blipped = true;
      offline = true;
      setTimeout(() => {
        offline = false;
      }, 30);
      throw new TypeError("fetch failed: network offline");
    }
    return host.fetch(url, init);
  };
}

function world() {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits() } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  const join = (clientId, options = {}) => {
    const client = createRoomClient({ page: "doc", codec: tiny, clientId, fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 5, maxMs: 20, waitMs: 20, ...options });
    open.push(client);
    return client;
  };
  const cell = (row, col) => {
    useCodec(tiny);
    return parse(host.file("doc").bytes).state.wb.rows[row]?.cells[col];
  };
  return { host, join, cell };
}

// Story: a person edits a sheet while their Wi-Fi blips briefly during a save (so both POST /_/save
// and land()'s immediate follow-up GET /_/file fail), and after Wi-Fi comes right back every edit
// from before and after the blip stays unsaved forever (flush() never finishes), losing their work
// when they close the tab.
// Bug it catches: land() awaits its follow-up read before clearing tab.io, so a failed read leaves
// tab.io set for the life of the page and every later send refuses.
// Found on clayjs 9f8b3e17 with C4 part 2a and C9a (X1 round 1, 2026-11-20).
test("a brief offline blip during a save leaves the tab able to save again", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", room: true, rooms: { limits: labLimits() } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: blipping(host), subscribe: host.subscribe, limits: labLimits(), idleMs: 5, maxMs: 20, waitMs: 20 });
  open.push(ana);
  await ana.ready;
  const first = ana.submit(set("r1", "c1", "first"));
  await first.admitted;
  await pause(80);
  const second = ana.submit(set("r2", "c1", "second"));
  await inTime(second.admitted, 400, "offline-save-wedges-tab-io (room mode): the edit typed after the blip was never admitted");
  await inTime(ana.flush(), 400, "offline-save-wedges-tab-io (room mode): flush() did not finish after the network came back");
  useCodec(tiny);
  const saved = parse(host.file("doc").bytes).state.wb;
  expect(saved.rows.r1.cells.c1).toBe("first");
  expect(saved.rows.r2.cells.c1).toBe("second");
});

// Story: a person edits a sheet while their Wi-Fi blips briefly during a save (so both POST /_/save
// and land()'s immediate follow-up GET /_/file fail), and after Wi-Fi comes right back every edit
// from before and after the blip stays unsaved forever (flush() never finishes), losing their work
// when they close the tab.
// Bug it catches: the file-only client's land() has the same order, so a failed read of /_/file
// leaves tab.io set and fileSave() refuses every later save.
// Found on clayjs 9f8b3e17 with C4 part 2a and C9a (X1 round 1, 2026-11-20).
test("a brief offline blip during a save leaves a file-only tab able to save again", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", room: false, rooms: { limits: labLimits() } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  const ana = createFileClient({ page: "doc", codec: tiny, clientId: "ana", fetch: blipping(host), subscribe: host.subscribe, limits: labLimits(), idleMs: 5, maxMs: 20 });
  open.push(ana);
  await ana.ready;
  ana.submit(set("r1", "c1", "first"));
  await pause(80);
  ana.submit(set("r2", "c1", "second"));
  await inTime(ana.flush(), 400, "offline-save-wedges-tab-io (file mode): flush() did not finish after the network came back");
  useCodec(tiny);
  const saved = parse(host.file("doc").bytes).state.wb;
  expect(saved.rows.r1.cells.c1).toBe("first");
  expect(saved.rows.r2.cells.c1).toBe("second");
});

// Story: Ben types an edit into a shared sheet and closes his laptop right before the server
// restarts while Ana still has the sheet open showing Ben's edit; Ana sees status.unsaved === 0 (no
// unsaved-work warning), cannot finish flush() while her tab polls /_/file in an infinite loop, and
// permanently loses Ben's shared edit when she closes her tab (violating Contract P3).
// Bug it catches: editing(), plan() and status.unsaved look only at this tab's own edits, so a tab
// holding a coworker's unsaved action holds back establish and never saves or adopts it.
// Found on clayjs 9f8b3e17 with C4 part 2a and C9a (X1 round 1, 2026-11-20).
test("a tab holding a coworker's unsaved edit keeps it when the room is lost", async () => {
  const w = world();
  let fileReads = 0;
  const fetch = (url, init) => {
    if (String(url).includes("/_/file")) fileReads++;
    return w.host.fetch(url, init);
  };
  const ana = w.join("ana", { fetch, idleMs: 10, maxMs: 30 });
  const ben = w.join("ben", { idleMs: 2000, maxMs: 8000 });
  await Promise.all([ana.ready, ben.ready]);
  const theirs = ben.submit(set("r1", "c1", "ben-q4"));
  await theirs.admitted;
  await until(() => ana.view()?.rows?.r1?.cells?.c1 === "ben-q4", 2000);
  w.host.loseRoom("doc");
  await ben.close();
  const unsaved = ana.status.unsaved;
  const readsBefore = fileReads;
  let timedOut = false;
  await Promise.race([ana.flush(), pause(350).then(() => (timedOut = true))]);
  const readsDuringWait = fileReads - readsBefore;
  if (timedOut || w.cell("r1", "c1") !== "ben-q4" || unsaved === 0) {
    throw new Error(
      `holder-drops-peer-edit-after-room-loss: diskCell=${JSON.stringify(w.cell("r1", "c1"))} (expected "ben-q4"), ` +
        `flushTimedOut=${timedOut}, ana.status.unsaved=${unsaved}, fileReadsIn350ms=${readsDuringWait}`,
    );
  }
});

// Story: after a shared sheet has been opened or reloaded across 81 page loads under production
// limits (REAL_LIMITS, 2 KiB ledger cap) without ever rotating generations at the 75% mark, page
// load #82 types an edit and sees it stuck at pending: 1 forever, never shared with coworkers and
// never auto-saved, losing the edit when the tab closes or reloads.
// Bug it catches: plan() schedules a save only while tab.a > tab.base.through, so capture() is
// never called after a save lands and the generation rotation that trims the ledger never runs.
// Found on clayjs 9f8b3e17 with C4 part 2a and C9a (X1 round 1, 2026-11-20).
test("a sheet's ledger rotates before it fills, so a later page load can still save", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: REAL_LIMITS } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  const cell = () => {
    useCodec(tiny);
    return parse(host.file("doc").bytes).state.wb.rows.r1.cells.c1;
  };
  const anchor = createRoomClient({ page: "doc", codec: tiny, clientId: "anchor", fetch: host.fetch, subscribe: host.subscribe, limits: REAL_LIMITS, idleMs: 2, maxMs: 8, waitMs: 10 });
  open.push(anchor);
  await anchor.ready;
  for (let i = 1; i <= 90; i++) {
    const visitor = createRoomClient({ page: "doc", codec: tiny, clientId: `reload_${i}`, fetch: host.fetch, subscribe: host.subscribe, limits: REAL_LIMITS, idleMs: 2, maxMs: 8, waitMs: 10 });
    open.push(visitor);
    await visitor.ready;
    const want = `v${i}`;
    visitor.submit(set("r1", "c1", want));
    const end = Date.now() + 250;
    while (cell() !== want && Date.now() < end) await pause(2);
    if (cell() !== want) {
      useCodec(tiny);
      const { record, state } = parse(host.file("doc").bytes);
      throw new Error(
        `ledger-never-rotates-at-cap: page load #${i} edit "${want}" stuck (status=${JSON.stringify(visitor.status)}, ` +
          `epoch=${record.epoch}, seenEntries=${Object.keys(state.seen).length}, diskCell=${JSON.stringify(cell())})`,
      );
    }
    await visitor.close();
  }
});

// Story: Ana pastes a multi-cell block into an open sheet just as her live stream briefly drops and
// reconnects; her paste and every edit she types afterward stay stuck at pending forever, never
// appear for coworkers, and hang flush(), losing her paste and all later edits when she closes or
// reloads the tab.
// Bug it catches: the dropped stream's parts answer "closed" and empty tab.flight while
// pending[0].queued stays true, and the reopen keeps the same mirror so drive() skips sync() and
// never resends the paste.
// Found on clayjs 9f8b3e17 with C4 part 2a and C9a (X1 round 1, 2026-11-20).
test("a paste sent while the stream drops and reconnects still reaches the file", async () => {
  const w = world();
  let listener = null;
  let off = null;
  const anaSubscribe = (page, clientId, next) => {
    listener = next;
    off = w.host.subscribe(page, clientId, next);
    return () => off?.();
  };
  let dropOnceOnPaste = false;
  const anaFetch = async (url, init) => {
    if (dropOnceOnPaste && init?.method === "POST" && String(url).includes("/_/sync/room") && !String(url).includes("op=")) {
      dropOnceOnPaste = false;
      await off();
      const answer = await w.host.fetch(url, init);
      off = w.host.subscribe("doc", "ana", listener);
      listener({ type: "file", etag: null });
      return answer;
    }
    return w.host.fetch(url, init);
  };
  const ana = w.join("ana", { fetch: anaFetch, subscribe: anaSubscribe });
  const ben = w.join("ben");
  await Promise.all([ana.ready, ben.ready]);
  ana.submit(set("r1", "c1", "open"));
  await ana.flush();
  await pause(30);
  dropOnceOnPaste = true;
  ana.submit(paste6());
  await pause(30);
  ana.submit(set("r2", "c1", "after-paste"));
  let timedOut = false;
  await Promise.race([ana.flush(), pause(350).then(() => (timedOut = true))]);
  useCodec(tiny);
  const saved = parse(w.host.file("doc").bytes).state.wb;
  if (timedOut || saved.rows.r1.cells.c6 !== "p6" || saved.rows.r2.cells.c1 !== "after-paste") {
    throw new Error(
      `stream-reopen-mid-paste-stalls-tab: flushTimedOut=${timedOut}, ana.status=${JSON.stringify(ana.status)}, ` +
        `r1.c6=${JSON.stringify(saved.rows.r1.cells.c6)}, r2.c1=${JSON.stringify(saved.rows.r2.cells.c1)}`,
    );
  }
});

// Story: while co-editing an open sheet, Ben's live stream misses one room event from Ana and
// delivers her next room event; Ben's room client crashes with TypeError: Cannot read properties of
// undefined (reading 'parts'), stops displaying Ana's edits, and leaves Ben's next edit stuck in
// pending (never sent or auto-saved), losing Ben's edit when he closes or reloads his tab.
// Bug it catches: hear() writes a sparse hole in mirror.log, so arrive() reads parts off an
// undefined entry and throws before Ben's tab can post or save its edit.
// Found on clayjs 9f8b3e17 with C4 part 2a and C9a (X1 round 1, 2026-11-20).
test("a missed room event does not crash the tab or stall its next edit", async () => {
  const w = world();
  let dropNext = false;
  const benSubscribe = (page, clientId, next) =>
    w.host.subscribe(page, clientId, (event) => {
      if (dropNext && event.type === "room") {
        dropNext = false;
        return;
      }
      next(event);
    });
  const ana = w.join("ana", { idleMs: 60_000, maxMs: 120_000 });
  const ben = w.join("ben", { subscribe: benSubscribe });
  await Promise.all([ana.ready, ben.ready]);
  ana.submit(set("r1", "c1", "init"));
  await ana.flush();
  await until(() => ben.view()?.rows?.r1?.cells?.c1 === "init", 2000);
  dropNext = true;
  await ana.submit(set("r1", "c1", "ana-1")).admitted;
  await ana.submit(set("r1", "c2", "ana-2")).admitted;
  await pause(30);
  ben.submit(set("r2", "c1", "ben-edit"));
  await pause(150);
  const benSeesAna2 = ben.view()?.rows?.r1?.cells?.c2;
  const diskHasBen = w.cell("r2", "c1");
  if (ben.status.error || benSeesAna2 !== "ana-2" || diskHasBen !== "ben-edit") {
    throw new Error(
      `missed-room-event-crashes-client: ben.status.error=${ben.status.error?.message ?? null}, ` +
        `benSeesAna2=${JSON.stringify(benSeesAna2)}, diskHasBen=${JSON.stringify(diskHasBen)}, ben.status.pending=${ben.status.pending}`,
    );
  }
});

// Story: Ana leaves a sheet open while her laptop sleeps, during which Ben edits a cell, saves, and
// leaves and the clean idle room expires (sweep()), and when Ana wakes her laptop and her stream
// reconnects her tab fetches the updated file yet still displays "old" instead of "ben-new", causing
// her next edit to record a stale saw and overwrite Ben's unseen value.
// Bug it catches: read() keeps tab.state instead of loading the fetched file, and establish is held
// back on an idle tab, so the attach that would load the new file never runs.
// Found on clayjs 9f8b3e17 with C4 part 2a and C9a (X1 round 1, 2026-11-20).
test("an idle tab shows a coworker's saved edit after the room expires", async () => {
  let clock = 1000;
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits(), now: () => clock, retainMs: 60_000 } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START_OLD));
  let listener = null;
  let off = null;
  const anaSubscribe = (page, clientId, next) => {
    listener = next;
    off = host.subscribe(page, clientId, next);
    return () => off?.();
  };
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: host.fetch, subscribe: anaSubscribe, limits: labLimits(), idleMs: 5, maxMs: 20, waitMs: 200 });
  open.push(ana);
  await ana.ready;
  await off();
  const ben = createRoomClient({ page: "doc", codec: tiny, clientId: "ben", fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 5, maxMs: 20, waitMs: 20 });
  open.push(ben);
  await ben.ready;
  ben.submit(set("r1", "c1", "ben-new"));
  await ben.flush();
  await ben.close();
  clock += 120_000;
  host.rooms.sweep();
  off = host.subscribe("doc", "ana", listener);
  listener({ type: "file", etag: null });
  await pause(60);
  const shown = ana.view()?.rows?.r1?.cells?.c1;
  useCodec(tiny);
  const onDisk = parse(host.file("doc").bytes).state.wb.rows.r1.cells.c1;
  if (shown !== "ben-new") {
    throw new Error(`idle-viewer-overwrites-unseen-edit: onDisk=${JSON.stringify(onDisk)}, but ana.view() still shows ${JSON.stringify(shown)}`);
  }
});

// Story: Ana saves an edit that commits durably on disk while the HTTP response returns 503
// (save-unknown) or drops; flush() resolves her edit as "saved", yet status.unknownSave remains true
// forever, keeping the unsaved-work close warning falsely stuck on when she tries to close the tab.
// Bug it catches: land() reads the file before deliver() sets tab.unknown, so the receipt that
// already arrived on the stream never clears it.
// Found on clayjs 9f8b3e17 with C4 part 2a and C9a (X1 round 1, 2026-11-20).
test("an edit saved with the answer lost does not leave the unknown-save flag on", async () => {
  const w = world();
  w.host.fault("unknown", (req) => req.method === "POST" && req.url.includes("/_/save"));
  const ana = w.join("ana");
  await ana.ready;
  const typed = ana.submit(set("r1", "c1", "saved-503"));
  const result = await ana.flush();
  await pause(100);
  if (result[typed.id] === "saved" && ana.status.unknownSave !== false) {
    throw new Error(`unknown-save-flag-stuck: flush() returned ${JSON.stringify(result)} while ana.status.unknownSave=${ana.status.unknownSave}`);
  }
  expect(result).toEqual({ [typed.id]: "saved" });
});

// Story: a person opens a sheet on a network where the SSE stream cannot connect yet and navigates
// away or closes the component (room.close()), leaving close() hung forever on
// streamClientId(Infinity) and leaking its stream listener.
// Bug it catches: close() awaits ready, and ready awaits a stream client id that never arrives, with
// nothing aborting the wait.
// Found on clayjs 9f8b3e17 with C4 part 2a and C9a (X1 round 1, 2026-11-20).
test("closing a room closes even when the stream never connects", async () => {
  streamClosed();
  const room = liveRoom("sheet", {
    codec: tiny,
    documentUrl: "https://ana.example/sheet.html",
    fetch: async () => new Response("", { status: 503 }),
    discover: async () => ({ spec: 1, extensions: ["ordered-room"] }),
    onSaved: () => {},
  });
  let hung = false;
  await Promise.race([room.close(), pause(200).then(() => (hung = true))]);
  if (hung) throw new Error("browser-close-hangs-without-stream: room.close() hung waiting for streamClientId(Infinity)");
});

// Story: Ana edits a sheet in a browser on a file-only host right as an expired session answers
// POST /_/save with a 200 HTML login page and no ETag (the host never sees the save), and liveRoom
// reports her edit as "saved" with pending and unknownSave cleared, silently losing her work.
// Bug it catches: browserTransport's save() treats any 200 as an accepted save, so a 200 that names
// no saved version reaches the client as a receipt for a write the host never made.
// Found on clayjs 489b77ad (C9a and X1 round 1 landed; X1 round 2, 2026-11-20).
test("a save answered by a login page is not reported saved", async () => {
  const URL_OF_PAGE = "https://ana.example/sheet.html";
  const pageOf = (region, etag) => `<!DOCTYPE html><html lang="en" documentetag="${etag.replace(/"/g, "&quot;")}"><head><title>Budget</title></head><body><div sheet-workbook>${region}</div></body></html>`;
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", room: false, rooms: { limits: labLimits() } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  let loginPage = true;
  const fetchPage = async (url, init = {}) => {
    const target = new URL(url, URL_OF_PAGE);
    if (target.href === URL_OF_PAGE) {
      const { bytes, etag } = host.file("doc");
      return new Response(pageOf(bytes, etag), { status: 200, headers: { "content-type": "text/html" } });
    }
    if (target.pathname === "/_/save") {
      // A 302 to a login page or a captive portal: 200, HTML, no ETag, and the host untouched.
      if (loginPage) return new Response("<!doctype html><html><body>Please sign in</body></html>", { status: 200, headers: { "content-type": "text/html" } });
      const headers = init.headers?.["If-Match"] ? { "if-match": init.headers["If-Match"] } : {};
      return host.fetch("/_/save?page=doc", { method: "POST", headers, body: findRegion(init.body).inner });
    }
    return host.fetch(`${target.pathname}${target.search}`, init);
  };
  streamClosed();
  streamOpened({ clientId: "ana", lane: "live" });
  const ana = liveRoom("sheet", {
    codec: tiny,
    documentUrl: URL_OF_PAGE,
    fetch: fetchPage,
    onSaved: () => {},
    discover: async () => ({ spec: 1, extensions: ["ordered-file", "recovery-copies"] }),
    limits: labLimits(),
    idleMs: 5,
    maxMs: 20,
  });
  open.push(ana);
  await ana.ready;
  const typed = ana.submit(set("r1", "c1", "important-figure"));
  let resolved = null;
  const flushed = ana.flush().then((result) => (resolved = result));
  const disk = () => {
    useCodec(tiny);
    return parse(host.file("doc").bytes).state.wb.rows.r1.cells.c1;
  };
  await pause(300);
  const status = ana.status;
  if (resolved?.[typed.id] === "saved" || !(status.pending + status.unsaved > 0 || status.unknownSave) || disk() === "important-figure")
    throw new Error(
      `browser-file-mode-nonjson-200-false-saved: flush() returned ${JSON.stringify(resolved)} after 300ms, ` +
        `status=${JSON.stringify(status)}, disk r1.c1=${JSON.stringify(disk())}`,
    );
  loginPage = false;
  await inTime(flushed, 2000, "browser-file-mode-nonjson-200-false-saved: flush() did not finish once the host answered the save");
  expect(resolved[typed.id]).toBe("saved");
  expect(disk()).toBe("important-figure");
});

// Story: Ana inserts 130 rows and pastes a column of 130 values into them just before a server
// restart and version restore strand her unsaved work into a recovery copy; when her tab restores
// the copy the 130 empty rows come back yet her 130-cell paste is refused as "bad-size", wedging
// the restore job so her pasted values never reach the sheet and no "restored" notice appears.
// Bug it catches: a split paste's first part carries the copy frame's `made` header while the frame's
// declared size does not, so the room's staging bound refuses it as "bad-size" and the client drops
// the part without answering the job.
// Found on clayjs 489b77ad (C9a and X1 round 1 landed; X1 round 2, 2026-11-20).
test("a restored multi-part paste is not refused as bad-size", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: REAL_LIMITS } });
  useCodec(tiny);
  const base = serialize(RECORD, START);
  host.put("doc", base);
  {
    const { record, state } = parse(base);
    state.wb.rows.r2.cells.c1 = "prep";
    await host.outside("doc", serialize(record, state), "agent");
  }
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: host.fetch, subscribe: host.subscribe, limits: REAL_LIMITS, idleMs: 60_000, maxMs: 120_000, waitMs: 50 });
  open.push(ana);
  await ana.ready;
  const count = 130;
  const inserts = [];
  for (let i = 1; i <= count; i++) inserts.push(ana.submit({ t: "ins", row: `n${String(i).padStart(3, "0")}`, pos: `2.${String(i).padStart(3, "0")}`, cells: {} }));
  const cells = Array.from({ length: count }, (_, i) => [`n${String(i + 1).padStart(3, "0")}`, "c1", `val-${i + 1}`]);
  const pasted = ana.submit({ t: "paste", cells });
  await inTime(Promise.all([...inserts.map((handle) => handle.admitted), pasted.admitted]), 2000, "multipart-restore-made-bad-size: the edits were never admitted");
  host.loseRoom("doc");
  await host.outside("doc", base, "restore");
  await until(() => ana.status.copies === 1, 3000);
  const restored = () => {
    useCodec(tiny);
    const wb = parse(host.file("doc").bytes).state.wb;
    return wb.rows.n130?.cells?.c1 === "val-130" && ana.notices().some((one) => one.kind === "restored");
  };
  try {
    await until(restored, 800);
  } catch {
    await Promise.race([ana.flush(), pause(300)]);
  }
  useCodec(tiny);
  const wb = parse(host.file("doc").bytes).state.wb;
  const notices = ana.notices().filter((one) => one.kind === "restored");
  if (wb.rows.n130?.cells?.c1 !== "val-130" || !notices.length)
    throw new Error(
      `multipart-restore-made-bad-size: row n130 exists=${Boolean(wb.rows.n130)}, n130.c1=${JSON.stringify(wb.rows.n130?.cells?.c1 ?? null)} ` +
        `(expected "val-130"), restoredNotices=${notices.length}, status=${JSON.stringify(ana.status)}`,
    );
  expect(wb.rows.n130.cells.c1).toBe("val-130");
});

// Story: after people restore the same recovery copy on one sheet over and over and every edit is
// saved to disk, the host's shared live-bytes budget is steadily exhausted until coworkers opening
// unrelated sheets on the same host are refused and cannot edit or save.
// Bug it catches: the room registry charges each `copy` frame's bytes to the slot and never releases
// them, so resolved restores keep consuming the host's budget with nothing left to save.
// Found on clayjs 489b77ad (C9a and X1 round 1 landed; X1 round 2, 2026-11-20).
test("repeated restores of one copy do not starve other sheets of the host's budget", async () => {
  const limits = labLimits();
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits, liveBytes: 10_000 } });
  useCodec(tiny);
  const base = serialize(RECORD, START);
  host.put("doc1", base);
  host.put("doc2", base);
  {
    const { record, state } = parse(base);
    state.wb.rows.r2.cells.c1 = "prep";
    await host.outside("doc1", serialize(record, state), "agent");
  }
  const ana = createRoomClient({ page: "doc1", codec: tiny, clientId: "ana", fetch: host.fetch, subscribe: host.subscribe, limits, idleMs: 60_000, maxMs: 120_000, waitMs: 30 });
  const ben = createRoomClient({ page: "doc2", codec: tiny, clientId: "ben", fetch: host.fetch, subscribe: host.subscribe, limits, idleMs: 5, maxMs: 20, waitMs: 30 });
  open.push(ana, ben);
  await inTime(Promise.all([ana.ready, ben.ready]), 2000, "copy-bytes-leak-starves-server-rooms: the tabs never became ready");
  const edits = [];
  for (let i = 1; i <= 6; i++) edits.push(ana.submit(set("r1", `c${i}`, `value-${i}-${"x".repeat(40)}`)));
  await inTime(Promise.all(edits.map((one) => one.admitted)), 2000, "copy-bytes-leak-starves-server-rooms: the edits were never admitted");
  host.loseRoom("doc1");
  await host.outside("doc1", base, "restore");
  await until(() => ana.status.copies === 1, 3000);
  const [copy] = ana.copies();
  await until(() => {
    useCodec(tiny);
    return parse(host.file("doc1").bytes).state.wb.rows.r1.cells.c6?.startsWith("value-6-") || ana.status.unsaved > 0;
  }, 3000);
  await inTime(ana.flush(), 3000, "copy-bytes-leak-starves-server-rooms: ana could not save her stranded edits");
  await until(() => ana.notices().some((one) => one.kind === "restored"), 3000);
  for (let round = 0; round < 6; round++) {
    const viewer = createRoomClient({ page: "doc1", codec: tiny, clientId: `v${round}`, fetch: host.fetch, subscribe: host.subscribe, limits, idleMs: 5, maxMs: 20, waitMs: 30 });
    await viewer.ready;
    await viewer.restore(copy.id);
    await pause(40);
    await viewer.close();
  }
  ben.submit(set("r1", "c1", "ben-doc2"));
  let timedOut = false;
  await Promise.race([ben.flush(), pause(350).then(() => (timedOut = true))]);
  useCodec(tiny);
  const doc2Cell = parse(host.file("doc2").bytes).state.wb.rows.r1.cells.c1;
  if (timedOut || doc2Cell !== "ben-doc2")
    throw new Error(`copy-bytes-leak-starves-server-rooms: Ben in unrelated doc2 flushTimedOut=${timedOut}, doc2 r1.c1=${JSON.stringify(doc2Cell)} (expected "ben-doc2")`);
});

// Story: Cy opens a sheet where no room is active, clicks "Restore" on Ana's stored recovery copy,
// and awaits flush() before restarting his host; flush() resolves at once, before the restore job
// has written to disk, so the restored edit is reported as saved and is lost on the restart.
// Bug it catches: flush() waits only for admitted edits, not for the restore job it just started,
// so it resolves while the job's decision has not reached the file.
// Found on clayjs 489b77ad (C9a and X1 round 1 landed; X1 round 2, 2026-11-20).
test("flush() waits for a restore job's decision to reach the file", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits() } });
  useCodec(tiny);
  const base = serialize(RECORD, START);
  host.put("doc", base);
  {
    const { record, state } = parse(base);
    state.wb.rows.r2.cells.c1 = "prep";
    await host.outside("doc", serialize(record, state), "agent");
  }
  let blockAnaFrames = false;
  const ana = createRoomClient({
    page: "doc",
    codec: tiny,
    clientId: "ana",
    fetch: (url, init = {}) => {
      if (blockAnaFrames && init.method === "POST" && String(url).includes("/_/sync/room") && !String(url).includes("op=")) return Promise.reject(new TypeError("dropped"));
      return host.fetch(url, init);
    },
    subscribe: host.subscribe,
    limits: labLimits(),
    idleMs: 60_000,
    maxMs: 120_000,
    waitMs: 30,
  });
  open.push(ana);
  await ana.ready;
  await ana.submit(set("r1", "c1", "mine")).admitted;
  blockAnaFrames = true;
  host.loseRoom("doc");
  await host.outside("doc", base, "restore");
  await until(() => ana.status.copies === 1, 3000);
  const [copy] = ana.copies();
  await ana.close();
  host.loseRoom("doc");
  const cy = createRoomClient({
    page: "doc",
    codec: tiny,
    clientId: "cy",
    fetch: async (url, init) => {
      await pause(3);
      return host.fetch(url, init);
    },
    subscribe: host.subscribe,
    limits: labLimits(),
    idleMs: 60_000,
    maxMs: 120_000,
    waitMs: 30,
  });
  open.push(cy);
  await cy.ready;
  const started = await cy.restore(copy.id);
  if (!started) throw new Error("setup failed: cy.restore() returned false");
  await inTime(cy.flush(), 2000, "flush-resolves-before-decision-lands: flush() did not finish");
  useCodec(tiny);
  const diskAtFlush = parse(host.file("doc").bytes).state.wb.rows.r1.cells.c1;
  if (diskAtFlush !== "mine")
    throw new Error(`flush-resolves-before-decision-lands: restore() and flush() both resolved, yet disk r1.c1=${JSON.stringify(diskAtFlush)} (expected "mine")`);
  expect(diskAtFlush).toBe("mine");
});

// Story: on a file-only host without recovery-copies, Ana has one earlier edit whose save went
// unanswered while she was offline before ledger rotation retired her client; her tab keeps that
// unstored edit, yet every new edit she types for the rest of the session is refused and flush()
// hangs forever, losing all later work when she closes the window.
// Bug it catches: fileSave() gives up whenever the tab holds an unstored copy, so one copy the host
// will never take blocks every later save instead of being reported as "unstored".
// Found on clayjs 489b77ad (C9a and X1 round 1 landed; X1 round 2, 2026-11-20).
test("an unstored edit does not block every later save", async () => {
  const limits = labLimits({ ledgerCap: 120 });
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", room: false, rooms: { limits } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  let dropSaves = false;
  let mutePushes = false;
  const anaFetch = (url, init = {}) => {
    if (dropSaves && init.method === "POST" && String(url).includes("/_/save")) return Promise.reject(new TypeError("fetch failed: save dropped"));
    return host.fetch(url, init);
  };
  const ana = await connect({
    page: "doc",
    codec: tiny,
    clientId: "ana",
    fetch: anaFetch,
    subscribe: (page, clientId, listener) => host.subscribe(page, clientId, (event) => !mutePushes && listener(event)),
    extensions: ["ordered-file"],
    limits,
    idleMs: 10,
    maxMs: 30,
  });
  open.push(ana);
  await ana.ready;
  dropSaves = true;
  mutePushes = true;
  const stranded = ana.submit(set("r1", "c1", "stranded-edit"));
  await pause(30);
  for (let i = 1; i <= 8; i++) {
    const peer = await connect({ page: "doc", codec: tiny, clientId: `peer_${i}`, fetch: host.fetch, subscribe: host.subscribe, extensions: ["ordered-file"], limits, idleMs: 5, maxMs: 20 });
    await peer.ready;
    peer.submit(set("r1", "c2", `p${i}`));
    await peer.flush();
    await peer.close();
  }
  dropSaves = false;
  mutePushes = false;
  const later = ana.submit(set("r2", "c1", "new-work"));
  let timedOut = false;
  let flushed = null;
  await Promise.race([ana.flush().then((result) => (flushed = result)), pause(300).then(() => (timedOut = true))]);
  useCodec(tiny);
  const wb = parse(host.file("doc").bytes).state.wb;
  if (timedOut || wb.rows.r2.cells.c1 !== "new-work")
    throw new Error(
      `file-mode-unstored-copy-blocks-all-future-saves: flushTimedOut=${timedOut}, r2.c1=${JSON.stringify(wb.rows.r2.cells.c1)} ` +
        `(expected "new-work"), status=${JSON.stringify(ana.status)}`,
    );
  expect(flushed[later.id]).toBe("saved");
  expect(flushed[stranded.id]).toBe("unstored");
});

// Story: on a file-only host Ana saves a cell edit right as a connection drop cuts off the HTTP 200
// save response body (cut short or empty), and her tab throws an unhandled rejection, hangs flush()
// forever, and silently stops saving every edit she types afterwards.
// Bug it catches: the save answer's body is parsed in a fulfilment callback with no catch, so a body
// that does not parse leaves tab.io set and every later save refused.
// Found on clayjs 489b77ad (C9a and X1 round 1 landed; X1 round 2, 2026-11-20).
test("a save whose answer body is cut short or empty does not wedge the tab", async () => {
  for (const kind of ["blank", "torn"]) {
    const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", room: false, rooms: { limits: labLimits() } });
    useCodec(tiny);
    host.put("doc", serialize(RECORD, START));
    const unhandled = [];
    const note = (error) => unhandled.push(error);
    process.on("unhandledRejection", note);
    try {
      const ana = createFileClient({ page: "doc", codec: tiny, clientId: "ana", fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 5, maxMs: 20 });
      open.push(ana);
      await ana.ready;
      host.fault(kind, (req) => req.method === "POST" && req.url.includes("/_/save"));
      ana.submit(set("r1", "c1", "first"));
      await pause(60);
      ana.submit(set("r2", "c1", "second"));
      let timedOut = false;
      await Promise.race([ana.flush(), pause(400).then(() => (timedOut = true))]);
      useCodec(tiny);
      const wb = parse(host.file("doc").bytes).state.wb;
      if (timedOut || unhandled.length || wb.rows.r2.cells.c1 !== "second")
        throw new Error(
          `file-mode-torn-save-wedges-client (${kind}): flushTimedOut=${timedOut}, unhandledRejections=${unhandled.length} ` +
            `(${unhandled[0]?.message ?? "none"}), r2.c1=${JSON.stringify(wb.rows.r2.cells.c1)} (expected "second")`,
        );
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", note);
    }
  }
});

// Story: Ana types two cells while her frame-batch answer drops just before a server restart and a
// version restore; coworker Dana's tab restores the lost room's copy, where Ana's first edit
// conflicts and her second applies, leaving the first stuck at pending forever with no notice.
// Bug it catches: a restore job's marks reach this tab on a copy frame, which the tab does not treat
// as a reason to read the host's copy list, so an edit passed over in limbo never gets its mark.
// Found on clayjs 489b77ad (C9a and X1 round 1 landed; X1 round 2, 2026-11-20).
test("a coworker's restore passes over a limbo edit with its marks read", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits() } });
  useCodec(tiny);
  const oldVersion = serialize(RECORD, START_OLD);
  host.put("doc", oldVersion);
  {
    const { record, state } = parse(oldVersion);
    state.wb.rows.r1.cells.c1 = "before";
    await host.outside("doc", serialize(record, state), "agent");
  }
  let muteAnaRoomEvents = false;
  let holdAnaFrames = false;
  const anaSubscribe = (page, clientId, listener) =>
    host.subscribe(page, clientId, (event) => (muteAnaRoomEvents && event.type === "room" ? undefined : listener(event)));
  const anaFetch = (url, init = {}) => {
    const isFrames = init.method === "POST" && String(url).includes("/_/sync/room") && !String(url).includes("op=");
    if (holdAnaFrames && isFrames) return Promise.reject(new TypeError("fetch failed: dropped"));
    return host.fetch(url, init);
  };
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: anaFetch, subscribe: anaSubscribe, limits: labLimits(), idleMs: 60_000, maxMs: 120_000, waitMs: 40 });
  const dana = createRoomClient({ page: "doc", codec: tiny, clientId: "dana", fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 10, maxMs: 30, waitMs: 40 });
  open.push(ana, dana);
  await inTime(Promise.all([ana.ready, dana.ready]), 2000, "peer-restore-skips-limbo-without-marks: the tabs never became ready");
  dana.submit(set("r2", "c2", "open"));
  await inTime(dana.flush(), 2000, "peer-restore-skips-limbo-without-marks: dana could not open the room");
  await until(() => ana.view()?.rows?.r2?.cells?.c2 === "open", 2000);
  muteAnaRoomEvents = true;
  host.fault("lose", (req) => req.method === "POST" && req.url.includes("/_/sync/room") && !req.url.includes("op="));
  const e1 = ana.submit(set("r1", "c1", "ana-1"));
  ana.submit(set("r2", "c1", "ana-2"));
  await until(() => dana.view()?.rows?.r2?.cells?.c1 === "ana-2", 2000);
  holdAnaFrames = true;
  muteAnaRoomEvents = false;
  host.loseRoom("doc");
  await host.outside("doc", oldVersion, "restore");
  await until(() => {
    useCodec(tiny);
    const wb = parse(host.file("doc").bytes).state.wb;
    return wb.rows.r2?.cells?.c1 === "ana-2" && dana.notices().some((one) => one.kind === "restored");
  }, 3000);
  holdAnaFrames = false;
  let timedOut = false;
  let settled = null;
  await Promise.race([ana.flush().then((result) => (settled = result)), pause(500).then(() => (timedOut = true))]);
  const e1Notices = ana.notices().filter((one) => one.edits?.includes(e1.id));
  if (timedOut || ana.status.pending !== 0 || !e1Notices.length)
    throw new Error(
      `peer-restore-skips-limbo-without-marks: flushTimedOut=${timedOut}, settled=${JSON.stringify(settled)}, ` +
        `ana.status=${JSON.stringify(ana.status)}, e1Notices=${JSON.stringify(e1Notices)}`,
    );
  expect(ana.status.pending).toBe(0);
  expect(e1Notices.length).toBeGreaterThan(0);
});

// Story: after ~62 page loads put the request ledger past the 75% rotation mark while the room is
// still open, Ana opens the sheet, awaits ready, and types an edit while her tab's background
// rotation op=establish is in flight; her edit was posted to the dying generation, refused as
// stale, and stranded in an un-restorable "unjudged" recovery copy.
// Bug it catches: flush() posts req frames while an establish is in flight, marking them sent in
// the dying generation so classify() cannot rekey them after rotation raises the floor.
// Found on clayjs 9f8b3e17 with C4p2a, C9a, X1 r1+r2 (X1 round 3, 2026-11-20).
test("typing right after ready during a background ledger rotation saves cleanly", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: REAL_LIMITS } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  for (let i = 1; i <= 62; i++) {
    const peer = createRoomClient({ page: "doc", codec: tiny, clientId: `peer_${i}`, fetch: host.fetch, subscribe: host.subscribe, limits: REAL_LIMITS, idleMs: 60_000, maxMs: 120_000, waitMs: 20 });
    await peer.ready;
    await peer.submit(set("r2", "c1", `p${i}`)).admitted;
    await peer.close();
  }
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: host.fetch, subscribe: host.subscribe, limits: REAL_LIMITS, idleMs: 10, maxMs: 30, waitMs: 20 });
  open.push(ana);
  await ana.ready;
  ana.submit(set("r1", "c1", "ana-budget"));
  await inTime(ana.flush(), 2000, "typing-on-open-during-rotation-strands-edit: flush timed out");
  useCodec(tiny);
  expect(ana.view()?.rows?.r1?.cells?.c1).toBe("ana-budget");
  expect(parse(host.file("doc").bytes).state.wb.rows.r1.cells.c1).toBe("ana-budget");
});

// Story: Ana clears 220 cells holding large text notes (tiny actionBytes, huge saw exceeding the
// room's tail budget) and then types a summary cell; edit() only checked actionBytes, so the room
// answered "full" on an empty room and permanently wedged her tab.
// Bug it catches: edit() checks only actionBytes, not the full frameBytes including saw against
// tailBudget, allowing an un-admittable pending edit to block every later edit forever.
// Found on clayjs 9f8b3e17 with C4p2a, C9a, X1 r1+r2 (X1 round 3, 2026-11-20).
test("clearing cells whose saw exceeds the room tail budget is rejected as too-large without wedging later edits", async () => {
  const rows = { keep: { pos: "0", cells: { c1: "ok" } } };
  const clearCells = [];
  const note = "n".repeat(20_500);
  for (let i = 1; i <= 220; i++) {
    const id = `r${String(i).padStart(3, "0")}`;
    rows[id] = { pos: String(i), cells: { c1: note } };
    clearCells.push([id, "c1", ""]);
  }
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: REAL_LIMITS } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, { wb: { rows }, seen: {}, lineage: [], cut: null, floor: -1 }));
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: host.fetch, subscribe: host.subscribe, limits: REAL_LIMITS, idleMs: 10, maxMs: 30, waitMs: 30 });
  open.push(ana);
  await ana.ready;
  const cleared = ana.submit({ t: "paste", cells: clearCells });
  expect(cleared).toBeNull();
  expect(ana.notices().some((one) => one.kind === "too-large")).toBe(true);
  ana.submit({ t: "set", row: "keep", col: "c2", value: "summary" });
  await inTime(ana.flush(), 1000, "clearing-filled-cells-wedges-tab: flush timed out");
  useCodec(tiny);
  expect(parse(host.file("doc").bytes).state.wb.rows.keep.cells.c2).toBe("summary");
});

// Story: Ben's frame batch gets "full" just as Ana's save lands and delivers its SSE receipt to
// Ben while Ben's POST response is still resolving; applyReceipt runs retry() before tab.throttled
// is set, leaving Ben permanently throttled on a clean idle room.
// Bug it catches: queue() ignores receipts and space notices that arrived while the POST was in
// flight, so answered("full") leaves tab.throttled stuck true with nothing left to save.
// Found on clayjs 9f8b3e17 with C4p2a, C9a, X1 r1+r2 (X1 round 3, 2026-11-20).
test("a save receipt arriving while a full answer is resolving does not deadlock the sender", async () => {
  const limits = labLimits();
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  let anaFlushTriggered = false;
  let anaRef = null;
  const benFetch = async (url, init = {}) => {
    const res = await host.fetch(url, init);
    if (init.method === "POST" && String(url).includes("/_/sync/room") && !String(url).includes("op=")) {
      const cloned = await res.clone().json();
      if (cloned.answers?.includes("full") && !anaFlushTriggered) {
        anaFlushTriggered = true;
        const saving = anaRef.flush();
        return { ok: res.ok, status: res.status, headers: res.headers, json: async () => (await saving, cloned) };
      }
    }
    return res;
  };
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: host.fetch, subscribe: host.subscribe, limits, idleMs: 60_000, maxMs: 120_000, waitMs: 30 });
  anaRef = ana;
  const ben = createRoomClient({ page: "doc", codec: tiny, clientId: "ben", fetch: benFetch, subscribe: host.subscribe, limits, idleMs: 60_000, maxMs: 120_000, waitMs: 30 });
  open.push(ana, ben);
  await Promise.all([ana.ready, ben.ready]);
  for (let i = 1; i <= 4; i++) await ana.submit(set("r1", `c${i}`, "x".repeat(380))).admitted;
  await pause(20);
  ben.submit(set("r2", "c1", "b".repeat(350)));
  await pause(80);
  ben.submit(set("r2", "c2", "ben-2"));
  await inTime(ben.flush(), 1000, "full-receipt-race-deadlocks-tab: flush timed out");
  useCodec(tiny);
  const wb = parse(host.file("doc").bytes).state.wb;
  expect(wb.rows.r2.cells.c1).toBe("b".repeat(350));
  expect(wb.rows.r2.cells.c2).toBe("ben-2");
});

// Story: Ana makes unwanted edits in a live room before autosave writes them to disk and restores
// the last saved version from history; outsideStep compared the restored version only against disk
// (not the dirty room), treated it as same: true with no backup, and let autosave overwrite disk.
// Bug it catches: outsideStep compares against current on disk instead of the dirty room on an
// explicit restore, skipping backup and cut.
// Found on clayjs 9f8b3e17 with C4p2a, C9a, X1 r1+r2 (X1 round 3, 2026-11-20).
test("restoring the last saved version over a dirty room backs up the room and resets it", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits() } });
  useCodec(tiny);
  const cleanSavedVersion = serialize(RECORD, { wb: { rows: { r1: { pos: "1", cells: { c1: "approved-100k" } }, r2: { pos: "2", cells: {} } } }, seen: {}, lineage: [], cut: null, floor: -1 });
  host.put("doc", cleanSavedVersion);
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 80, maxMs: 200, waitMs: 20 });
  const ben = createRoomClient({ page: "doc", codec: tiny, clientId: "ben", fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 80, maxMs: 200, waitMs: 20 });
  open.push(ana, ben);
  await Promise.all([ana.ready, ben.ready]);
  await ana.submit(set("r1", "c1", "accidental-wipe")).admitted;
  const restored = await host.outside("doc", cleanSavedVersion, "restore");
  await pause(220);
  useCodec(tiny);
  expect(restored.backup).toBe(true);
  expect(host.versions("doc").filter((v) => v.kind === "backup").length).toBe(1);
  expect(parse(host.file("doc").bytes).state.wb.rows.r1.cells.c1).toBe("approved-100k");
  expect(ben.view()?.rows?.r1?.cells?.c1).toBe("approved-100k");
});

// Story: Ben edits a cell and closes his laptop right before a server restart and version restore,
// leaving Ana's tab uploading a recovery copy for Ben's edit; flush() resolved before PUT finished,
// losing Ben's edit when Ana's tab closed.
// Bug it catches: plan() resolves flush() without waiting for tab.unstored uploads or restorable()
// copies to finish.
// Found on clayjs 9f8b3e17 with C4p2a, C9a, X1 r1+r2 (X1 round 3, 2026-11-20).
test("flush() waits for an in-flight recovery copy upload and restore before resolving", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits() } });
  useCodec(tiny);
  const base = serialize(RECORD, START);
  host.put("doc", base);
  {
    const { record, state } = parse(base);
    state.wb.rows.r2.cells.c1 = "prep";
    await host.outside("doc", serialize(record, state), "agent");
  }
  let anaAlive = true;
  const anaFetch = async (url, init = {}) => {
    if (!anaAlive) throw new TypeError("tab closed");
    if (init.method === "PUT" && String(url).includes("/_/copies/")) {
      await pause(40);
      if (!anaAlive) throw new TypeError("tab closed before PUT completed");
    }
    return host.fetch(url, init);
  };
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: anaFetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 60_000, maxMs: 120_000, waitMs: 30 });
  const ben = createRoomClient({ page: "doc", codec: tiny, clientId: "ben", fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 60_000, maxMs: 120_000, waitMs: 30 });
  open.push(ana, ben);
  await Promise.all([ana.ready, ben.ready]);
  await ben.submit(set("r1", "c1", "ben-q4")).admitted;
  await until(() => ana.view()?.rows?.r1?.cells?.c1 === "ben-q4");
  await ben.close();
  host.loseRoom("doc");
  await host.outside("doc", base, "restore");
  await until(() => ana.status.unstored > 0);
  await inTime(ana.flush(), 2000, "flush-before-copy-upload-loses-peer-edit: flush timed out");
  anaAlive = false;
  await ana.close();
  useCodec(tiny);
  const onDisk = parse(host.file("doc").bytes).state.wb.rows.r1.cells.c1;
  const copies = (await (await host.fetch("/_/copies?page=doc")).json()).copies;
  expect(onDisk === "ben-q4" || copies.length > 0).toBe(true);
});

// Story: Ana resolves a conflict with "Keep current", awaits flush(), and closes her tab; flush()
// resolved before POST /_/copies/<id>/done wrote the "kept" mark, so Dana's later restore saw the
// rejected conflict open again.
// Bug it catches: plan() resolves flush() without waiting for tab.marks to drain.
// Found on clayjs 9f8b3e17 with C4p2a, C9a, X1 r1+r2 (X1 round 3, 2026-11-20).
test("flush() waits for closing decision marks before resolving", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits() } });
  useCodec(tiny);
  const base = serialize(RECORD, START);
  host.put("doc", base);
  {
    const { record, state } = parse(base);
    state.wb.rows.r2.cells.c1 = "prep";
    await host.outside("doc", serialize(record, state), "agent");
  }
  let holdCopyWrite = true;
  let anaOpen = true;
  const anaFetch = async (url, init = {}) => {
    if (!anaOpen) throw new TypeError("tab closed");
    if (holdCopyWrite && init.method === "PUT" && String(url).includes("/_/copies/")) throw new TypeError("offline");
    if (init.method === "POST" && String(url).includes("/done")) {
      const body = JSON.parse(init.body);
      if (body.kind === "kept") {
        await pause(30);
        if (!anaOpen) throw new TypeError("tab unloaded before /done completed");
      }
    }
    return host.fetch(url, init);
  };
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: anaFetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 10, maxMs: 30, waitMs: 30 });
  open.push(ana);
  await ana.ready;
  await ana.submit(set("r1", "c1", "stale-ana")).admitted;
  host.loseRoom("doc");
  await host.outside("doc", base, "restore");
  const ben = createRoomClient({ page: "doc", codec: tiny, clientId: "ben", fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 10, maxMs: 30, waitMs: 30 });
  open.push(ben);
  await ben.ready;
  await ben.submit(set("r1", "c1", "ben-winner")).admitted;
  await ben.flush();
  await ben.close();
  holdCopyWrite = false;
  await until(() => ana.notices().some((n) => n.kind === "restored" && n.conflicts.length === 1));
  const conflictNotice = ana.notices().find((n) => n.kind === "restored" && n.conflicts.length === 1);
  await ana.decide(conflictNotice.job, [["ana:1", "keep"]]);
  await inTime(ana.flush(), 2000, "flush-after-decide-drops-closing-mark: flush timed out");
  anaOpen = false;
  await ana.close();
  host.loseRoom("doc");
  const dana = createRoomClient({ page: "doc", codec: tiny, clientId: "dana", fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 10, maxMs: 30, waitMs: 30 });
  open.push(dana);
  await dana.ready;
  const [copy] = dana.copies();
  await dana.restore(copy.id);
  await until(() => dana.notices().some((n) => n.kind === "restored"));
  const danaNotice = dana.notices().find((n) => n.kind === "restored");
  expect(danaNotice.conflicts).toEqual([]);
});

// Story: Ana edits a public sheet after her login cookie expires, so POST /_/save redirects to an
// HTML login page served as 200 text/html with Express's automatic weak ETag header (W/"...");
// browser.js fell back to the weak ETag header and reported her edit as saved.
// Bug it catches: browser.js accepts non-JSON 200 save bodies or weak ETag headers as saved.
// Found on clayjs 9f8b3e17 with C4p2a, C9a, X1 r1+r2 (X1 round 3, 2026-11-20).
test("a 200 HTML login page with a weak ETag header is not reported saved", async () => {
  const URL_OF_PAGE = "https://ana.example/sheet.html";
  const pageOf = (region, etag) => `<!DOCTYPE html><html lang="en" documentetag="${etag.replace(/"/g, "&quot;")}"><head><title>Budget</title></head><body><div sheet-workbook>${region}</div></body></html>`;
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", room: false, rooms: { limits: labLimits() } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  let sessionExpired = true;
  const fetchPage = async (url, init = {}) => {
    const target = new URL(url, URL_OF_PAGE);
    if (target.href === URL_OF_PAGE) {
      const { bytes, etag } = host.file("doc");
      return new Response(pageOf(bytes, etag), { status: 200, headers: { "content-type": "text/html", etag: 'W/"served"' } });
    }
    if (target.pathname === "/_/save") {
      if (sessionExpired) {
        return new Response("<!doctype html><html><body>Please sign in</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8", etag: 'W/"2a-loginpage"' } });
      }
      const headers = init.headers?.["If-Match"] ? { "if-match": init.headers["If-Match"] } : {};
      return host.fetch("/_/save?page=doc", { method: "POST", headers, body: findRegion(init.body).inner });
    }
    return host.fetch(`${target.pathname}${target.search}`, init);
  };
  streamClosed();
  streamOpened({ clientId: "ana", lane: "live" });
  const ana = liveRoom("sheet", { codec: tiny, documentUrl: URL_OF_PAGE, fetch: fetchPage, onSaved: () => {}, discover: async () => ({ spec: 1, extensions: ["ordered-file", "recovery-copies"] }), limits: labLimits(), idleMs: 5, maxMs: 20 });
  open.push(ana);
  await ana.ready;
  const typed = ana.submit(set("r1", "c1", "important-figure"));
  let resolved = null;
  const flushed = ana.flush().then((r) => (resolved = r));
  await pause(250);
  useCodec(tiny);
  expect(resolved).toBeNull();
  expect(ana.status.pending + ana.status.unsaved > 0 || ana.status.unknownSave).toBe(true);
  expect(parse(host.file("doc").bytes).state.wb.rows.r1.cells.c1).toBe("a");
  sessionExpired = false;
  await inTime(flushed, 2000, "login-page-weak-etag-false-saved: flush did not finish once session recovered");
  expect(resolved[typed.id]).toBe("saved");
  expect(parse(host.file("doc").bytes).state.wb.rows.r1.cells.c1).toBe("important-figure");
});
