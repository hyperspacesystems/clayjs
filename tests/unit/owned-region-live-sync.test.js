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

let LiveSync;
let save;
let snapshot;
let gate;
let regions;
let autosaveState;
let stamps;
let unsavedWarning;
let Mutation;

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
const rowsHtml = (rows) => `<tbody>${rows.map(([id, a, b]) => `<tr data-id="${id}"><td>${a}</td><td>${b}</td></tr>`).join("")}</tbody>`;
const page = (rows, note) => `<section item data-id="tab-1"><table grid>${rowsHtml(rows)}</table></section><p data-id="note">${note}</p>`;
const diskDoc = (body) => `<!DOCTYPE html><html><head></head><body>${body}</body></html>`;

function makeSheet() {
  const table = document.querySelector("table[grid]");
  const state = { rev: 1, unsaved: new Set(), merges: [], rows: new Map(), fail: null };
  for (const tr of table.querySelectorAll("tr")) {
    state.rows.set(tr.dataset.id, [tr.children[0].textContent, tr.children[1].textContent]);
  }
  const paint = () => {
    for (const tr of table.querySelectorAll("tr")) {
      const row = state.rows.get(tr.dataset.id);
      if (tr.children[0].textContent !== row[0]) tr.children[0].textContent = row[0];
      if (tr.children[1].textContent !== row[1]) tr.children[1].textContent = row[1];
    }
  };
  state.edit = (id, col, text, { notify = false } = {}) => {
    state.rows.get(id)[col] = text;
    state.unsaved.add(`${id}:${col}`);
    state.rev++;
    paint();
    if (notify) state.handle.notify(table);
  };
  state.handle = regions.own("section[item] > table[grid]", {
    serialize: () => rowsHtml([...state.rows].map(([id, row]) => [id, ...row])),
    revision: () => state.rev,
    merge: (incoming) => {
      const theirs = [...incoming.document.querySelectorAll("table[grid] tr")].map((tr) => [tr.dataset.id, tr.children[0].textContent, tr.children[1].textContent]);
      const baseRows = new Map(
        incoming.base
          ? [...incoming.base.querySelectorAll("table[grid] tr")].map((tr) => [tr.dataset.id, [tr.children[0].textContent, tr.children[1].textContent]])
          : []
      );
      state.merges.push({ source: incoming.source, etag: incoming.etag, baseR2: baseRows.get("r2")?.[0] ?? null });
      if (state.fail === "before") throw new Error("merge failed");
      return () => {
        if (state.fail === "after") throw new Error("merge failed after");
        let changed = false;
        for (const [id, a, b] of theirs) {
          const mine = state.rows.get(id);
          const baseRow = baseRows.get(id) || mine;
          // Standard 3-way cell merge: if mine === base, take theirs; else keep mine
          if (mine[0] === baseRow[0] && mine[0] !== a) { mine[0] = a; changed = true; }
          if (mine[1] === baseRow[1] && mine[1] !== b) { mine[1] = b; changed = true; }
          if (mine[0] === a) state.unsaved.delete(`${id}:0`);
          if (mine[1] === b) state.unsaved.delete(`${id}:1`);
        }
        if (changed) state.rev++;
        paint();
        return state.unsaved.size > 0;
      };
    },
  });
  return state;
}

let savesSent = [];
let metaEtag = "etag-1";
let saveStatus = 200;
let saveBody = { msg: "Saved", etag: "etag-saved" };

beforeAll(async () => {
  window.clayEditMode = true;
  global.EventSource = FakeEventSource;
  window.EventSource = FakeEventSource;
  window.scrollTo = () => {};
  global.fetch = jest.fn(async (url, init = {}) => {
    if (String(url).includes("/_/meta")) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ spec: 1, extensions: ["conditional"], document: { etag: metaEtag } }),
        json: async () => ({ spec: 1, extensions: ["conditional"], document: { etag: metaEtag } }),
      };
    }
    if (init.method === "POST" && !String(url).includes("/_/presence") && !String(url).includes("/_/sync")) {
      const h = init.headers;
      const ifMatch = h instanceof Headers ? h.get("If-Match") : (h?.["If-Match"] ?? h?.["if-match"] ?? null);
      savesSent.push({ url: String(url), body: String(init.body), ifMatch });
      return {
        ok: saveStatus < 400,
        status: saveStatus,
        statusText: "",
        headers: { get: () => null },
        text: async () => JSON.stringify(saveBody),
      };
    }
    return { ok: false, status: 404, statusText: "", headers: { get: () => null }, text: async () => "" };
  });
  Mutation = (await import("../../src/lib/mutation.js")).default;
  const liveSyncModule = await import("../../src/sync/live-sync.js");
  ({ LiveSync } = liveSyncModule);
  liveSyncModule.liveSync.stop();
  save = await import("../../src/core/save.js");
  snapshot = await import("../../src/core/snapshot.js");
  gate = await import("../../src/lib/dirty-gate.js");
  regions = await import("../../src/lib/owned-regions.js");
  autosaveState = await import("../../src/lib/autosave-state.js");
  stamps = await import("../../src/core/etag.js");
  unsavedWarning = await import("../../src/core/unsaved-warning.js");
  await stamps.seedEtag({ fresh: true });
  save.releaseBootSettle();
  await turn();
});

