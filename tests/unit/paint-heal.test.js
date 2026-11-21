import { jest } from "@jest/globals";
import { SAVE_TOKEN_ATTRS } from "../../src/lib/root-attrs.js";

/**
 * A repaint that leaves the file stale saves once (save.js, schedulePaintHeal).
 *
 * The sapjs core paints derived values from the page's records. A writer that
 * changes a record without painting it — an agent through the data API — leaves
 * the file's painted output stale while the page repaints it correctly. Nothing
 * counts that as an edit, so no tab would ever save and the bytes on disk stay
 * wrong forever. schedulePaintHeal compares the file's painted values with the
 * page's once the page has settled, and one clean autosaving tab saves.
 *
 * The page under test declares one item whose `state` is "accepted"; the file on
 * disk still carries `data-state="waiting"`, the stale paint. Every test loads
 * fresh modules: the settle, the autosave decision and the paint-heal timer are
 * one-time state per save.js instance.
 */

const MARK = '<meta name="clay-stale" clay="no-save">';

const PAGE = `<main sap><ul items="steps"><li item class="step" attr:data-state="item.state"><span class="state" bind="state">accepted</span></li></ul></main>`;
const STALE_PAGE = PAGE.replace(
  `<li item class="step" attr:data-state="item.state">`,
  `<li item class="step" attr:data-state="item.state" data-state="waiting">`
);
const doc = (page) => `<!DOCTYPE html><html autosave><head></head><body>${page}</body></html>`;
const STALE_FILE = doc(STALE_PAGE);
const PAINTED_FILE = STALE_FILE.replace(`data-state="waiting"`, `data-state="accepted"`);
// The same file with the record text still at the old value: an agent that wrote
// the record and painted nothing leaves the file's painted value alone.
const WAITING_FILE = doc(
  STALE_PAGE.replace(`>accepted</span>`, `>waiting</span>`)
);
// A writer that paints: the frame carries a painted value of its own and a record
// of its own, so the page's repaint and the file's paint are the writer's business.
const WRITER_FILE = doc(
  STALE_PAGE.replace(`>accepted</span>`, `>done</span>`).replace(`data-state="waiting"`, `data-state="accepted"`)
);

class FakeEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
  }
  close() {}
}

let save;
let snapshot;
let derivedLib;
let Sap;
let saves;
let saveHeaders;
let notes;
let saveStatus;
let saveRefusal;
let hostConditional;

function mockFetch() {
  const runSaves = saves;
  const runHeaders = saveHeaders;
  const runNotes = notes;
  return jest.fn(async (url, init = {}) => {
    if (init.method === "POST" && /\/_\/recalc\//.test(String(url))) {
      runNotes.push(JSON.parse(init.body));
      return { ok: true, status: 204, statusText: "No Content", headers: new Headers(), text: async () => "" };
    }
    if (init.method === "GET" && /\/_\/meta(\/|$)/.test(String(url))) {
      if (!hostConditional) {
        return { ok: false, status: 404, statusText: "Not Found", headers: new Headers(), text: async () => "" };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: async () => JSON.stringify({ spec: 1, extensions: ["conditional"] }),
      };
    }
    if (init.method === "POST" && /\/_\/save/.test(String(url))) {
      runSaves.push(init.body);
      runHeaders.push(new Headers(init.headers));
      if (saveRefusal) {
        const { status, code } = saveRefusal;
        return {
          ok: false,
          status,
          statusText: "Refused",
          headers: new Headers(),
          text: async () => JSON.stringify({ code, msg: "x" }),
        };
      }
      if (saveStatus === 412) {
        return {
          ok: false,
          status: 412,
          statusText: "Precondition Failed",
          headers: new Headers(),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: async () => JSON.stringify({ msg: "Saved" }),
      };
    }
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: new Headers(),
      text: async () => "",
      json: async () => ({}),
    };
  });
}

