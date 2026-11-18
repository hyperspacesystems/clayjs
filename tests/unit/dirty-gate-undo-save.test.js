import { jest } from "@jest/globals";

/**
 * An edit made through undo, and a save in the same task, leave the page clean.
 *
 * clay.undo.commit, clay.undo.command, clay.trash and an undo or redo mark the page
 * dirty as they return (gateMarkDirty), because a sync frame's apply may hold the
 * mutation hub and the gate paused while they write. The hub hands the change lane its
 * copy of the same records only on a later microtask. Counted there, after the token a
 * save in the same task took, the edit kept the page dirty after the save that wrote it:
 * `unsaved` stayed on the root and clay:clean never came. A save now has the hub hand
 * those records out before it takes its token, so the gate counts them before it.
 *
 * Every case runs the real dirty gate, mutation hub, undo plugin and save path, with
 * the host answered by a fetch stub.
 */

let gate;
let save;
let Mutation;
let undo;
let trash;
let sent;

const ROWS = `<ol><li data-id="a">a</li><li data-id="b">b</li></ol><p id="note">n</p>`;
// The same rows on a page the sapjs core paints: the number of rows not in the trash.
const SAP_ROWS = `<main sap><ol items="rows"><li item data-id="a" state="data-deleted-at:presence"></li><li item data-id="b" state="data-deleted-at:presence"></li></ol><output id="left" text="state.rows.filter((row) => !row.deletedAt).length">2</output></main><p id="note">n</p>`;
const row = () => document.querySelector('[data-id="a"]');
const note = () => document.getElementById("note");

async function load({ withUndo = true, sap = false } = {}) {
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
  document.body.innerHTML = sap ? SAP_ROWS : ROWS;
  sent = [];
  global.fetch = jest.fn(async (url, options = {}) => {
    if (String(url).endsWith("/_/save")) sent.push(String(options.body));
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ msg: "Saved" }) };
  });
  Mutation = (await import("../../src/lib/mutation.js")).default;
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
  if (sap) {
    window.clay.derived = (await import("../../src/lib/derived.js")).derived;
    (await import("../../src/vendor/sap-core.vendor.js")).default.mount(document.querySelector("main"));
  }
  await Promise.resolve();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
  await Promise.resolve();
}

// What the root says once a save has settled: the attribute, how many times clay:clean
// came, and whether the gate still holds work.
async function saveAndRead(run) {
  let cleans = 0;
  const onClean = () => cleans++;
  document.addEventListener("clay:clean", onClean);
  try {
    run();
    const result = await save.savePage();
    await Promise.resolve();
    return {
      msg: result.msg,
      saves: sent.length,
      unsaved: document.documentElement.getAttribute("unsaved"),
      cleans,
      dirty: gate.pageMaybeDirty(),
    };
  } finally {
    document.removeEventListener("clay:clean", onClean);
  }
}

const CLEAN = { msg: "Saved", saves: 1, unsaved: null, cleans: 1, dirty: false };

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

test("a row moved to the trash, then a save in the same task: the save clears unsaved and announces clay:clean", async () => {
  await load();
  const read = await saveAndRead(() => trash(row()));
  expect(read).toEqual(CLEAN);
  expect(sent[0]).toContain('data-id="a" data-deleted-at="');
});

test("on a page the sapjs core paints, a row moved to the trash, then a save in the same task: the save holds the new count and clears unsaved", async () => {
  await load({ sap: true });
  const read = await saveAndRead(() => trash(row()));
  expect(read).toEqual(CLEAN);
  expect(sent[0]).toContain(">1</output>");
});

test("an edit made through clay.undo.commit, then a save in the same task: the save clears unsaved and announces clay:clean", async () => {
  await load();
  const read = await saveAndRead(() => undo.commit("Rename", () => { note().textContent = "renamed"; }));
  expect(read).toEqual(CLEAN);
  expect(sent[0]).toContain(">renamed</p>");
});

test("an edit made through clay.undo.command, then a save in the same task: the save clears unsaved and announces clay:clean", async () => {
  await load();
  const read = await saveAndRead(() => undo.command("Flag", () => note().setAttribute("data-flag", "1")));
  expect(read).toEqual(CLEAN);
  expect(sent[0]).toContain('data-flag="1"');
});

test("an undo, then a save in the same task: the save clears unsaved and announces clay:clean", async () => {
  await load();
  undo.commit("Rename", () => { note().textContent = "renamed"; });
  await save.savePage();
  await Promise.resolve();
  const read = await saveAndRead(() => undo.undo());
  expect(read).toEqual({ ...CLEAN, saves: 2 });
  expect(sent[1]).toContain(">n</p>");
});

test("an edit made after the save's capture and held with the undo edit keeps the page dirty", async () => {
  await load();
  trash(row());
  const saving = save.savePage();
  note().setAttribute("data-late", "1");
  undo.flush();
  await saving;
  await Promise.resolve();

  expect(sent[0]).not.toContain("data-late");
  expect({ unsaved: document.documentElement.getAttribute("unsaved"), dirty: gate.pageMaybeDirty() }).toEqual({ unsaved: "true", dirty: true });
});

test("an edit held after an earlier undo edit was delivered still counts", async () => {
  await load();
  trash(row());
  await Promise.resolve();
  const before = gate.gateRevision();
  note().setAttribute("data-later", "1");
  undo.flush();
  await Promise.resolve();
  expect(gate.gateRevision() - before).toBe(1);
});

test("an edit made through undo reaches the page's change subscribers inside clay.save(), before the save reads the page, and once", async () => {
  await load();
  const batches = [];
  Mutation.onAnyChange({}, (changes) => batches.push(changes.length));
  trash(row());
  const saving = save.savePage();
  const inSave = batches.length;
  await saving;
  expect({ inSave, after: batches.length }).toEqual({ inSave: 1, after: 1 });
});

test("a page without undo: an edit reaches the page's change subscribers inside clay.save(), before the save reads the page, and once", async () => {
  await load({ withUndo: false });
  const batches = [];
  Mutation.onAnyChange({}, (changes) => batches.push(changes.length));
  note().setAttribute("data-plain", "1");
  const saving = save.savePage();
  const inSave = batches.length;
  await saving;
  expect({ inSave, after: batches.length, sent: sent[0].includes('data-plain="1"') }).toEqual({ inSave: 1, after: 1, sent: true });
});