let owner = null;
let sync = null;

beforeEach(async () => {
  savesSent = [];
  metaEtag = "etag-1";
  saveStatus = 200;
  saveBody = { msg: "Saved", etag: "etag-saved" };
  stamps.recordEtag("etag-1");
  window.clay = { Mutation };
  document.documentElement.setAttribute("autosave", "");
  document.body.innerHTML = page([["r1", "a1", "b1"], ["r2", "a2", "b2"]], "note 0");
  owner = makeSheet();
  save.setLastSavedBaselines(snapshot.captureForComparison(), snapshot.captureForDirtyCheck());
  save.setUnsavedChanges(false);
  autosaveState.setAutosaveActive(true);
  sync = new LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  sync._diskBase = snapshot.captureForSaveAndComparison({ emitForSync: false }).forSave;
  sync.lastHtml = snapshot.serializeForSync(snapshot.captureSnapshot({ flushUndo: false, purpose: "sync" }));
  await turn();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
});

afterEach(() => {
  save.ownedMergeRecovered(null);
  owner?.handle?.dispose();
  sync?.stop();
  autosaveState.setAutosaveActive(false);
});

test("an owned-region edit made while a merge waits for a script is saved, never recorded as saved", async () => {
  const incoming = diskDoc(page([["r1", "a1", "b1"], ["r2", "peer a2", "b2"]], "note 1") + '<script src="/ext-pack.js"></script>');
  const applying = sync._doApplyUpdate(incoming, 10, null, "etag-10");
  await turn();
  const script = document.querySelector('script[src="/ext-pack.js"]');
  expect(script).not.toBeNull();

  // User edits r1:1 in the owned region (and calls notify()) while script is loading!
  owner.edit("r1", 1, "unsaved user cell", { notify: true });

  script.dispatchEvent(new Event("load"));
  await applying;
  await turn();

  const cmdS = await save.savePage();
  expect(cmdS).toBeTruthy();
  expect(savesSent.some((sent) => sent.body?.includes("unsaved user cell"))).toBe(true);
});

test("an unstamped disk frame whose owned merge fails never gives this tab the unmerged version's stamp", async () => {
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  owner.edit("r1", 1, "mine");
  await turn();
  metaEtag = "etag-60-unmerged";
  owner.fail = "before";

  // Unstamped disk frame (e.g. content-less external-change fetch fallback)
  await sync._doApplyExternal(diskDoc(page([["r1", "a1", "b1"], ["r2", "disk a2", "b2"]], "note disk")), 20, null);
  await turn();
  await turn();
  spy.mockRestore();

  saveStatus = 200;
  saveBody = { msg: "Saved", etag: "etag-61" };
  const res = await save.savePage();
  expect(res).toBeTruthy();
  expect(savesSent.some((sent) => sent.ifMatch === "etag-60-unmerged")).toBe(false);
});

test("a failed owned merge at the stamp this tab holds keeps its hold and sends no save over that version", async () => {
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  // Start liveSync listener wiring (_saveConflictHandler)
  sync.start("sheet.html", { lane: "live" });
  await sync._ready;
  owner.edit("r1", 1, "mine");
  await turn();

  // Peer lane already recorded etag-60, or unstamped boot seeded etag-60; now disk lane fails merge on etag-60
  stamps.recordEtag("etag-60");
  owner.fail = "before";
  saveStatus = 200;
  saveBody = { msg: "Saved", etag: "etag-61" };

  await sync._doApplyExternal(diskDoc(page([["r1", "a1", "b1"], ["r2", "disk a2", "b2"]], "note disk")), 30, "etag-60");
  await new Promise((r) => setTimeout(r, 1250));
  spy.mockRestore();

  expect(save.isSaveConflicted()).toBe(true);
  expect(savesSent.some((sent) => sent.ifMatch === "etag-60")).toBe(false);
});

