import { jest } from "@jest/globals";

let eventSourceInstances;
class FakeEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    eventSourceInstances.push(this);
  }
  close() {}
}

let LiveSync;
let save;
let snapshot;
let gate;
let regions;
let autosaveState;
let stamps;

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
const rowsHtml = (rows) => `<tbody>${rows.map(([id, a, b]) => `<tr data-id="${id}"><td>${a}</td><td>${b}</td></tr>`).join("")}</tbody>`;
const page = (rows, note) => `<section item data-id="tab-1"><table grid>${rowsHtml(rows)}</table></section><p data-id="note">${note}</p>`;
const diskDoc = (body) => `<!DOCTYPE html><html><head></head><body>${body}</body></html>`;

function sheet() {
  const table = document.querySelector("table[grid]");
  const state = { rev: 1, unsaved: new Set(), merges: [], rows: new Map(), fail: null };
  for (const tr of table.querySelectorAll("tr")) state.rows.set(tr.dataset.id, [tr.children[0].textContent, tr.children[1].textContent]);
  const paint = () => {
    for (const tr of table.querySelectorAll("tr")) {
      const row = state.rows.get(tr.dataset.id);
      tr.children[0].textContent = row[0];
      tr.children[1].textContent = row[1];
    }
  };
  state.edit = (id, column, text) => {
    state.rows.get(id)[column] = text;
    state.unsaved.add(`${id}:${column}`);
    state.rev++;
    paint();
  };
  state.handle = regions.own("section[item] > table[grid]", {
    serialize: () => rowsHtml([...state.rows].map(([id, row]) => [id, ...row])),
    revision: () => state.rev,
    merge: (incoming) => {
      const theirs = [...incoming.document.querySelectorAll("table[grid] tr")].map((tr) => [tr.dataset.id, tr.children[0].textContent, tr.children[1].textContent]);
      const base = incoming.base ? incoming.base.querySelector('tr[data-id="r2"] td').textContent : null;
      state.merges.push({ source: incoming.source, etag: incoming.etag, dirty: incoming.dirty, html: typeof incoming.html, rows: theirs.length, base });
      if (state.fail === "before") throw new Error("merge failed before the apply");
      return () => {
        if (state.fail === "after") throw new Error("merge failed after the apply");
        for (const [id, a, b] of theirs) {
          const mine = state.rows.get(id);
          if (!state.unsaved.has(`${id}:0`)) mine[0] = a;
          if (!state.unsaved.has(`${id}:1`)) mine[1] = b;
        }
        paint();
        return state.unsaved.size > 0;
      };
    },
  });
  return state;
}

beforeAll(async () => {
  window.clayEditMode = true;
  eventSourceInstances = [];
  global.EventSource = FakeEventSource;
  window.EventSource = FakeEventSource;
  window.scrollTo = () => {};
  const liveSyncModule = await import("../../src/sync/live-sync.js");
  ({ LiveSync } = liveSyncModule);
  liveSyncModule.liveSync.stop();
  save = await import("../../src/core/save.js");
  snapshot = await import("../../src/core/snapshot.js");
  gate = await import("../../src/lib/dirty-gate.js");
  regions = await import("../../src/lib/owned-regions.js");
  autosaveState = await import("../../src/lib/autosave-state.js");
  stamps = await import("../../src/core/etag.js");
});

let owner = null;
let sync = null;

beforeEach(async () => {
  eventSourceInstances = [];
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 500, statusText: "mock", text: async () => "" }));
  window.clay = { testMode: true };
  document.body.innerHTML = page([["r1", "a1", "b1"], ["r2", "a2", "b2"]], "note 0");
  owner = sheet();
  save.setLastSavedBaselines(snapshot.captureForComparison(), snapshot.captureForDirtyCheck());
  save.setUnsavedChanges(false);
  sync = new LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  sync._diskBase = snapshot.captureForSaveAndComparison({ emitForSync: false }).forSave;
  await turn();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
});

afterEach(() => {
  save.ownedMergeRecovered(null);
  owner.handle.dispose();
  sync.stop();
  autosaveState.setAutosaveActive(false);
  delete window.clay;
});