async function load({ autosave = true, body = PAGE, draft = false, head = "", engine = true, settle = true } = {}) {
  jest.resetModules();
  // mutation.js publishes a realm-global hub on window.__clayMutation and every
  // later module instance adopts it, so without this the fresh registry would
  // register on the FIRST test's hub. That hub still observes the document, and
  // its subscribers (save.js's settle, autosave's debounce) would save THIS
  // test's page into this test's fetch mock, so it is disconnected first.
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.clay;
  if (draft) {
    // A visitor's tab: a draft slot and rules, no owner, no save token.
    delete window.clayEditMode;
    document.documentElement.setAttribute("visitor-drafts", "heal-draft");
    document.head.innerHTML =
      `<script type="application/json" data-rules-name="api" data-rules-version="1">{}</script>`;
    (await import("../../src/core/draft-mode.js")).noteBootParams(new URLSearchParams("plugins=visitor-drafts"));
  } else {
    document.documentElement.removeAttribute("visitor-drafts");
    document.head.innerHTML = head;
    window.clayEditMode = true;
  }
  window.scrollTo = () => {};
  global.EventSource = window.EventSource = FakeEventSource;
  if (autosave) document.documentElement.setAttribute("autosave", "");
  else document.documentElement.removeAttribute("autosave");
  global.fetch = mockFetch();

  // Imported before the page exists, so the engine's own DOM-ready mount finds no
  // root: this file mounts by hand, the way the loader's mount phase does.
  document.body.innerHTML = "";
  Sap = (await import("../../src/vendor/sap-core.vendor.js")).default;
  Sap._reset();

  const { bootPhase } = await import("../../src/core/boot-phase.js");
  bootPhase.holdSettle = true;
  document.body.innerHTML = body;
  save = await import("../../src/core/save.js");
  snapshot = await import("../../src/core/snapshot.js");
  derivedLib = await import("../../src/lib/derived.js");
  const Mutation = (await import("../../src/lib/mutation.js")).default;
  window.clay = { ...(window.clay || {}), derived: derivedLib.derived, Mutation };
  // Decides autosaveActive() from <html autosave>, as the loader's boot does.
  await import("../../src/core/autosave.js");

  Sap.mount(document.querySelector("[sap]"));
  // The real boot sets clay.derived before sapjs looks it up, so sapjs registers as
  // the page's derive engine. Here sapjs was imported first; register it the same way.
  if (engine) derivedLib.derived.register(() => {});
  if (settle) save.releaseBootSettle();
  await Promise.resolve();
}

const staleSignature = () => derivedLib.paintSignatureOfHtml(STALE_FILE);
const paintedSignature = () => derivedLib.paintSignatureOfHtml(PAINTED_FILE);
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
const liveTimers = new Set();

beforeAll(() => {
  global.setTimeout = (fn, ms, ...args) => {
    const id = realSetTimeout(() => {
      liveTimers.delete(id);
      fn(...args);
    }, ms);
    liveTimers.add(id);
    return id;
  };
  global.clearTimeout = (id) => {
    liveTimers.delete(id);
    return realClearTimeout(id);
  };
});

afterAll(() => {
  for (const id of liveTimers) realClearTimeout(id);
  liveTimers.clear();
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
});

beforeEach(() => {
  saves = [];
  saveHeaders = [];
  notes = [];
  saveStatus = 200;
  saveRefusal = null;
  hostConditional = false;
  localStorage.clear();
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  for (const id of liveTimers) realClearTimeout(id);
  liveTimers.clear();
  jest.restoreAllMocks();
  document.documentElement.removeAttribute("savetoken");
});

test("the page's painted values differ from a stale file's and match a painted one", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load();
  const live = save.currentPaintSignature();

  expect(staleSignature()).not.toBe(live);
  expect(paintedSignature()).toBe(live);

  // Editor UI is not saved with the file, so what it paints is not the page's.
  document.body.insertAdjacentHTML(
    "beforeend",
    `<aside clay="editor-ui"><div sap><p class="badge" attr:data-state="'editor'">hint</p></div></aside>`
  );
  Sap.mount(document.querySelector('[clay="editor-ui"] [sap]'));
  await Promise.resolve();
  expect(document.querySelector(".badge").getAttribute("data-state")).toBe("editor");

  expect(save.currentPaintSignature()).toBe(live);
});

test("a stale file heals with one save", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load();

  save.schedulePaintHeal(staleSignature());
  jest.advanceTimersByTime(1600);
  await flush();

  expect(saves.length).toBe(1);
  expect(saves[0]).toContain('data-state="accepted"');
});

test("a file whose painted values already match the page is not saved", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load();

  save.schedulePaintHeal(paintedSignature());
  jest.advanceTimersByTime(1600);
  await flush();

  expect(saves).toEqual([]);
});

