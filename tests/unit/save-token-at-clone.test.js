import { jest } from "@jest/globals";

/**
 * A save's dirty-gate token describes the page the save's clone reads.
 *
 * A save records the gate's count as its token, writes the page, and clears the gate only
 * if the count has not moved since. The count moves when the mutation hub hands an edit to
 * the gate, and the hub hands some edits out late: what the browser has queued goes out on
 * a microtask, an edit made through undo is held for one, and a save started by a change
 * subscriber has not reached the subscribers after it. A save that took its token before
 * those deliveries saw its own edit counted after the token, so it wrote everything and
 * still left `unsaved` on the root, with no clay:clean, until a second save.
 *
 * A save now runs its boundary first: the engines flush, undo closes its batch, and the hub
 * hands every subscriber what it still owes. Only then does it take its token, and the
 * clone that follows reads the same page. A save asked for while that boundary runs (an
 * [onmutation] that calls clay.save() as it is handed the edit) joins it, since the capture
 * that follows reads the page after the request.
 *
 * Every case runs the real dirty gate, mutation hub and save path, with the host answered
 * by a fetch stub. The cases with a painted value run the vendored sapjs core.
 */

let gate;
let save;
let Mutation;
let undo;
let trash;
let Sap;
let sent;
let saves;

const ROWS = `<ol><li data-id="a">a</li><li data-id="b">b</li></ol><p id="note">n</p>`;
const ONMUTATION_ROWS = `<main onmutation="clay.save()"><ol><li data-id="a">a</li><li data-id="b">b</li></ol></main><p id="note">n</p>`;
const SAP_ONMUTATION = `<main sap state="n:num" n="1" onmutation="clay.save()"><output id="next" text="state.n + 1">2</output></main><p id="note">n</p>`;
const SAP_ROWS = `<main sap><ol items="rows"><li item data-id="a" state="data-deleted-at:presence"></li><li item data-id="b" state="data-deleted-at:presence"></li></ol><output id="left" text="state.rows.filter((row) => !row.deletedAt).length">2</output></main><p id="note">n</p>`;
const SAP_ROWS_ONMUTATION = SAP_ROWS.replace("<main sap>", `<main sap onmutation="clay.save()">`);

const row = () => document.querySelector('[data-id="a"]');
const note = () => document.getElementById("note");
const root = () => document.querySelector("main");

// The order a page that switches into edit mode subscribes in: ClayJS's events and the
// sapjs core are on the page before the dirty gate starts, so [onmutation] runs first.
async function load(body, { withUndo = false, sap = false, onmutation = false } = {}) {
  jest.resetModules();
  // mutation.js publishes one hub per realm and every later module instance adopts it,
  // so a hub left by an earlier test would keep observing this test's page.
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.clay;
  delete window.Sap;
  delete window.sapPlugins;
  window.clayEditMode = true;
  window.scrollTo = () => {};
  document.documentElement.removeAttribute("unsaved");
  document.body.innerHTML = body;
  sent = [];
  saves = [];
  global.fetch = jest.fn(async (url, options = {}) => {
    if (String(url).endsWith("/_/save")) sent.push(String(options.body));
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ msg: "Saved" }) };
  });
  Mutation = (await import("../../src/lib/mutation.js")).default;
  window.clay.save = (...args) => {
    const saving = save.savePage(...args);
    saves.push(saving);
    return saving;
  };
  if (onmutation) (await import("../../src/events/onmutation.js")).init();
  if (sap) {
    window.clay.derived = (await import("../../src/lib/derived.js")).derived;
    Sap = (await import("../../src/vendor/sap-core.vendor.js")).default;
  }
  gate = await import("../../src/lib/dirty-gate.js");
  save = await import("../../src/core/save.js");
  if (withUndo) {
    const plugin = await import("../../src/plugins/undo.js");
    ({ trash } = await import("../../src/lib/trash.js"));
    undo = plugin.undo;
    window.clay.undo = undo;
    window.clay.trash = trash;
    expect(await plugin.ready).not.toBe(null);
  }
  await Promise.resolve();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
  await Promise.resolve();
}

// How many times clay:clean has come since the call.
function cleans() {
  let count = 0;
  document.addEventListener("clay:clean", () => count++);
  return () => count;
}