test("clean tab: the owner takes the file's rows, the generic merge takes the rest and never enters the region", async () => {
  const table = document.querySelector("table[grid]");
  const cell = table.querySelector("td");
  cell.setAttribute("data-runtime", "selected");
  const replace = jest.spyOn(table, "replaceChildren");
  await sync._doApplyExternal(diskDoc(page([["r1", "a1", "b1"], ["r2", "peer a2", "b2"]], "note from disk").replace("<table grid>", '<table grid data-zoom="2">')), 20, "etag-20");
  expect(table.getAttribute("data-zoom")).toBe("2");
  expect(table.querySelectorAll("td").length).toBe(4);
  expect(owner.merges).toEqual([{ source: "disk", etag: "etag-20", dirty: false, html: "string", rows: 2, base: "a2" }]);
  expect(owner.rows.get("r2")).toEqual(["peer a2", "b2"]);
  expect(document.querySelector('[data-id="note"]').textContent).toBe("note from disk");
  expect(document.querySelector("table[grid]")).toBe(table);
  expect(table.querySelector("td")).toBe(cell);
  expect(cell.getAttribute("data-runtime")).toBe("selected");
  expect(replace).not.toHaveBeenCalled();
  expect(gate.pageMaybeDirty()).toBe(false);
  expect(save.getLastSavedDirty()).toBe(snapshot.captureForDirtyCheck({ flushUndo: false }));
});

test("dirty tab: a peer's row lands, the unsaved cell stays, and only the tab's own save records it as saved", async () => {
  autosaveState.setAutosaveActive(true);
  owner.edit("r1", 1, "mine, unsaved");
  await turn();
  expect(gate.pageMaybeDirty()).toBe(true);
  const before = save.getLastSavedDirty();
  const captures = [];
  const onCapture = (event) => { if (event.detail.forSave) captures.push(snapshot.serializeForSync(event.detail.documentElement)); };
  document.addEventListener("clay:snapshot-ready", onCapture);
  const converged = new Promise((resolve) => document.addEventListener("clay:snapshot-ready", resolve, { once: true }));
  await sync._doApplyExternal(diskDoc(page([["r1", "a1", "b1"], ["r2", "peer a2", "peer b2"]], "note from disk")).replace("<html>", "<html autosave>"), 30, "etag-30");
  expect(owner.merges.length).toBe(1);
  expect(owner.merges[0].dirty).toBe(true);
  expect(owner.rows.get("r1")).toEqual(["a1", "mine, unsaved"]);
  expect(owner.rows.get("r2")).toEqual(["peer a2", "peer b2"]);
  expect(document.querySelector('[data-id="note"]').textContent).toBe("note from disk");
  expect(captures.length === 0 ? save.getLastSavedDirty() : before).toBe(before);
  await converged;
  document.removeEventListener("clay:snapshot-ready", onCapture);
  expect(captures.length).toBe(1);
  expect(captures[0]).toContain("<td>mine, unsaved</td>");
  expect(captures[0]).toContain("<td>peer a2</td><td>peer b2</td>");
  expect(captures[0]).toContain("note from disk");
});

test("dirty outside the region only: the region's rows are no conflict and nothing of it reaches the ledger", async () => {
  document.querySelector('[data-id="note"]').textContent = "note edited here";
  await turn();
  expect(gate.pageMaybeDirty()).toBe(true);
  let detail = null;
  const onApplied = (event) => { detail = event.detail; };
  document.addEventListener("clay:sync-applied", onApplied);
  try {
    await sync._doApplyExternal(diskDoc(page([["r1", "a1", "b1"], ["r2", "peer a2", "b2"]], "note 0")), 50, "etag-50");
  } finally {
    document.removeEventListener("clay:sync-applied", onApplied);
  }
  expect(owner.rows.get("r2")).toEqual(["peer a2", "b2"]);
  expect(document.querySelector('[data-id="note"]').textContent).toBe("note edited here");
  expect(detail.report.conflicts.length).toBe(0);
});

test("a region with no merge function keeps its live content and a dirty tab stays unsaved", async () => {
  owner.handle.dispose();
  const errors = [];
  const spy = jest.spyOn(console, "error").mockImplementation((...args) => { errors.push(String(args[0])); });
  const state = { rev: 1 };
  owner = { handle: regions.own("section[item] > table[grid]", { serialize: (root) => root.innerHTML, revision: () => state.rev }) };
  document.querySelector("table[grid] td").textContent = "local";
  state.rev = 2;
  await turn();
  expect(gate.pageMaybeDirty()).toBe(true);
  const before = save.getLastSavedDirty();
  await sync._doApplyExternal(diskDoc(page([["r1", "a1", "b1"], ["r2", "peer a2", "b2"]], "note from disk")), 40, "etag-40");
  spy.mockRestore();
  expect(document.querySelector("table[grid] td").textContent).toBe("local");
  expect(document.querySelector('[data-id="note"]').textContent).toBe("note from disk");
  expect(errors.filter((line) => line.includes("failed in merge")).length).toBe(1);
  expect(save.getLastSavedDirty()).toBe(before);
  expect(gate.pageMaybeDirty()).toBe(true);
});