test("a marked file whose painted values already match still saves once, without the mark", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load({ head: MARK });

  // The bug this guards: the heal skips a marked file whose values match, so the mark stays forever.
  save.schedulePaintHeal(paintedSignature(), { marked: true });
  jest.advanceTimersByTime(1600);
  await flush();

  expect(saves.length).toBe(1);
  expect(saves[0]).not.toContain("clay-stale");
});

test("a marked heal survives a later unmarked reschedule", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load({ head: MARK });

  // The bug this guards: the reschedule drops the mark.
  save.schedulePaintHeal(paintedSignature(), { marked: true });
  save.schedulePaintHeal(paintedSignature());
  jest.advanceTimersByTime(1600);
  await flush();

  expect(saves.length).toBe(1);
});

test("a marked page with no file signature still saves once", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load({ head: MARK });

  // The bug this guards: a page without sapjs never clears the mark.
  save.schedulePaintHeal(null, { marked: true });
  jest.advanceTimersByTime(1600);
  await flush();

  expect(saves.length).toBe(1);
});

test("a marked heal never saves a dirty page", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  jest.spyOn(Math, "random").mockReturnValue(0);
  await load({ head: MARK });

  document.querySelector(".state").textContent = "edited by hand";
  await Promise.resolve();
  expect(snapshot.captureForDirtyCheck()).not.toBe(save.getLastSavedDirty());

  // The bug this guards: a marked heal saves the page and drops the person's edit.
  save.schedulePaintHeal(paintedSignature(), { marked: true });
  jest.advanceTimersByTime(300);
  await flush();

  expect(saves).toEqual([]);
});

test("a marked heal needs autosave", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load({ autosave: false, head: MARK });

  // The bug this guards: the mark's save ignores the autosave guard.
  save.schedulePaintHeal(paintedSignature(), { marked: true });
  jest.advanceTimersByTime(1600);
  await flush();

  expect(saves).toEqual([]);
});

test("a marked heal saves again on the next marked file", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  jest.spyOn(Math, "random").mockReturnValue(0);
  await load({ head: MARK });
  save.schedulePaintHeal(paintedSignature(), { marked: true });
  jest.advanceTimersByTime(400);
  await flush();
  expect(saves.length).toBe(1);

  // The same file version marked again, in the same browser: a new module instance.
  await load({ head: MARK });
  save.schedulePaintHeal(paintedSignature(), { marked: true });
  jest.advanceTimersByTime(400);
  await flush();
  // The bug this guards: the localStorage once-per-version memo blocks the second heal.
  expect(saves.length).toBe(2);
});

test("a dirty page is not saved by the heal", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  // 250 ms: short enough that autosave's own 1500 ms debounce is still pending,
  // so every POST counted here would be the heal's.
  jest.spyOn(Math, "random").mockReturnValue(0);
  await load();

  document.querySelector(".state").textContent = "edited by hand";
  await Promise.resolve();
  expect(snapshot.captureForDirtyCheck()).not.toBe(save.getLastSavedDirty());

  save.schedulePaintHeal(staleSignature());
  jest.advanceTimersByTime(300);
  await flush();

  expect(saves).toEqual([]);
});

test("without <html autosave> the heal never saves", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load({ autosave: false });

  save.schedulePaintHeal(staleSignature());
  jest.advanceTimersByTime(1600);
  await flush();

  expect(saves).toEqual([]);
});

test("a null file signature never saves", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load();

  save.schedulePaintHeal(() => null);
  jest.advanceTimersByTime(1600);
  await flush();

  expect(saves).toEqual([]);
});

test("three schedules in a row heal once", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load();

  save.schedulePaintHeal(staleSignature());
  save.schedulePaintHeal(staleSignature());
  save.schedulePaintHeal(staleSignature());
  jest.advanceTimersByTime(1600);
  await flush();

  expect(saves.length).toBe(1);
});

test("in draft mode the heal never saves", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load({ draft: true });
  // Where a draft save would go, had one been made.
  const draftSaves = [];
  const draftMode = await import("../../src/core/draft-mode.js");
  draftMode.setDraftTransport((html) => draftSaves.push(html));

  save.schedulePaintHeal(staleSignature());
  jest.advanceTimersByTime(1600);
  await flush();

  // A visitor's draft is their own work, not a repair of the file on disk.
  expect(draftSaves).toEqual([]);
  expect(saves).toEqual([]);
});