// What the page says once its saves have settled. The browser hands an edit to the hub on
// a microtask, so a save an [onmutation] starts exists only after one turn.
async function read(count) {
  await Promise.resolve();
  for (let i = 0; i < saves.length; i++) await saves[i];
  await Promise.resolve();
  return {
    saves: saves.length,
    sent: sent.length,
    unsaved: document.documentElement.getAttribute("unsaved"),
    cleans: count(),
    dirty: gate.pageMaybeDirty(),
  };
}

// An edit and a save in one task, the way a button's handler makes them.
async function saveAfter(edit) {
  const count = cleans();
  edit();
  const result = await window.clay.save();
  return { msg: result.msg, ...(await read(count)) };
}

const CLEAN = { msg: "Saved", saves: 1, sent: 1, unsaved: null, cleans: 1, dirty: false };

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  window.Sap?.unmount?.();
  window.clay?.undo?.stop?.();
  document.documentElement.removeAttribute("unsaved");
  delete window.clayEditMode;
  jest.restoreAllMocks();
});

test("a page without undo: a row removed and a save in the same task, the save clears unsaved and announces clay:clean", async () => {
  await load(ROWS);
  expect(await saveAfter(() => row().remove())).toEqual(CLEAN);
  expect(sent[0]).not.toContain('data-id="a"');
});

test("a page large enough to prepare its save across tasks: a row removed and a save in the same task, the save clears unsaved", async () => {
  await load(`${ROWS}<pre>${"x".repeat(320 * 1024)}</pre>`);
  const sliced = [];
  document.addEventListener("clay:snapshot-ready", (event) => sliced.push(event.detail.sliced));
  // The first save of a page has no saved size to judge and prepares in one task; the
  // second loads the preparer. The third is the one under test.
  note().setAttribute("data-first", "1");
  await window.clay.save();
  note().setAttribute("data-second", "1");
  await window.clay.save();
  saves.length = 0;
  sent.length = 0;

  expect(await saveAfter(() => row().remove())).toEqual(CLEAN);
  expect(sliced).toEqual([false, true, true]);
});

test("a page whose [onmutation] calls clay.save(), subscribed before the dirty gate: the save an edit starts clears unsaved", async () => {
  await load(ONMUTATION_ROWS, { onmutation: true });
  const count = cleans();
  row().remove();
  expect(await read(count)).toEqual({ saves: 1, sent: 1, unsaved: null, cleans: 1, dirty: false });
  expect(sent[0]).not.toContain('data-id="a"');
});

test("a [sap] page whose [onmutation] calls clay.save(), subscribed before the dirty gate: the save holds the painted value and clears unsaved", async () => {
  await load(SAP_ONMUTATION, { sap: true, onmutation: true });
  const count = cleans();
  root().setAttribute("n", "4");
  expect(await read(count)).toEqual({ saves: 1, sent: 1, unsaved: null, cleans: 1, dirty: false });
  expect(sent[0]).toContain(">5</output>");
});

test("a row moved to the trash, a status line written and a save in the same task: the save holds both and clears unsaved", async () => {
  await load(ROWS, { withUndo: true });
  expect(await saveAfter(() => {
    trash(row());
    note().textContent = "Deleted";
  })).toEqual(CLEAN);
  expect(sent[0]).toContain('data-id="a" data-deleted-at="');
  expect(sent[0]).toContain(">Deleted</p>");
});

test("Sap.batch and a save in the same task, on a page the sapjs core paints: the save holds the new count and clears unsaved", async () => {
  await load(SAP_ROWS, { withUndo: true, sap: true });
  expect(await saveAfter(() => {
    Sap.batch("Archive", () => row().setAttribute("data-deleted-at", "2026-11-15"));
  })).toEqual(CLEAN);
  expect(sent[0]).toContain(">1</output>");
});

// An awaited save, the saves that joined it, and what the page says once it has settled.
// The joined saves are read through their answers, not awaited: one the page never answers
// shows up here instead of holding the test.
async function saveJoined(edit) {
  const count = cleans();
  const captures = [];
  document.addEventListener("clay:snapshot-ready", (event) => captures.push(event.detail.captureId));
  const answers = [];
  edit();
  const awaited = window.clay.save();
  for (const saving of saves) saving.then((result) => answers.push(result.msg));
  const result = await awaited;
  await Promise.resolve();
  await Promise.resolve();
  return {
    msg: result.msg,
    saves: saves.length,
    sent: sent.length,
    unsaved: document.documentElement.getAttribute("unsaved"),
    cleans: count(),
    dirty: gate.pageMaybeDirty(),
    answers,
    captures,
  };
}

