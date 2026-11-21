/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { jest } from "@jest/globals";

class FakeEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
  }
  close() {}
}

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

test("nested owned roots: the outer owner decides and alone merges; a root first seen after registration counts its first notify as an edit", async () => {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  window.clayEditMode = true;

  const Mutation = (await import("../../src/lib/mutation.js")).default;
  const regions = await import("../../src/lib/owned-regions.js");
  const gate = await import("../../src/lib/dirty-gate.js");

  document.body.innerHTML = `<div sheet-workbook><section item><table grid><tbody><tr><td>1</td></tr></tbody></table></section></div>`;

  let wbRev = 1;
  let tableMerges = 0;
  let wbMerges = 0;
  // Bare-table fallback owner + outer workbook owner (design.md section 3.5: "ClayJS drops an owned root that sits inside another owned root")
  const hTable = regions.own("table[grid]", {
    serialize: () => "<tbody><tr><td>table</td></tr></tbody>",
    revision: () => 0,
    merge: () => { tableMerges++; return () => false; },
  });
  const hWb = regions.own("[sheet-workbook]", {
    serialize: () => "<section item><table grid><tbody><tr><td>wb</td></tr></tbody></table></section>",
    revision: () => wbRev,
    merge: () => { wbMerges++; return () => false; },
  });

  await turn();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());

  // User edits cell inside <table grid>, advancing workbook revision!
  document.querySelector("td").textContent = "42";
  wbRev = 2;
  await turn();
  const dirtyAfterNestedCellEdit = gate.pageMaybeDirty();

  const finish = regions.beginOwnedMerge({
    document: new DOMParser().parseFromString("<!DOCTYPE html><html><body><div sheet-workbook><table grid></table></div></body></html>", "text/html"),
    html: "",
    source: "disk",
    seq: 1,
    etag: "e1",
    dirty: false,
    base: null,
  });
  finish();

  hTable.dispose();
  hWb.dispose();

  // Part B: dynamically added root while paused (e.g. dirty sync morph), then model-only edit + notify()
  document.body.innerHTML = `<div id="host"></div>`;
  let dynRev = 1;
  const hDyn = regions.own("table[grid]", {
    serialize: () => "",
    revision: () => dynRev,
  });
  await turn();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());

  Mutation.pause();
  document.getElementById("host").innerHTML = `<table grid><tbody><tr><td>0</td></tr></tbody></table>`;
  Mutation.resume();

  // Model-only edit moves dynRev to 2 and calls notify()
  dynRev = 2;
  hDyn.notify();
  await turn();
  const dirtyAfterDynNotify = gate.pageMaybeDirty();
  hDyn.dispose();

  expect(dirtyAfterNestedCellEdit).toBe(true);
  expect([tableMerges, wbMerges]).toEqual([0, 1]);
  expect(dirtyAfterDynNotify).toBe(true);
});

