import { jest } from "@jest/globals";

let gate, save, snapshot, lib, Mutation, sent, saves;
async function load(body, { engine = false } = {}) {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation; delete window.clay; delete window.Sap; delete window.sapPlugins;
  window.clayEditMode = true; window.scrollTo = () => {};
  document.documentElement.removeAttribute("unsaved");
  document.body.innerHTML = body;
  sent = []; saves = [];
  global.fetch = jest.fn(async (url, options = {}) => {
    if (String(url).endsWith("/_/save")) sent.push(String(options.body));
    return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ msg: "Saved" }) };
  });
  Mutation = (await import("../../src/lib/mutation.js")).default;
  gate = await import("../../src/lib/dirty-gate.js");
  save = await import("../../src/core/save.js");
  snapshot = await import("../../src/core/snapshot.js");
  lib = await import("../../src/lib/derived.js");
  window.clay.derived = lib.derived;
  window.clay.save = (...a) => { const s = save.savePage(...a); saves.push(s); return s; };
  if (engine) lib.derived.register(() => {}, { flush: () => {} });
  await Promise.resolve();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
}
async function settled() { await Promise.resolve(); for (let i = 0; i < saves.length; i++) await saves[i]; await Promise.resolve(); }
beforeEach(() => { jest.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { document.documentElement.removeAttribute("unsaved"); delete window.clayEditMode; jest.restoreAllMocks(); });

// Order: gate, saver, X (unsubscribes itself), Y, then late subscriber Z added by X.
async function selfUnsub(engine) {
  await load(`<main id="m"></main>`, { engine });
  const calls = { X: 0, Y: 0, W: 0, Z: 0 };
  let savedOnce = false;
  Mutation.onAnyChange({}, () => { if (!savedOnce) { savedOnce = true; window.clay.save(); } });
  const offX = Mutation.onAnyChange({}, () => { calls.X++; offX(); Mutation.onAnyChange({}, () => calls.Z++); });
  Mutation.onAnyChange({}, () => calls.Y++);
  Mutation.onAnyChange({}, () => calls.W++);
  document.getElementById("m").setAttribute("n", "1");
  await settled();
  return calls;
}

test("a subscriber that unsubscribes itself during a delivery does not make the next one miss the batch, with or without an engine", async () => {
  const withEngine = await selfUnsub(true);
  const without = await selfUnsub(false);
  expect(withEngine).toEqual(without);
  expect(without).toMatchObject({ X: 1, Y: 1, W: 1 });
});

// The save boundary is reached inside a nested delivery (I) while an outer delivery (O)
// has not reached the engine's subscriber yet. Does the engine hear O's batch before its flush?
test("a save started inside a nested delivery hands the engine the outer batch too, before its flush", async () => {
  await load(`<main id="m"></main><p id="p"></p>`);
  let heard = [];
  let atFlush = null;
  let phase = 0;
  // A page subscriber that writes and pauses/resumes on the first batch, which makes the nested delivery I.
  Mutation.onAnyChange({}, () => {
    if (phase !== 1) return;
    phase = 2;
    document.getElementById("p").setAttribute("x", "1");
    Mutation.pause(); Mutation.resume();
  });
  // A saver that saves only on the nested batch.
  Mutation.onAnyChange({}, (changes) => {
    if (phase === 2 && changes.some((c) => c.element.id === "p")) { phase = 3; snapshot.captureForSaveAndComparison(); }
  });
  // The fake engine, subscribed last.
  Mutation.onAnyChange({}, (changes) => heard.push(changes.map((c) => c.element.id).join(",")));
  lib.derived.register(() => {}, { flush: () => { atFlush ??= [...heard]; } });
  phase = 1;
  document.getElementById("m").setAttribute("n", "1");
  await Promise.resolve(); await Promise.resolve();
  expect(atFlush).toEqual(expect.arrayContaining(["m", "p"]));
});