test("after a peer merge recovers a failed disk merge, the next disk merge reads the recovered base and keeps the person's edit", async () => {
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  // 1. Disk frame 1 fails merge at base r2="a2"
  owner.fail = "before";
  await sync._doApplyExternal(diskDoc(page([["r1", "a1", "b1"], ["r2", "bad", "b2"]], "note 1")), 40, "etag-40");

  // 2. Peer frame 2 succeeds merge and updates r2 to "mid"
  owner.fail = null;
  await sync._doApplyUpdate(diskDoc(page([["r1", "a1", "b1"], ["r2", "mid", "b2"]], "note 2")), 41, null, "etag-41");
  expect(owner.rows.get("r2")[0]).toBe("mid");
  expect(save.isSaveConflicted()).toBe(false);

  // 3. User edits r2[0] back from "mid" to "a2"!
  owner.edit("r2", 0, "a2", { notify: true });
  await turn();
  expect(owner.rows.get("r2")[0]).toBe("a2");

  // 4. Disk frame 3 arrives with r2 still "mid" and note="note 3"
  await sync._doApplyExternal(diskDoc(page([["r1", "a1", "b1"], ["r2", "mid", "b2"]], "note 3")), 42, "etag-42");
  spy.mockRestore();

  // Stale base "a2" instead of "mid" made 3-way merge overwrite user's "a2" with "mid"!
  expect(owner.merges.at(-1).baseR2).toBe("mid");
  expect(owner.rows.get("r2")[0]).toBe("a2");
});

test("a late frame that recovers an owned merge never releases a newer refused save's hold", async () => {
  const spy = jest.spyOn(console, "error").mockImplementation(() => {});
  owner.edit("r1", 1, "mine");
  await turn();

  // 1. Disk frame etag-60 fails owned merge -> ownedMergeHold = true, conflictEtag = "etag-60"
  owner.fail = "before";
  await sync._doApplyExternal(diskDoc(page([["r1", "a1", "b1"], ["r2", "bad", "b2"]], "note 1")), 35, "etag-60");
  expect(save.isSaveConflicted()).toBe(true);

  // 2. User presses Cmd+S -> server refuses 412 with NEWER conflictEtag "etag-70"
  saveStatus = 412;
  saveBody = { msg: "Conflict", code: "conflict", etag: "etag-70" };
  const r412 = await save.savePage();
  expect(r412.msgType).toBe("conflict");
  expect(save.isSaveConflicted()).toBe(true);

  // 3. Older peer frame "etag-60" arrives and merges -> ownedMergeRecovered("etag-60") clears conflictHold even though etag-70 was never merged!
  owner.fail = null;
  await sync._doApplyUpdate(diskDoc(page([["r1", "a1", "b1"], ["r2", "ok60", "b2"]], "note 60")), 36, null, "etag-60");
  spy.mockRestore();

  expect(save.isSaveConflicted()).toBe(true);
  expect(save.autosaveIsSuspended()).toBe(true);
});

test("a merge that moves only the owner's model leaves the tab clean, and an edit made under a pause is announced when the pause ends", async () => {
  // Part A: merge updates commit record / formula without changing visible <td> text -> state.rev becomes 2, no DOM mutation inside table
  owner.rev = 1;
  const origMerge = owner.handle;
  origMerge.dispose();
  let rev = 1;
  const h2 = regions.own("section[item] > table[grid]", {
    serialize: () => `<tbody><tr data-id="r1"><td>a1</td><td>b1</td></tr></tbody><!--commit:${rev}-->`,
    revision: () => rev,
    merge: () => () => { rev = 2; return false; },
  });
  await sync._doApplyExternal(diskDoc(page([["r1", "a1", "b1"], ["r2", "a2", "b2"]], "note 1")), 50, "etag-50");
  expect(gate.pageMaybeDirty()).toBe(false);

  // User clicks a cell (UI selection class only; rev is still 2!)
  document.querySelector("table[grid] td").setAttribute("class", "selected");
  await turn();
  const dirtyAfterClick = gate.pageMaybeDirty();
  h2.dispose();

  // Part B: with a non-pausable subscriber (like preserve-authored.js / admin-attrs.js on every real page),
  // mutating inside pause()/resume() consumes lastRevision so notify() after resume() is dropped!
  owner = makeSheet();
  await turn();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
  Mutation.pause();
  owner.edit("r1", 0, "edited in pause");
  Mutation.resume();
  owner.handle.notify();
  await turn();
  const dirtyAfterNotify = gate.pageMaybeDirty();

  expect(dirtyAfterClick).toBe(false);
  expect(dirtyAfterNotify).toBe(true);
});
