import { jest } from "@jest/globals";

/**
 * An edit made through undo and a save in the same task, on a page a derive engine
 * paints.
 *
 * clay.undo.commit, clay.undo.command and clay.trash read the edit's records through
 * the mutation hub's raw lane. The hub hands the change lane its copy of those records
 * only on a later microtask, so no subscriber runs inside undo's commit. The sapjs
 * engine learns of edits from the change lane, so when the save's flush runs it has not
 * heard of the edit yet. A save boundary therefore hands the change lane what the hub
 * still holds before the engines flush (Mutation.deliverDeferred), and only on a page
 * whose engine gave a flush. A save hands it over again before it takes its dirty-gate
 * token, on every page (save-token-at-clone.test.js); the cases here take the capture
 * alone, without a save.
 *
 * Every case runs the real undo plugin and the real mutation hub. The cases with a
 * painted value run the vendored sapjs core, which registers its own flush.
 */

let snapshot;
let lib;
let Mutation;

const SAP_PAGE = `<main sap state="n:num" n="1"><output id="next" text="state.n + 1">2</output></main>`;
// Two rows, and the number of rows that are not in the trash.
const ROWS_PAGE = `<main sap><ol items="rows"><li item data-id="a" state="data-deleted-at:presence"></li><li item data-id="b" state="data-deleted-at:presence"></li></ol><output id="left" text="state.rows.filter((row) => !row.deletedAt).length">2</output></main>`;
const PAGE = `<main n="1"></main>`;

const root = () => document.querySelector("main");
const painted = (value) => `>${value}</output>`;

async function load(body, { sap = true } = {}) {
  jest.resetModules();
  // mutation.js publishes one hub per realm and every later module instance adopts it,
  // so a hub left by an earlier test would keep observing this test's page.
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.clay;
  delete window.Sap;
  delete window.sapPlugins;
  delete window.clayEditMode;
  window.scrollTo = () => {};
  document.body.innerHTML = body;
  snapshot = await import("../../src/core/snapshot.js");
  lib = await import("../../src/lib/derived.js");
  Mutation = (await import("../../src/lib/mutation.js")).default;
  const { undo } = await import("../../src/plugins/undo.js");
  const { trash } = await import("../../src/lib/trash.js");
  window.clay = { derived: lib.derived, Mutation, undo, trash };
  undo.start({ bindKeys: false });
  if (sap) (await import("../../src/vendor/sap-core.vendor.js")).default.mount(root());
}

// How many batches of changes a page's own change subscriber has been handed.
function subscriber() {
  const batches = [];
  Mutation.onAnyChange({}, (changes) => batches.push(changes.length));
  return batches;
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  window.Sap?.unmount?.();
  window.clay?.undo?.stop();
  jest.restoreAllMocks();
});

test("an edit made through clay.undo.commit, then a save in the same task: the save holds what the engine paints from it", async () => {
  await load(SAP_PAGE);
  window.clay.undo.commit("Set n", () => root().setAttribute("n", "4"));

  expect(snapshot.captureForSaveAndComparison().forSave).toContain(painted(5));
  expect(root().querySelector("#next").textContent).toBe("5");
});

test("an edit made through clay.undo.command, then a save in the same task: the save holds what the engine paints from it", async () => {
  await load(SAP_PAGE);
  expect(window.clay.undo.command("Set n", () => root().setAttribute("n", "4"))).toEqual({ id: expect.anything(), label: "Set n" });

  expect(snapshot.captureForSaveAndComparison().forSave).toContain(painted(5));
});

test("a row moved to the trash, then a save in the same task: the save holds the count the engine paints without it", async () => {
  await load(ROWS_PAGE);
  let frame = null;
  document.addEventListener("clay:snapshot-ready", (event) => {
    frame = snapshot.serializeForSync(event.detail.documentElement);
  }, { once: true });

  window.clay.trash(document.querySelector('[data-id="a"]'));
  const { forSave } = snapshot.captureForSaveAndComparison();

  expect(forSave).toContain(`data-id="a" state="data-deleted-at:presence" data-deleted-at="`);
  expect(forSave).toContain(painted(1));
  expect(frame).toContain(painted(1));
});

test("with undo running, the undo step a save closes holds the edit and what the engine's flush wrote from it, so one undo takes back both", async () => {
  await load(PAGE, { sap: false });
  lib.derived.register(() => {}, { flush: () => root().setAttribute("data-seen", root().getAttribute("n")) });

  root().setAttribute("n", "4");
  expect(snapshot.captureForSaveAndComparison().forSave).toContain(`<main n="4" data-seen="4">`);

  window.clay.undo.undo();
  expect({ n: root().getAttribute("n"), seen: root().getAttribute("data-seen") }).toEqual({ n: "1", seen: null });
});

test("a page with no engine flush: an edit made through undo reaches the page's change subscribers after the save capture, as before", async () => {
  await load(PAGE, { sap: false });
  const batches = subscriber();

  window.clay.undo.commit("Set n", () => root().setAttribute("n", "4"));
  snapshot.captureForSaveAndComparison();
  const inCapture = batches.length;
  await Promise.resolve();

  expect({ inCapture, afterCapture: batches.length }).toEqual({ inCapture: 0, afterCapture: 1 });
});

test("a page whose engine gives no flush: an edit made through undo still reaches the page's change subscribers after the save capture", async () => {
  await load(PAGE, { sap: false });
  lib.derived.register(() => {});
  const batches = subscriber();

  window.clay.undo.commit("Set n", () => root().setAttribute("n", "4"));
  snapshot.captureForSaveAndComparison();
  const inCapture = batches.length;
  await Promise.resolve();

  expect({ inCapture, afterCapture: batches.length }).toEqual({ inCapture: 0, afterCapture: 1 });
});

test("a change subscriber that throws while the save capture hands over an edit made through undo is reported, and the save still goes on", async () => {
  await load(SAP_PAGE);
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  const bug = new Error("author filter bug");
  Mutation.onAnyChange({ selectorFilter: () => { throw bug; } }, () => {});

  window.clay.undo.commit("Set n", () => root().setAttribute("n", "4"));
  const saved = snapshot.captureForSaveAndComparison().forSave;

  expect(saved).toContain(`n="4"`);
  expect(errors.mock.calls.some((call) => call.includes(bug))).toBe(true);
});

test("a page with an engine flush: the save capture hands an edit made through undo to the page's change subscribers once", async () => {
  await load(SAP_PAGE);
  const batches = subscriber();

  window.clay.undo.commit("Set n", () => root().setAttribute("n", "4"));
  snapshot.captureForSaveAndComparison();
  const inCapture = batches.length;
  await Promise.resolve();

  expect({ inCapture, afterCapture: batches.length }).toEqual({ inCapture: 1, afterCapture: 1 });
});

test("a save capture made inside a pause leaves an edit made through undo for after the pause, so the page's change subscribers still get it", async () => {
  await load(SAP_PAGE);
  const batches = subscriber();

  window.clay.undo.commit("Set n", () => root().setAttribute("n", "4"));
  Mutation.pause();
  snapshot.captureForSaveAndComparison();
  Mutation.resume();
  await Promise.resolve();

  expect(batches).toEqual([1]);
});