test("an owner that refuses a save with a code refuses only save requests: seeding bases and applying a disk frame still work", async () => {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  window.clayEditMode = true;
  window.scrollTo = () => {};
  global.EventSource = window.EventSource = FakeEventSource;
  global.fetch = jest.fn(async () => ({ ok: false, status: 404, statusText: "", headers: { get: () => null }, text: async () => "" }));

  const Mutation = (await import("../../src/lib/mutation.js")).default;
  const regions = await import("../../src/lib/owned-regions.js");
  const snapshot = await import("../../src/core/snapshot.js");
  const gate = await import("../../src/lib/dirty-gate.js");
  const liveSyncMod = await import("../../src/sync/live-sync.js");
  liveSyncMod.liveSync.stop();
  const save = await import("../../src/core/save.js");
  const conflictDownload = await import("../../src/core/conflict-download.js");
  window.clay = { Mutation, conflicts: liveSyncMod.conflicts };

  document.body.innerHTML = `<h1 data-id="title" contenteditable="true">Title 0</h1><section item><table grid><tbody><tr><td>1</td></tr></tbody></table></section>`;
  let rev = 1;
  let mergePurposes = null;
  let throwCodeOnSave = false;

  const handle = regions.own("section[item] > table[grid]", {
    serialize: (_root, { purpose }) => {
      if (throwCodeOnSave && purpose === "save") {
        throw Object.assign(new Error("edits are still pending"), { code: "sheet-pending" });
      }
      return `<tbody><tr><td>purpose:${purpose}</td></tr></tbody>`;
    },
    revision: () => rev,
    merge: (incoming) => {
      const docCell = incoming.document.querySelector("table[grid] td")?.textContent ?? null;
      const baseCell = incoming.base?.querySelector("table[grid] td")?.textContent ?? null;
      mergePurposes = { docCell, baseCell };
      return () => false;
    },
  });

  save.setLastSavedBaselines(snapshot.captureForComparison(), snapshot.captureForDirtyCheck());
  const sync = new liveSyncMod.LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  sync._seedBases();
  await turn();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());

  // 5b part 1: peer save relay carries purpose:save while receiver's _seedBases lastHtml has purpose:sync
  const senderSaveClone = snapshot.captureSnapshot({ flushUndo: false, forSave: true });
  const peerRelayHtml = snapshot.serializeForSync(senderSaveClone);
  await sync._doApplyUpdate(peerRelayHtml, 10, null, "etag-10");
  const seenMismatch = { ...mergePurposes };

  // 5a: user edits title + sheet; incoming disk frame conflicts on title -> buildRecovery downloads purpose:save instead of purpose:recovery!
  sync._diskBase = snapshot.captureForSaveAndComparison({ emitForSync: false }).forSave;
  document.querySelector('[data-id="title"]').textContent = "Ana Title";
  rev = 2;
  handle.notify();
  await turn();
  expect(gate.pageMaybeDirty()).toBe(true);

  const diskConflict = `<!DOCTYPE html><html><head></head><body><h1 data-id="title">Agent Title</h1><section item><table grid><tbody><tr><td>purpose:save</td></tr></tbody></table></section></body></html>`;
  await sync._doApplyExternal(diskConflict, 11, "etag-11");
  const openConflicts = liveSyncMod.conflicts.list();
  expect(openConflicts.length).toBeGreaterThan(0);
  const recoveryDownload = conflictDownload.buildRecovery(openConflicts);

  // 5c: when serialize throws error.code on purpose:save, _seedBases throws and _doApplyExternal abandons beginOwnedMerge!
  throwCodeOnSave = true;
  let seedThrew = null;
  try {
    gate.gateClearIfUnchanged(gate.gateCaptureToken());
    sync._seedBases();
  } catch (e) {
    seedThrew = e.code;
  }

  let halfStartedMerges = 0;
  let finishedMerges = 0;
  handle.dispose();
  const hCode = regions.own("section[item] > table[grid]", {
    serialize: (_root, { purpose }) => {
      if (purpose === "save") throw Object.assign(new Error("codec mismatch"), { code: "codec-mismatch" });
      return `<tbody><tr><td>${purpose}</td></tr></tbody>`;
    },
    revision: () => 1,
    merge: () => {
      halfStartedMerges++;
      return () => { finishedMerges++; return false; };
    },
  });
  let applyExtThrew = null;
  try {
    await sync._doApplyExternal(diskConflict, 12, "etag-12");
  } catch (e) {
    applyExtThrew = e.code;
  }

  liveSyncMod.conflicts.acknowledge(openConflicts.map((c) => c.id), { reason: "accepted" });
  hCode.dispose();
  sync.stop();

  expect(seedThrew).toBe(null);
  expect(applyExtThrew).toBe(null);
  expect([halfStartedMerges, finishedMerges]).toEqual([1, 1]);
});

test("an owner that registers after the boot baseline leaves an untouched page clean, and its conflict handler answers the first refused save", async () => {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  window.clayEditMode = true;
  window.scrollTo = () => {};

  let answer = { status: 200, body: { msg: "Saved", etag: "e1" } };
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes("/_/meta")) {
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ spec: 1, extensions: ["conditional"], document: { etag: "seed-1" } }) };
    }
    return { ok: answer.status < 400, status: answer.status, statusText: "", headers: { get: () => null }, text: async () => JSON.stringify(answer.body) };
  });

  document.body.innerHTML = `<main sap><p id="note">note</p><section item><table grid><tbody><tr><td>1</td></tr></tbody></table></section></main>`;

  // 1. Core loads save.js (captures immediate baseline with 0 owned regions)
  const { bootPhase } = await import("../../src/core/boot-phase.js");
  bootPhase.holdSettle = true;
  const save = await import("../../src/core/save.js");
  const unsavedWarning = await import("../../src/core/unsaved-warning.js");
  const regions = await import("../../src/lib/owned-regions.js");
  await turn();

  // 2. On [sap] pages, loader.js mounts derived engine and calls releaseBootSettle() BEFORE clay:ready / late plugins
  save.releaseBootSettle();

  // 3. Page script / late plugin registers clay.region.own on clay:ready
  let rev = 1;
  const told = [];
  const handle = regions.own("section[item] > table[grid]", {
    serialize: () => `<tbody><tr><td>${rev}</td></tr></tbody>`,
    revision: () => rev,
    conflict: (detail) => told.push(detail),
  });

  // Untouched page immediately reads as having unsaved changes!
  const untouchedHasUnsaved = unsavedWarning.hasUnsavedChanges();

  // User edits ONLY inside the owned region and hits a 412 on their first save
  rev = 2;
  answer = { status: 412, body: { msg: "Conflict", code: "conflict", etag: "e2" } };
  await save.savePage();

  expect(untouchedHasUnsaved).toBe(false);
  expect(told.length).toBe(1);
  expect(save.isSaveConflicted()).toBe(false);
  handle.dispose();
});

