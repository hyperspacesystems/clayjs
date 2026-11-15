import { jest } from "@jest/globals";

/**
 * A derive engine can hand ClayJS a flush beside its repaint:
 * clay.derived.register(repaint, { flush }). A capture at a save boundary calls every
 * flush before it clones the page, so an edit and a save made in one task save what
 * the engine paints from that edit, and the sync frame of that save carries the same
 * bytes. A capture that only reads the page (a merge, a recovery download, a dirty
 * check per incoming frame) calls none, and an engine that gives no flush is treated
 * as it always was.
 *
 * The first tests use an engine made of two functions. The last two run the vendored
 * sapjs core against the real mutation hub: its repaint is queued for a microtask, and
 * the flush it registers beside that repaint is what runs it inside the task.
 */

let snapshot;
let lib;

const PAGE = `<main n="1"><output id="next">2</output></main>`;
const SAP_PAGE = `<main sap state="n:num" n="1"><output id="next" text="state.n + 1">2</output></main>`;

const root = () => document.querySelector("main");
const painted = (value) => `>${value}</output>`;

async function load(body) {
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
  const Mutation = (await import("../../src/lib/mutation.js")).default;
  window.clay = { derived: lib.derived, Mutation };
}

// The vendored core, unchanged: it registers its own flush with its repaint when it mounts.
async function loadCoreWithFlush() {
  return (await import("../../src/vendor/sap-core.vendor.js")).default;
}

// An engine that paints n + 1, and counts how often it was asked to flush.
function engine() {
  const calls = { repaints: 0, flushes: 0 };
  const paint = () => {
    root().querySelector("#next").textContent = String(Number(root().getAttribute("n")) + 1);
  };
  const repaint = () => {
    calls.repaints++;
    paint();
  };
  const flush = () => {
    calls.flushes++;
    paint();
  };
  return { calls, repaint, flush };
}

beforeEach(() => {
  jest.spyOn(console, "log").mockImplementation(() => {});
});

const realFetch = global.fetch;

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.clayEditMode;
  global.fetch = realFetch;
  jest.restoreAllMocks();
});

test("a save, and the sync frame of that save, hold what a flush paints from an edit made in the same task", async () => {
  await load(PAGE);
  const { repaint, flush } = engine();
  lib.derived.register(repaint, { flush });

  let frame = null;
  document.addEventListener("clay:snapshot-ready", (event) => {
    frame = snapshot.serializeForSync(event.detail.documentElement);
  }, { once: true });

  root().setAttribute("n", "4");
  const { forSave } = snapshot.captureForSaveAndComparison();

  expect(forSave).toContain(painted(5));
  expect(frame).toContain(painted(5));
});

test("every capture at a save boundary flushes first, and a capture that only reads the page does not", async () => {
  await load(PAGE);
  const { calls, repaint, flush } = engine();
  lib.derived.register(repaint, { flush });
  const flushesIn = (capture) => {
    const before = calls.flushes;
    capture();
    return calls.flushes - before;
  };

  expect({
    save: flushesIn(() => snapshot.captureForSaveAndComparison()),
    saveAlone: flushesIn(() => snapshot.captureForSave()),
    pageContents: flushesIn(() => snapshot.getPageContents()),
    baseline: flushesIn(() => snapshot.captureForComparisonAndDirty()),
    closeWarning: flushesIn(() => snapshot.captureForDirtyCheck()),
  }).toEqual({ save: 1, saveAlone: 1, pageContents: 1, baseline: 1, closeWarning: 1 });

  expect({
    merge: flushesIn(() => snapshot.captureForMerge()),
    mergeBase: flushesIn(() => snapshot.captureSnapshot({ flushUndo: false })),
    frameDirtyCheck: flushesIn(() => snapshot.captureForComparisonAndDirty({ flushUndo: false })),
    recoveryDownload: flushesIn(() => snapshot.captureRecoveryPage()),
    inspection: flushesIn(() => snapshot.captureSaveClone({ flushUndo: false, authored: false })),
  }).toEqual({ merge: 0, mergeBase: 0, frameDirtyCheck: 0, recoveryDownload: 0, inspection: 0 });
  expect(calls.repaints).toBe(0);
});

test("an engine that gives no flush is registered as before: a save asks nothing of it", async () => {
  await load(PAGE);
  const { calls, repaint } = engine();
  const off = lib.derived.register(repaint);

  root().setAttribute("n", "4");
  expect(snapshot.captureForSaveAndComparison().forSave).toContain(painted(2));
  expect(calls).toEqual({ repaints: 0, flushes: 0 });

  lib.repaintDerived();
  expect(calls.repaints).toBe(1);
  expect(lib.derivedActive()).toBe(true);
  off();
  expect(lib.derivedActive()).toBe(false);
});