const JOINED = { msg: "Saved", saves: 2, sent: 1, unsaved: null, cleans: 1, dirty: false, answers: ["Saved", "Saved"], captures: [expect.any(Number)] };

test("a row moved to the trash and an awaited save, on a [sap] page whose [onmutation] saves too: the awaited save writes, and the [onmutation] save joins it", async () => {
  await load(SAP_ROWS_ONMUTATION, { withUndo: true, sap: true, onmutation: true });
  expect(await saveJoined(() => trash(row()))).toEqual(JOINED);
  expect(sent[0]).toContain(">1</output>");
});

test("an edit and an awaited save on a page whose [onmutation] saves too: the [onmutation] save joins the awaited one, and the next save runs on its own", async () => {
  await load(ONMUTATION_ROWS, { onmutation: true });
  const joined = await saveJoined(() => row().remove());
  expect(joined).toEqual(JOINED);

  note().setAttribute("data-next", "1");
  const next = window.clay.save();
  expect(joined.captures).toHaveLength(2);
  expect((await next).msg).toBe("Saved");
  expect(sent[1]).toContain('data-next="1"');
});

test("a change subscriber that writes when it is handed an edit: the save holds that write and clears unsaved", async () => {
  await load(ROWS);
  Mutation.onAnyChange({}, () => {
    if (!note().hasAttribute("data-seen")) note().setAttribute("data-seen", "1");
  });
  expect(await saveAfter(() => row().remove())).toEqual(CLEAN);
  expect(sent[0]).toContain('data-seen="1"');
});

test("an edit made after clay.save() returned is not in the bytes it wrote and keeps the page dirty", async () => {
  await load(ROWS);
  const count = cleans();
  row().remove();
  const saving = window.clay.save();
  note().setAttribute("data-late", "1");
  await saving;

  expect(sent[0]).not.toContain("data-late");
  expect(await read(count)).toEqual({ saves: 1, sent: 1, unsaved: "true", cleans: 0, dirty: true });
});

test("a save on a page with no edit sends nothing, as before", async () => {
  await load(ROWS, { withUndo: true });
  const result = await window.clay.save();
  expect({ msg: result.msg, sent: sent.length, dirty: gate.pageMaybeDirty() }).toEqual({ msg: "No changes to save", sent: 0, dirty: false });
});

test("a draft token taken right after an edit made through the trash: the edit is counted before the token, so the page reads unchanged after it", async () => {
  await load(ROWS, { withUndo: true });
  trash(row());
  const token = gate.gateTokenNow();
  await Promise.resolve();
  await Promise.resolve();
  expect(gate.gateUnchangedSince(token)).toBe(true);
});

test("a subscriber to added and removed elements that writes when an [onmutation] save is started: the save holds that write and clears unsaved", async () => {
  await load(ONMUTATION_ROWS, { onmutation: true });
  Mutation.onAddOrRemove({}, () => {
    if (!note().hasAttribute("data-stamped")) note().setAttribute("data-stamped", "1");
  });
  const count = cleans();
  root().appendChild(document.createElement("p"));
  expect(await read(count)).toEqual({ saves: 1, sent: 1, unsaved: null, cleans: 1, dirty: false });
  expect(sent[0]).toContain('data-stamped="1"');
});

test("a change subscriber handed clay.save itself: the save it asks for inside a running save joins it and settles", async () => {
  await load(ROWS);
  Mutation.onAnyChange({}, window.clay.save);
  const count = cleans();
  row().remove();
  const result = await window.clay.save();
  const settled = await Promise.race([Promise.all(saves).then(() => "settled"), new Promise((done) => setTimeout(() => done("hung"), 50))]);
  expect([result.msg, settled, (await read(count)).unsaved]).toEqual(["Saved", "settled", null]);
});

test("an explicit save asked for inside an automatic save's boundary makes it write an edit only an explicit save writes", async () => {
  await load(`<main onmutation="clay.save()"><div no-trigger-autosave><p id="quiet">q</p></div></main><p id="note">n</p>`, { onmutation: true });
  document.getElementById("quiet").textContent = "typed";
  const result = await save.savePageThrottled();
  await read(cleans());
  expect([result.msg, sent.length, sent[0] ?? ""].map((v, i) => (i === 2 ? v.includes(">typed</p>") : v))).toEqual(["Saved", 1, true]);
});