test("a merge that throws keeps the region and holds this tab as a save conflict until a later version merges", async () => {
  autosaveState.setAutosaveActive(true);
  owner.edit("r1", 1, "mine, unsaved");
  await turn();
  const errors = [];
  const spy = jest.spyOn(console, "error").mockImplementation((...args) => { errors.push(String(args[0])); });
  const events = [];
  const onEvent = (event) => { events.push([event.type, event.detail.code ?? null, event.detail.etag ?? null]); };
  const types = ["clay:save-conflict", "clay:save-conflict-released"];
  for (const type of types) document.addEventListener(type, onEvent);
  const frame = (a2) => diskDoc(page([["r1", "a1", "b1"], ["r2", a2, "b2"]], "note from disk")).replace("<html>", "<html autosave>");
  try {
    owner.fail = "before";
    await sync._doApplyExternal(frame("peer a2"), 60, "etag-60");
    expect(owner.rows.get("r1")).toEqual(["a1", "mine, unsaved"]);
    expect(owner.rows.get("r2")).toEqual(["a2", "b2"]);
    expect(document.querySelector("table[grid]").textContent).toBe("a1mine, unsaveda2b2");
    expect(document.querySelector('[data-id="note"]').textContent).toBe("note from disk");
    expect(save.isSaveConflicted()).toBe(true);
    expect(save.autosaveIsSuspended()).toBe(true);
    expect(document.documentElement.getAttribute("savestatus")).toBe("conflict");
    expect(events).toEqual([["clay:save-conflict", "owned-merge-failed", "etag-60"]]);
    expect(stamps.lastSeenEtag()).not.toBe("etag-60");

    owner.fail = "after";
    await sync._doApplyExternal(frame("peer a2 again"), 61, "etag-61");
    expect(save.isSaveConflicted()).toBe(true);
    expect(events.length).toBe(1);
    expect(owner.rows.get("r1")).toEqual(["a1", "mine, unsaved"]);

    owner.fail = null;
    await sync._doApplyExternal(frame("peer a2 final"), 62, "etag-62");
    expect(save.isSaveConflicted()).toBe(false);
    expect(save.autosaveIsSuspended()).toBe(false);
    expect(stamps.lastSeenEtag()).toBe("etag-62");
    expect(document.documentElement.getAttribute("savestatus")).not.toBe("conflict");
    expect(events[events.length - 1]).toEqual(["clay:save-conflict-released", null, "etag-62"]);
    expect(owner.rows.get("r1")).toEqual(["a1", "mine, unsaved"]);
    expect(owner.rows.get("r2")).toEqual(["peer a2 final", "b2"]);
    expect(owner.merges.map((merge) => merge.base)).toEqual(["a2", "a2", "a2"]);
    expect(errors.filter((line) => line.includes("failed in merge")).length).toBe(1);
  } finally {
    spy.mockRestore();
    for (const type of types) document.removeEventListener(type, onEvent);
  }
});

test("focus inside an owned region is left to its owner", async () => {
  const cell = document.querySelector("table[grid] td");
  cell.setAttribute("tabindex", "0");
  cell.focus();
  expect(document.activeElement).toBe(cell);
  let reads = 0;
  Object.defineProperty(cell, "scrollTop", { configurable: true, get() { reads++; return 0; }, set() {} });
  await sync._doApplyExternal(diskDoc(page([["r1", "a1", "b1"], ["r2", "peer a2", "b2"]], "note from disk")), 70, "etag-70");
  expect(document.querySelector('[data-id="note"]').textContent).toBe("note from disk");
  expect(document.activeElement).toBe(cell);
  expect(reads).toBe(0);
  const note = document.querySelector('[data-id="note"]');
  note.setAttribute("tabindex", "0");
  note.focus();
  let outside = 0;
  Object.defineProperty(note, "scrollTop", { configurable: true, get() { outside++; return 0; }, set() {} });
  await sync._doApplyExternal(diskDoc(page([["r1", "a1", "b1"], ["r2", "peer a2", "b2"]], "note again")), 71, "etag-71");
  expect(outside).toBeGreaterThan(0);
});