test("a heal tick on a dirty page never flushes the undo batch", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  // 250 ms: short enough that autosave's own 1500 ms debounce is still pending.
  jest.spyOn(Math, "random").mockReturnValue(0);
  await load();

  document.querySelector(".state").textContent = "edited by hand";
  await Promise.resolve();
  expect(snapshot.captureForDirtyCheck()).not.toBe(save.getLastSavedDirty());

  window.clay.undo = { flush: jest.fn() };
  save.schedulePaintHeal(staleSignature());
  jest.advanceTimersByTime(300);
  await flush();

  expect(window.clay.undo.flush).not.toHaveBeenCalled();
  expect(saves).toEqual([]);
});

test("a heal save the host refuses stays quiet, and a normal save still conflicts", async () => {
  // Real timers: the heal is a real 250 ms wait (Math.random pinned to 0).
  jest.spyOn(Math, "random").mockReturnValue(0);
  await load();
  saveStatus = 412;
  const savedEvents = [];
  document.addEventListener("clay:save-saved", (e) => savedEvents.push(e));

  save.schedulePaintHeal(staleSignature());
  await tick(400);
  await flush();

  expect(saves.length).toBe(1);
  // The tab was clean: a refusal of its heal is not a conflict to resolve, and
  // autosave keeps running. The other tab's save reaches it through sync.
  expect(save.isSaveConflicted()).toBe(false);
  expect(save.autosaveIsSuspended()).toBe(false);
  expect(document.documentElement.getAttribute("savestatus")).toBe("saved");
  // Nothing landed, so nothing announces a save.
  expect(savedEvents).toEqual([]);

  // A save the person asked for is still a conflict when it is refused.
  await save.savePageForce();
  expect(save.isSaveConflicted()).toBe(true);
});

test("one heal per file version per browser", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  // 250 ms per heal, under autosave's own 1500 ms debounce, so a second load in
  // this test cannot leave the first instance's autosave pending.
  jest.spyOn(Math, "random").mockReturnValue(0);
  await load();
  save.schedulePaintHeal(staleSignature());
  jest.advanceTimersByTime(400);
  await flush();
  expect(saves.length).toBe(1);

  // The same file version opened again: a new module instance, the same browser.
  await load();
  save.schedulePaintHeal(staleSignature());
  jest.advanceTimersByTime(400);
  await flush();
  expect(saves.length).toBe(1);

  // A file version this browser has not healed yet is saved again.
  await load();
  save.schedulePaintHeal(staleSignature() + "|another");
  jest.advanceTimersByTime(400);
  await flush();
  expect(saves.length).toBe(2);
});

test("a disk frame that leaves the file stale heals with one save", async () => {
  // Real timers: the disk lane awaits a 0 ms timer inside the apply, and the
  // heal itself is a real 250 ms wait (Math.random pinned to 0).
  jest.spyOn(Math, "random").mockReturnValue(0);
  await load();

  const { LiveSync } = await import("../../src/sync/live-sync.js");
  const sync = new LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  sync._setDiskBase(WAITING_FILE, sync._ticket());

  // What an agent writing records leaves: the record text moves, the paint does
  // not.
  await sync._doApplyExternal(STALE_FILE, 11, "disk-1");
  await tick(400);

  expect(saves.length).toBe(1);
  expect(saves[0]).toContain('data-state="accepted"');

  // A writer that paints: its frame carries a painted value and a record of its
  // own, so this tab does not heal over it.
  await sync._doApplyExternal(WRITER_FILE, 12, "disk-2");
  await tick(400);

  expect(saves.length).toBe(1);
  sync.stop();
});

// Bug guarded: the tab waits for the heal timer, or saves twice.
test("a waited write's frame saves at once, built on the written version", async () => {
  jest.spyOn(Math, "random").mockReturnValue(0);
  hostConditional = true;
  await load();
  document.documentElement.setAttribute(SAVE_TOKEN_ATTRS[0], "tok");
  await (await import("../../src/core/etag.js")).learnConditionalSaves();

  const { LiveSync } = await import("../../src/sync/live-sync.js");
  const sync = new LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  sync._setDiskBase(WAITING_FILE, sync._ticket());

  await sync._doApplyExternal(STALE_FILE, 11, "disk-1", null, null, { id: "r1", etag: "disk-1" });
  await tick(50);

  expect(saves.length).toBe(1);
  expect(saveHeaders[0].get("If-Match")).toBe("disk-1");
  expect(notes).toEqual([]);

  await tick(2000);
  expect(saves.length).toBe(1);
  sync.stop();
});

