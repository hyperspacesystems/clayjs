import { jest } from "@jest/globals";

/**
 * A save started by a change subscriber, on a page a derive engine paints.
 *
 * The mutation hub hands a batch of changes to its subscribers one after another, in
 * the order they subscribed. ClayJS's [onmutation] subscribes before the sapjs engine
 * mounts, so a page whose [onmutation] calls clay.save() starts the save before the
 * engine has heard of the edit: the engine's flush at the save finds nothing to do, the
 * file keeps the old painted value, and a second save says "No changes to save"
 * because painted values are left out of every comparison. A save boundary therefore
 * hands the rest of the subscribers the batch being delivered before the engines flush
 * (Mutation.deliverDeferred). Every save does it again before it takes its dirty-gate
 * token, so a page with no engine flush hands them the batch before its clone too.
 *
 * The cases with a painted value run the vendored sapjs core, the real [onmutation]
 * wiring and the real save path, with the host answered by a fetch stub. The core
 * mounts as it is imported, so each case subscribes [onmutation] first, as a page does.
 */

let gate;
let save;
let lib;
let Mutation;
let trash;
let sent;
let saves;

const SAP_PAGE = `<main sap state="n:num" n="1" onmutation="clay.save()"><output id="next" text="state.n + 1">2</output></main>`;
// Two rows, and the number of rows that are not in the trash.
const ROWS_PAGE = `<main sap onmutation="clay.save()"><ol items="rows"><li item data-id="a" state="data-deleted-at:presence"></li><li item data-id="b" state="data-deleted-at:presence"></li></ol><output id="left" text="state.rows.filter((row) => !row.deletedAt).length">2</output></main>`;
const PLAIN_PAGE = `<main n="1" onmutation="clay.save()"></main><p id="note">n</p>`;
const NOTE_PAGE = `<ol><li data-id="a">a</li></ol><p id="note">n</p>`;

const root = () => document.querySelector("main");
const note = () => document.getElementById("note");

async function load(body, { sap = false, onmutation = true, undo = false, beforeGate = null } = {}) {
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
  beforeGate?.(Mutation);
  gate = await import("../../src/lib/dirty-gate.js");
  save = await import("../../src/core/save.js");
  lib = await import("../../src/lib/derived.js");
  window.clay.derived = lib.derived;
  window.clay.save = (...args) => {
    const saving = save.savePage(...args);
    saves.push(saving);
    return saving;
  };
  if (undo) {
    const plugin = await import("../../src/plugins/undo.js");
    ({ trash } = await import("../../src/lib/trash.js"));
    window.clay.undo = plugin.undo;
    window.clay.trash = trash;
    expect(await plugin.ready).not.toBe(null);
  }
  if (onmutation) (await import("../../src/events/onmutation.js")).init();
  if (sap) await import("../../src/vendor/sap-core.vendor.js");
  await Promise.resolve();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
}

// Every save the page started, settled.
async function settled() {
  await Promise.resolve();
  for (let i = 0; i < saves.length; i++) await saves[i];
  await Promise.resolve();
}

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

test("a page whose [onmutation] calls clay.save(): the save holds what the engine paints from the edit", async () => {
  await load(SAP_PAGE, { sap: true });
  root().setAttribute("n", "4");
  await settled();

  expect({ saves: saves.length, sent: sent.length }).toEqual({ saves: 1, sent: 1 });
  expect(sent[0]).toContain(">5</output>");
  expect(root().querySelector("#next").textContent).toBe("5");
});

test("a row moved to the trash and a save in the same task, on a page whose [onmutation] saves too: the save that goes out holds the new count", async () => {
  await load(ROWS_PAGE, { sap: true, undo: true });
  trash(document.querySelector('[data-id="a"]'));
  window.clay.save();
  await settled();

  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain(">1</output>");
});

test("the subscribers a save hands the batch to are not handed it again when the delivery goes on", async () => {
  await load(SAP_PAGE, { sap: true });
  const batches = [];
  Mutation.onAnyChange({}, (changes) => batches.push(changes.length));
  root().setAttribute("n", "4");
  await settled();

  expect({ saves: saves.length, batches: batches.length }).toEqual({ saves: 1, batches: 1 });
});

test("a page with no engine flush: a save from a change subscriber hands the subscribers after it the batch before it reads the page, and once", async () => {
  await load(PLAIN_PAGE);
  const batches = [];
  Mutation.onAnyChange({}, (changes) => batches.push(changes.length));
  let inCapture = null;
  document.addEventListener("clay:snapshot-ready", () => { inCapture ??= batches.length; });
  root().setAttribute("n", "4");
  await settled();

  expect({ saves: saves.length, inCapture, after: batches.length }).toEqual({ saves: 1, inCapture: 1, after: 1 });
});

test("a save started in a delivery nested inside the delivery of an undo edit, on a page with an engine flush: the save holds both edits and leaves the page clean", async () => {
  let armed = false;
  let echoed = false;
  let started = false;
  await load(NOTE_PAGE, {
    onmutation: false,
    undo: true,
    beforeGate: (hub) => {
      hub.onAnyChange({}, () => {
        if (!armed || echoed) return;
        echoed = true;
        note().setAttribute("data-echo", "1");
        hub.pause();
        hub.resume();
      });
      hub.onAnyChange({}, () => {
        if (!echoed || started) return;
        started = true;
        window.clay.save();
      });
    },
  });
  lib.derived.register(() => {}, { flush: () => {} });
  armed = true;
  trash(document.querySelector('[data-id="a"]'));
  await settled();

  expect({
    echoed,
    started,
    sent: sent.length,
    unsaved: document.documentElement.getAttribute("unsaved"),
    dirty: gate.pageMaybeDirty(),
  }).toEqual({ echoed: true, started: true, sent: 1, unsaved: null, dirty: false });
  expect(sent[0]).toContain('data-echo="1"');
  expect(sent[0]).toContain('data-id="a" data-deleted-at="');
});