test("a flush that throws is reported once, and the save still holds what the other engine's flush painted", async () => {
  await load(PAGE);
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  const broken = new Error("the engine could not settle");
  lib.derived.register(() => {}, { flush: () => { throw broken; } });
  const { repaint, flush } = engine();
  lib.derived.register(repaint, { flush });

  root().setAttribute("n", "4");
  expect(snapshot.captureForSaveAndComparison().forSave).toContain(painted(5));
  expect(errors.mock.calls).toEqual([["clayjs: a derived flush failed:", broken]]);
});

test("an engine that unregistered is not flushed", async () => {
  await load(PAGE);
  const { calls, repaint, flush } = engine();
  const off = lib.derived.register(repaint, { flush });
  off();

  root().setAttribute("n", "4");
  expect(snapshot.captureForSaveAndComparison().forSave).toContain(painted(2));
  expect(calls.flushes).toBe(0);
  expect(lib.derivedActive()).toBe(false);
});

test("an engine that gives no flush beside one that does: a save flushes the one, asks nothing of the other, and logs no error", async () => {
  await load(PAGE);
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  const quiet = engine();
  lib.derived.register(quiet.repaint);
  const flushing = engine();
  lib.derived.register(flushing.repaint, { flush: flushing.flush });

  root().setAttribute("n", "4");
  expect(snapshot.captureForSaveAndComparison().forSave).toContain(painted(5));
  expect({ quiet: quiet.calls, flushing: flushing.calls }).toEqual({
    quiet: { repaints: 0, flushes: 0 },
    flushing: { repaints: 0, flushes: 1 },
  });
  expect(errors).not.toHaveBeenCalled();
});

test("the save boundaries outside snapshot.js flush the engines: both boot baselines, the entry baseline and the close warning", async () => {
  await load(PAGE);
  window.clayEditMode = true;
  global.fetch = jest.fn(async () => ({
    ok: false,
    status: 404,
    statusText: "Not Found",
    headers: new Headers(),
    text: async () => "",
    json: async () => ({}),
  }));
  const { calls, repaint, flush } = engine();
  lib.derived.register(repaint, { flush });
  const flushesIn = async (step) => {
    const before = calls.flushes;
    await step();
    return calls.flushes - before;
  };
  (await import("../../src/core/boot-phase.js")).bootPhase.holdSettle = true;

  let save;
  const immediateBaseline = await flushesIn(async () => {
    save = await import("../../src/core/save.js");
  });
  const { bytesUnsaved } = await import("../../src/core/unsaved-warning.js");

  expect({
    immediateBaseline,
    settledBaseline: await flushesIn(() => save.releaseBootSettle()),
    entryBaseline: await flushesIn(() => save.adoptEntryBaseline()),
    closeWarning: await flushesIn(() => bytesUnsaved()),
  }).toEqual({ immediateBaseline: 1, settledBaseline: 1, entryBaseline: 1, closeWarning: 1 });
});

test("the sapjs core: an edit and a save in one task save the value the engine paints from that edit", async () => {
  await load(SAP_PAGE);
  const Sap = await loadCoreWithFlush();
  Sap.mount(root());
  expect(Sap._registry.has(root())).toBe(true);
  expect(root().querySelector("#next").textContent).toBe("2");

  root().setAttribute("n", "4");
  // The pass for this edit is still queued: a capture that does not flush reads the old value.
  expect(snapshot.captureRecoveryPage()).toContain(painted(2));
  expect(snapshot.captureForSaveAndComparison().forSave).toContain(painted(5));
  expect(root().querySelector("#next").textContent).toBe("5");
});

test("the sapjs core: a save posts the value the engine paints from an edit made in the same task", async () => {
  await load("");
  window.clayEditMode = true;
  const posted = [];
  global.fetch = jest.fn(async (url, init = {}) => {
    const saving = init.method === "POST" && /\/_\/save/.test(String(url));
    if (saving) posted.push(init.body);
    return {
      ok: saving,
      status: saving ? 200 : 404,
      statusText: saving ? "OK" : "Not Found",
      headers: new Headers(),
      text: async () => (saving ? JSON.stringify({ msg: "Saved" }) : ""),
      json: async () => ({}),
    };
  });
  const errors = jest.spyOn(console, "error");
  const Sap = await loadCoreWithFlush();
  // The loader's mount phase: the boot baseline is held until the first pass has run.
  (await import("../../src/core/boot-phase.js")).bootPhase.holdSettle = true;
  document.body.innerHTML = SAP_PAGE;
  const save = await import("../../src/core/save.js");
  Sap.mount(root());
  save.releaseBootSettle();

  root().setAttribute("n", "4");
  await save.savePageForce();

  expect(posted).toHaveLength(1);
  expect(posted[0]).toContain(`n="4"`);
  expect(posted[0]).toContain(painted(5));
  expect(errors).not.toHaveBeenCalled();
});