// Bug guarded: the writer waits the full limit for a tab that will never save.
test("a tab with autosave off says busy", async () => {
  jest.spyOn(Math, "random").mockReturnValue(0);
  hostConditional = true;
  await load({ autosave: false });
  document.documentElement.setAttribute(SAVE_TOKEN_ATTRS[0], "tok");
  await (await import("../../src/core/etag.js")).learnConditionalSaves();

  const { LiveSync } = await import("../../src/sync/live-sync.js");
  const sync = new LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  sync._setDiskBase(WAITING_FILE, sync._ticket());

  await sync._doApplyExternal(STALE_FILE, 11, "disk-1", null, null, { id: "r1", etag: "disk-1" });
  await tick(50);

  expect(saves).toEqual([]);
  expect(notes).toEqual([{ id: "r1", etag: "disk-1", status: "busy" }]);
  sync.stop();
});

// Bug guarded: a save without If-Match that the host cannot match (or an untagged
// last-write-wins save).
test("a tab that has not learned conditional saves says busy", async () => {
  jest.spyOn(Math, "random").mockReturnValue(0);
  await load();
  document.documentElement.setAttribute(SAVE_TOKEN_ATTRS[0], "tok");

  const { LiveSync } = await import("../../src/sync/live-sync.js");
  const sync = new LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  sync._setDiskBase(WAITING_FILE, sync._ticket());

  await sync._doApplyExternal(STALE_FILE, 11, "disk-1", null, null, { id: "r1", etag: "disk-1" });
  await tick(50);

  expect(saves).toEqual([]);
  expect(notes).toEqual([{ id: "r1", etag: "disk-1", status: "busy" }]);

  // A busy tab still heals the file later, as a frame without the request would.
  await tick(400);
  expect(saves.length).toBe(1);
  sync.stop();
});

// Bug guarded: the writer's own tab deadlocks on itself; and, once its write is done, never
// heals the file, so it stays stale until a reload.
test("a tab holding its saves for its own data write says busy", async () => {
  jest.spyOn(Math, "random").mockReturnValue(0);
  hostConditional = true;
  await load();
  document.documentElement.setAttribute(SAVE_TOKEN_ATTRS[0], "tok");
  await (await import("../../src/core/etag.js")).learnConditionalSaves();
  save.holdAllSaves();

  const { LiveSync } = await import("../../src/sync/live-sync.js");
  const sync = new LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  sync._setDiskBase(WAITING_FILE, sync._ticket());

  await sync._doApplyExternal(STALE_FILE, 11, "disk-1", null, null, { id: "r1", etag: "disk-1" });
  await tick(50);

  expect(saves).toEqual([]);
  expect(notes).toEqual([{ id: "r1", etag: "disk-1", status: "busy" }]);

  save.releaseAllSaves();
  await tick(400);
  expect(saves.length).toBe(1);
  sync.stop();
});

// Bug guarded: a lost race shows the person an error toast.
test("a refused recalculation save shows no error", async () => {
  jest.spyOn(Math, "random").mockReturnValue(0);
  hostConditional = true;
  await load();
  document.documentElement.setAttribute(SAVE_TOKEN_ATTRS[0], "tok");
  await (await import("../../src/core/etag.js")).learnConditionalSaves();
  saveRefusal = { status: 409, code: "not-next-commit" };

  const { LiveSync } = await import("../../src/sync/live-sync.js");
  const sync = new LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  sync._setDiskBase(WAITING_FILE, sync._ticket());

  await sync._doApplyExternal(STALE_FILE, 11, "disk-1", null, null, { id: "r1", etag: "disk-1" });
  await tick(50);

  expect(saves.length).toBe(1);
  expect(document.documentElement.getAttribute("savestatus")).toBe("saved");
  sync.stop();
});

const NOTE = `<p class="note">hello</p>`;
const withNote = (file) => file.replace("</body>", `${NOTE}</body>`);