test("a refused save that the owner resolves leaves no 'saving' status and settles a waiting flush", async () => {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  window.clayEditMode = true;
  window.scrollTo = () => {};

  let holdSave = null;
  let saveCalls = 0;
  let answer = { status: 200, body: { msg: "Saved", etag: "seed-2" } };
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes("/_/meta")) {
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ spec: 1, extensions: ["conditional"], document: { etag: "seed-1" } }) };
    }
    saveCalls++;
    if (holdSave) await holdSave();
    return { ok: answer.status < 400, status: answer.status, statusText: "", headers: { get: () => null }, text: async () => JSON.stringify(answer.body) };
  });

  document.body.innerHTML = `<p id="note">note</p><section item><table grid><tbody><tr><td>1</td></tr></tbody></table></section>`;
  const save = await import("../../src/core/save.js");
  const regions = await import("../../src/lib/owned-regions.js");
  await turn();
  save.releaseBootSettle();

  let rev = 1;
  const told = [];
  const handle = regions.own("section[item] > table[grid]", {
    serialize: () => `<tbody><tr><td>${rev}</td></tr></tbody>`,
    revision: () => rev,
    conflict: (detail) => told.push(detail),
  });
  await save.savePageForce();

  // Start an in-flight save that takes >500ms (so savestatus flips to 'saving') while flushSave waits AND a second save queues behind it
  rev = 2;
  answer = { status: 412, body: { msg: "Conflict", code: "conflict", etag: "remote-3" } };
  let releaseFetch;
  holdSave = () => new Promise((r) => { releaseFetch = r; });
  saveCalls = 0;

  const firstSave = save.savePage();
  await turn();
  // Simulate >500ms elapsed so savingTimeout fired
  document.documentElement.setAttribute("savestatus", "saving");
  // Queue a second save behind the in-flight one, and start flushSave with a 60ms timeout
  rev = 3;
  save.savePage();
  const flushing = save.flushSave({ timeoutMs: 1000 }).then(
    (v) => ({ ok: true, v }),
    (e) => ({ ok: false, msg: e.message, state: e.state })
  );

  // Release the 412 response after 5ms!
  holdSave = null;
  releaseFetch();
  await firstSave;
  const statusRightAfter412 = document.documentElement.getAttribute("savestatus");
  const flushOutcome = await flushing;
  await turn();

  expect(statusRightAfter412).not.toBe("saving");
  expect(flushOutcome?.msg).not.toBe("Save timed out.");
  handle.dispose();
});

test("an owner that registers during the boot settle leaves the settle's capture in charge: a later boot change on an untouched page stays clean", async () => {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  window.clayEditMode = true;
  window.scrollTo = () => {};
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes("/_/meta")) {
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ spec: 1, extensions: ["conditional"], document: { etag: "seed-1" } }) };
    }
    return { ok: true, status: 200, statusText: "", headers: { get: () => null }, text: async () => JSON.stringify({ msg: "Saved", etag: "e1" }) };
  });

  document.body.innerHTML = `<main><p id="note">note</p><section item><table grid><tbody><tr><td>1</td></tr></tbody></table></section></main>`;
  const { bootPhase } = await import("../../src/core/boot-phase.js");
  bootPhase.holdSettle = true;
  const save = await import("../../src/core/save.js");
  const unsavedWarning = await import("../../src/core/unsaved-warning.js");
  const gate = await import("../../src/lib/dirty-gate.js");
  const regions = await import("../../src/lib/owned-regions.js");
  await turn();

  const handle = regions.own("section[item] > table[grid]", {
    serialize: () => `<tbody><tr><td>1</td></tr></tbody>`,
    revision: () => 1,
  });
  document.getElementById("note").setAttribute("data-booted", "1");
  await turn();
  save.releaseBootSettle();
  await turn();

  expect(unsavedWarning.hasUnsavedChanges()).toBe(false);
  expect(gate.pageMaybeDirty()).toBe(false);
  handle.dispose();
});