// Bug guarded: the tab posted busy over its own in-flight merge save, so the host
// answered no-browser while fresh values were landing.
test("a tab whose merge save is on its way posts no busy note", async () => {
  jest.spyOn(Math, "random").mockReturnValue(0);
  hostConditional = true;
  await load({ body: PAGE + NOTE });
  document.documentElement.setAttribute(SAVE_TOKEN_ATTRS[0], "tok");
  await (await import("../../src/core/etag.js")).learnConditionalSaves();

  const { LiveSync } = await import("../../src/sync/live-sync.js");
  const sync = new LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  sync._setDiskBase(withNote(WAITING_FILE), sync._ticket());

  // Hold the merge's save on the wire until recalculateNow has checked isSaveInProgress(),
  // so timing under load never lets the merge save settle first and trigger a second save.
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const inner = global.fetch;
  global.fetch = jest.fn(async (url, init = {}) => {
    if (init.method === "POST" && /\/_\/save/.test(String(url))) await saveGate;
    return inner(url, init);
  });

  document.querySelector(".note").textContent = "typed by person";
  await Promise.resolve();

  await sync._doApplyExternal(withNote(STALE_FILE), 11, "disk-1", null, null, { id: "r1", etag: "disk-1" });
  await tick(50);
  releaseSave();
  await tick(50);

  expect(saves).toHaveLength(1);
  expect(saves[0]).toContain("typed by person");
  expect(saveHeaders[0].get("If-Match")).toBe("disk-1");
  expect(notes).toEqual([]);
  sync.stop();
});

const DRAFT = `<p class="draft" no-trigger-autosave>draft</p>`;
const withDraft = (file) => file.replace("</body>", `${DRAFT}</body>`);

// Bug guarded: an unsubmitted draft is written to disk without the person saving it.
test("a dirty tab is not force-saved for a waiting write", async () => {
  jest.spyOn(Math, "random").mockReturnValue(0);
  hostConditional = true;
  await load({ body: PAGE + DRAFT });
  document.documentElement.setAttribute(SAVE_TOKEN_ATTRS[0], "tok");
  await (await import("../../src/core/etag.js")).learnConditionalSaves();

  const { LiveSync } = await import("../../src/sync/live-sync.js");
  const sync = new LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  sync._setDiskBase(withDraft(WAITING_FILE), sync._ticket());

  document.querySelector(".draft").textContent = "typed by person";
  await Promise.resolve();

  await sync._doApplyExternal(withDraft(STALE_FILE), 11, "disk-1", null, null, { id: "r1", etag: "disk-1" });
  await tick(400);

  expect(saves.filter((body) => body.includes("typed by person"))).toEqual([]);
  expect(notes).toEqual([{ id: "r1", etag: "disk-1", status: "busy" }]);
  sync.stop();
});

// Bug guarded: a page that computes only on input (<form oninput>) never recalculated,
// yet its save cleared the mark, so a read returned the old value as fresh.
test("a marked page with no derive engine and no clay.effect keeps the mark", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  await load({ head: MARK, engine: false });

  save.schedulePaintHeal(null, { marked: true });
  jest.advanceTimersByTime(1600);
  await flush();

  expect(saves).toEqual([]);
});

// Bug guarded: a page without sapjs settles its baseline up to 3 s after boot, and a
// marked heal that fired first gave up, so the mark stayed.
test("a marked heal scheduled before the baseline settles saves once it settles", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask", "nextTick"] });
  // A page without sapjs whose clay.effect recalculates it.
  await load({ head: MARK, settle: false, engine: false, body: `<main><output id="sum">3</output></main>` });
  const { effect } = await import("../../src/lib/effect.js");
  const stopEffect = effect(() => {});

  save.schedulePaintHeal(null, { marked: true });
  jest.advanceTimersByTime(1600);
  await flush();
  expect(save.baselineSettled()).toBe(false);
  expect(saves).toEqual([]);

  save.releaseBootSettle();
  jest.advanceTimersByTime(3100);
  await flush();
  expect(save.baselineSettled()).toBe(true);
  expect(saves.length).toBe(1);
  expect(saves[0]).not.toContain("clay-stale");
  expect(saves[0]).toContain('<output id="sum">3</output>');
  stopEffect();
});
