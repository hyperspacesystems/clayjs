/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { afterEach, expect, jest, test } from "@jest/globals";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

function resetPage(body) {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.Sap;
  delete window.sapPlugins;
  delete window.clayEditMode;
  window.clay = { ready: Promise.resolve() };
  document.head.innerHTML = "";
  document.body.innerHTML = body;
}

const BOOK = ({ extraRule = "", commit = '{"v":2,"doc":"doc0123456789abc","gen":"0.00000000","epoch":0,"commit":"c00000000000","parent":null,"through":0,"lineage":[],"cut":null,"floor":-1,"seen":{}}' } = {}) =>
  `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="1">1</td><td n v="2">2</td></tr>
<tr data-id="r2" data-pos="l"><td n v="3">3</td><td n v="4">4</td></tr>
</tbody>${extraRule ? `<template rules>${extraRule}</template>` : ""}</table></section>
<section item data-id="s2" data-pos="l"><h2 bind="name">Second</h2><table grid><colgroup><col data-id="c3" data-pos="V"></colgroup>
<tbody><tr data-id="r3" data-pos="V"><td n v="9">9</td></tr></tbody></table></section>
<script type="application/json" sheet-commit>${commit}</script>
</div></main>`;

function fakeRoom(codec, inner) {
  let { doc } = codec.read(inner);
  const listeners = new Set();
  const submitted = [];
  let n = 0;
  return {
    ready: Promise.resolve(),
    status: { mode: "ordered", pending: 0, unsaved: 0, unstored: 0, unknownSave: false },
    submitted,
    view: () => JSON.parse(JSON.stringify(doc)),
    submit(action) {
      submitted.push(action);
      const out = codec.apply(doc, action);
      if (out.out !== "applied") return null;
      doc = out.doc ?? doc;
      n += 1;
      for (const listener of listeners) listener({ type: "change" });
      return { id: `me:${n}`, admitted: Promise.resolve("shared"), durable: Promise.resolve("saved") };
    },
    peer(action) {
      const out = codec.apply(doc, action);
      if (out.out !== "applied") throw new Error(`peer action ${out.out}`);
      doc = out.doc ?? doc;
      for (const listener of listeners) listener({ type: "change" });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function mountWithUI(body = BOOK(), bindingOpts = {}) {
  resetPage(body);
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { startShell, sheetHooks } = await import("../../../src/sheet/shell.js");
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const { startInterface } = await import("../../../src/sheet/interface.js");
  const { createRoomBinding } = await import("../../../src/sheet/room.js");

  const shell = startShell();
  let ui = null;
  const books = ownWorkbooks({
    onRebuild: () => {
      shell.restart();
      ui?.restart();
    },
  });
  sheetHooks.bookOf = (el) => books.books.get(el) ?? null;
  await books.ready;
  Sap.mount();
  await turn();
  ui = startInterface({ shell });
  const root = document.querySelector("[sheet-workbook]");
  const book = books.books.get(root);
  const inst = ui.of(root);
  const grid = Sap.grid(root.querySelector('section[data-id="s1"] table[grid]'));
  const room = fakeRoom(Sap.grid.roomCodec, book.serialize({ purpose: "recovery" }));
  const binding = createRoomBinding(book, {
    Sap,
    notice: (text, action) => inst.notice(text, action),
    reveal: (target) => inst.reveal(target),
    setConflicts: (targets) => inst.setConflicts(targets),
    ...bindingOpts,
  });
  grid.dispatch = binding.dispatchFor(grid, grid.dispatch.bind(grid));
  await binding.start(room);
  return { Sap, book, root, grid, room, binding, ui, inst };
}

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  jest.restoreAllMocks();
});

// Bug: interface.js cleared the notice bar right after a partial undo, hiding which cell a coworker kept.
test("partial undo keeps its notice visible in the sheet chrome", async () => {
  const { grid, room, inst } = await mountWithUI();
  grid.setRange("A1", [["10", "20"]]);
  room.peer({ v: 1, t: "set", sheet: "s1", cells: [["r1", "c2", 99]] });
  await new Promise((r) => setTimeout(r, 25));

  const undoBtn = inst.chrome.topShadow.querySelector('[data-command="undo"]');
  expect(undoBtn.getAttribute("aria-disabled")).not.toBe("true");
  undoBtn.click();

  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(inst.chrome.noticeBar.textContent).toContain("Undid your change except");
  expect(inst.chrome.noticeBar.textContent).toContain("Sheet1!B1");
});

// Bug: undo stacks grew without a byte ceiling, or never told the person when older steps dropped.
test("undo stack byte cap drops oldest entries and shows the cap notice once", async () => {
  const { grid, inst } = await mountWithUI(BOOK(), { maxBytes: 250 });

  grid.set("A1", "11");
  grid.set("A2", "22");
  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(inst.chrome.noticeBar.textContent).toContain("Older changes can no longer be undone.");

  inst.chrome.hideNotice();
  grid.set("B1", "33");
  expect(inst.chrome.noticeBar.hidden).toBe(true);
});

// Bug: reveal and conflict tint were missing, so C9b's panel could not focus or mark conflict cells.
test("reveal switches tabs and selects the target, and setConflicts paints and clears the tint", async () => {
  const { binding, inst } = await mountWithUI();

  expect(binding.reveal("s2/r3/c3")).toBe(true);
  expect(inst.selection.tab).toBe("s2");
  expect(inst.selection.anchor).toEqual({ row: "r3", col: "c3" });

  binding.setConflicts(["s2/r3/c3"]);
  expect(inst.overlays.root.querySelectorAll("[data-sheet-conflict]")).toHaveLength(1);

  binding.setConflicts([]);
  expect(inst.overlays.root.querySelectorAll("[data-sheet-conflict]")).toHaveLength(0);
});

// Bug: beforeunload did not warn while the room held pending, unsaved, or unstored edits.
test("beforeunload warns while the room has pending or unsaved edits and stays silent when clean", async () => {
  const { room } = await mountWithUI();

  const clean = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);

  room.status.unsaved = 1;
  const dirty = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);
});

// Bug: heard() compared a missing `rev` field on v2 records, ignoring every newer save from live sync.
test("heard updates committedInner for a newer v2 commit record and ignores an older one", async () => {
  const { binding } = await mountWithUI();
  const base = binding.committedInner();
  const newer = base.replace('"through":0', '"through":4').replace('"c00000000000"', '"c00000000004"');
  const older = base.replace('"through":0', '"through":2').replace('"c00000000000"', '"c00000000002"');

  binding.heard({ html: `<div sheet-workbook>${newer}</div>` });
  expect(binding.committedInner()).toBe(newer);

  binding.heard({ html: `<div sheet-workbook>${older}</div>` });
  expect(binding.committedInner()).toBe(newer);
});

// Bug: history.group did not batch room actions, sending multiple separate room actions per command.
test("binding.group collects multiple dispatches into one room batch action", async () => {
  const { grid, room, binding } = await mountWithUI();

  binding.group("s1", () => {
    grid.set("A1", "7");
    grid.set("B1", "8");
  });

  expect(room.submitted).toHaveLength(1);
  expect(room.submitted[0].t).toBe("batch");
  expect(room.submitted[0].actions).toHaveLength(2);
});

// Bug: a page with duplicate rule ids joined the room instead of offering repair first, or allowed repair while joined.
test("a sheet with rule_id_duplicate offers repair on a room host, joins after repair and save, and blocks repair while joined", async () => {
  const dupRules =
    '<rule data-id="k1" data-pos="V" kind="check" range="A1"></rule><rule data-id="k1" data-pos="l" kind="check" range="B1"></rule>';
  resetPage(BOOK({ extraRule: dupRules }));
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;

  const liveRooms = [];
  let saveResult = { msg: "Error", msgType: "error" };
  window.clay.save = jest.fn(async () => saveResult);
  window.clay.liveRoom = jest.fn((_name, { codec }) => {
    const root = document.querySelector("[sheet-workbook]");
    const book = sheet.books.get(root);
    const r = fakeRoom(codec, book.serialize({ purpose: "recovery" }));
    liveRooms.push(r);
    return r;
  });

  const { sheet, ready } = await import("../../../src/sheet/sheet.js");
  await ready;
  Sap.mount();
  await turn();
  await turn();
  await turn();

  expect(liveRooms).toHaveLength(0);
  const inst = sheet.ui.of(document.querySelector("[sheet-workbook]"));
  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(inst.chrome.noticeBar.textContent).toContain("Repair this sheet to edit it with others.");

  // A failed repair save keeps the banner and does not join the room.
  const repairBtn = inst.chrome.topShadow.querySelector("[data-sheet-notice-action]");
  expect(repairBtn.textContent).toBe("Repair");
  repairBtn.click();
  await turn();
  await turn();
  await turn();
  expect(liveRooms).toHaveLength(0);
  expect(inst.chrome.noticeBar.hidden).toBe(false);

  // Once the save succeeds, the sheet joins the room and blocks repair while joined.
  saveResult = { msg: "Saved", msgType: "saved" };
  inst.chrome.topShadow.querySelector("[data-sheet-notice-action]").click();
  await turn();
  await turn();
  await turn();

  expect(window.clay.save).toHaveBeenCalledTimes(2);
  expect(liveRooms).toHaveLength(1);
  expect(sheet.room).toBeTruthy();

  const grid = Sap.grid(document.querySelector('section[data-id="s1"] table[grid]'));
  expect(() => grid.repair()).toThrow(/live room/);
});

// Bug: Insert checkbox split into two undo steps, leaving FALSE behind after one undo; undo also
// left selection behind instead of jumping to the changed cells.
test("Insert checkbox undoes in one step and moves selection back to the changed cells", async () => {
  const { root, grid, binding, inst } = await mountWithUI();
  const td = (r, c) => root.querySelectorAll('section[data-id="s1"] tbody tr')[r].children[c];
  binding.group("s1", () => {
    grid.set("B1", "");
    grid.set("B2", "");
  });
  binding.group("s1", () => {
    grid.set("B1", "FALSE");
    grid.set("B2", "FALSE");
    grid.dispatch({ v: 1, t: "rules", sheet: "s1", set: [{ id: "k_cb", pos: "V", kind: "check", range: "B1:B2" }], remove: [] });
  });
  expect(grid.rules()).toHaveLength(1);
  expect(td(0, 1).textContent).toBe("FALSE");

  // Move selection away to A1, then trigger Undo through the chrome button.
  inst.reveal("s1/r1/c1");
  expect(inst.selection.anchor).toEqual({ row: "r1", col: "c1" });
  inst.chrome.topShadow.querySelector('[data-command="undo"]').click();

  expect(grid.rules()).toHaveLength(0);
  expect(td(0, 1)?.textContent ?? "").toBe("");
  expect(td(1, 1)?.textContent ?? "").toBe("");
  expect(inst.selection.anchor.col).toBe("c2");
});

// Bug: resolveTarget dropped row-only, column-only, and sheet-only targets from reveal/setConflicts.
test("reveal and setConflicts handle row, column, and sheet targets", async () => {
  const { binding, inst } = await mountWithUI();

  expect(binding.reveal("s1/r2#style")).toBe(true);
  expect(inst.selection.anchor).toEqual({ row: "r2", col: "c1" });
  expect(inst.selection.focus).toEqual({ row: "r2", col: "c2" });

  expect(binding.reveal("s1//c2#fmt")).toBe(true);
  expect(inst.selection.anchor).toEqual({ row: "r1", col: "c2" });
  expect(inst.selection.focus).toEqual({ row: "r2", col: "c2" });

  expect(binding.reveal("s1#freezeRows")).toBe(true);
  binding.setConflicts(["s1/r2#style", "s1//c2#fmt", "s1#freezeRows"]);
  expect(inst.overlays.root.querySelectorAll("[data-sheet-conflict]")).toHaveLength(3);
});

// Bug: premature bind on a non-room host lost pre-ready edits, disabled beforeunload/unsaved-state,
// and returned stale committedInner from serialize("save") before ready.
test("pre-ready edits register unsaved state and hand back revision on unavailable host", async () => {
  resetPage(BOOK());
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { hasUnsavedState } = await import("../../../src/lib/unsaved-state.js");
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const { createRoomBinding } = await import("../../../src/sheet/room.js");

  const books = ownWorkbooks({});
  await books.ready;
  Sap.mount();
  await turn();
  const root = document.querySelector("[sheet-workbook]");
  const book = books.books.get(root);
  const grid = Sap.grid(root.querySelector('section[data-id="s1"] table[grid]'));
  let finishReady;
  const pendingRoom = {
    ready: new Promise((r) => (finishReady = r)),
    status: { mode: "connecting", pending: 0, unsaved: 0, unstored: 0, unknownSave: false },
    view: () => null,
    subscribe: () => () => {},
    close: jest.fn(),
  };
  const binding = createRoomBinding(book, { Sap });
  grid.dispatch = binding.dispatchFor(grid, grid.dispatch.bind(grid));
  const started = binding.start(pendingRoom);

  grid.set("B1", "777");
  expect(hasUnsavedState()).toBe(true);
  expect(book.serialize({ purpose: "save" })).toContain(">777<");
  const ev = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(ev);
  expect(ev.defaultPrevented).toBe(true);

  pendingRoom.status.mode = "unavailable";
  finishReady();
  await started;
  expect(book.room).toBeNull();
  expect(book.revision).toBeGreaterThan(0);
  expect(pendingRoom.close).toHaveBeenCalledTimes(1);
});

// Bug: oversized action returned false instead of throwing GridRefused, letting writeGrid wipe the notice.
test("oversized room action throws GridRefused and keeps the refusal notice visible", async () => {
  const { root, grid, room, inst } = await mountWithUI();
  room.submit = () => null;

  expect(() => grid.set("A1", "999")).toThrow(/too large to share/);
  expect(inst.chrome.noticeBar.hidden).toBe(false);
  expect(inst.chrome.noticeBar.textContent).toContain("That change is too large to share.");
  expect(root.querySelector('section[data-id="s1"] tbody tr').children[0].textContent).toBe("1");
});

// Bug: newer() accepted an older gen in the same epoch and an older file-mode commit, and heard({ document }) failed codec.read.
test("heard ignores older same-epoch gen and older file-mode commits, and reads document fallback", async () => {
  const { binding } = await mountWithUI();
  const base = binding.committedInner();
  const gen2 = base.replace('"gen":"0.00000000"', '"gen":"0.00000002"').replace('"c00000000000"', '"c00000000002"');
  const gen1 = base.replace('"gen":"0.00000000"', '"gen":"0.00000001"').replace('"c00000000000"', '"c00000000001"');

  binding.heard({ html: `<div sheet-workbook>${gen2}</div>` });
  expect(binding.committedInner()).toBe(gen2);
  binding.heard({ html: `<div sheet-workbook>${gen1}</div>` });
  expect(binding.committedInner()).toBe(gen2);

  // File mode (through === 0): only a child commit descending from the held commit advances it.
  const child = gen2.replace('"c00000000002"', '"c00000000003"').replace('"parent":null', '"parent":"c00000000002"');
  binding.heard({ html: `<div sheet-workbook>${child}</div>` });
  expect(binding.committedInner()).toBe(child);
  binding.heard({ html: `<div sheet-workbook>${gen2}</div>` });
  expect(binding.committedInner()).toBe(child);

  // Document fallback normalizes empty boolean attributes so codec.read succeeds.
  const childNext = child.replace('"c00000000003"', '"c00000000004"').replace('"parent":"c00000000002"', '"parent":"c00000000003"');
  const parsed = new DOMParser().parseFromString(`<html><body><div sheet-workbook>${childNext}</div></body></html>`, "text/html");
  binding.heard({ document: parsed });
  expect(binding.committedInner()).toContain('"c00000000004"');
});

// Bug: peer changeCols fmt skipped formula cells, leaving old formatted text in DOM and saved bytes.
test("peer column format change repaints formula cells in that column", async () => {
  const body = `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="0.25">0.25</td></tr>
<tr data-id="r2" data-pos="l"><td n f="=A1" v="0.25">0.25</td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit>{"v":2,"doc":"doc0123456789abc","gen":"0.00000000","epoch":0,"commit":"c00000000000","parent":null,"through":0,"lineage":[],"cut":null,"floor":-1,"seen":{}}</script>
</div></main>`;
  const { root, room, binding } = await mountWithUI(body);
  room.peer({ v: 1, t: "changeCols", sheet: "s1", cols: [{ id: "c1", fmt: "0.00%" }] });

  const tds = root.querySelectorAll('section[data-id="s1"] tbody td');
  expect(tds[0].textContent).toBe("25.00%");
  expect(tds[1].textContent).toBe("25.00%");
  const base = `<html><body><main sap plugins="grid"><div items="sheets" sheet-workbook>${binding.committedInner()}</div></main></body></html>`;
  const saved = binding.page(binding.committedInner(), base);
  expect(saved).toContain(">25.00%<");
});

// Bug: sort/freeze undo showed raw target IDs or claimed partial undo on a no-op freeze revert.
test("conflicting freeze undo rejects no-op revert cleanly without duplicate labels or raw IDs", async () => {
  const { grid, room, binding, inst } = await mountWithUI();
  grid.dispatch({ v: 1, t: "freeze", sheet: "s1", rowsThrough: "r1", colsThrough: null });
  room.peer({ v: 1, t: "deleteRows", sheet: "s1", rows: ["r1"] });

  const res = binding.undo("s1");
  expect(res.ok).toBe(false);
  expect(res.why).toBe("changed");
  expect(inst.chrome.noticeBar.textContent).not.toMatch(/s1#|Sheet1, Sheet1/);
  expect(binding.canRedo("s1")).toBe(false);
});

// Bug: sheet.js did not mount C9b's save chip in the bottom bar or "Recovered edits" in More,
// downloadSheetCopy exported the live sheet instead of the stored recovery copy, double clicking
// opened duplicate drawers, and leaveRoom did not tear down the chip cleanly.
test("joining a room mounts the save chip, downloads stored recovery copies cleanly, deduplicates recovery drawers, and tears down on leaveRoom", async () => {
  resetPage(BOOK());
  const Sap = (await import("../../../src/vendor/sap-core.vendor.js")).default;
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const origGetHTML = window.clay.getHTML;
  window.clay.getHTML = () => `<!doctype html><html><body><main sap plugins="grid"><div items="sheets" sheet-workbook>${document.querySelector("[sheet-workbook]").innerHTML}</div></main></body></html>`;
  const origCreateObjectURL = URL.createObjectURL;
  const origRevokeObjectURL = URL.revokeObjectURL;
  const capturedBlobs = [];
  URL.createObjectURL = (blob) => {
    capturedBlobs.push(blob);
    return "blob:test-copy";
  };
  URL.revokeObjectURL = () => {};

  let sheet;
  let ready;
  let joinedRoom = null;
  window.clay.liveRoom = jest.fn((_name, { codec }) => {
    const root = document.querySelector("[sheet-workbook]");
    const book = sheet.books.get(root);
    const liveInner = book.serialize({ purpose: "recovery" });
    const copyBody = liveInner.replace(">1<", ">RECOVERED_SECRET<");
    joinedRoom = {
      ...fakeRoom(codec, liveInner),
      status: { mode: "ordered", connected: true, pending: 0, unsaved: 0, unstored: 0, unknownSave: false, copies: 1, restoring: false, pendingMarks: 0, conflicts: 0, error: null },
      copies: () => [{ id: "r99", v: 4, at: 1000, body: copyBody, edits: [{ e: "a:1", c: "a", n: 1, out: "applied", action: { v: 1, t: "set", sheet: "s1", row: "r1", col: "c1", value: "RECOVERED_SECRET" }, saw: [] }], refused: [], marks: [] }],
      unstoredCopies: () => [],
      notices: () => [],
      refreshCopies: async () => {},
      capture: () => ({ bytes: "", record: {} }),
      close: async () => {},
    };
    return joinedRoom;
  });

  try {
    ({ sheet, ready } = await import("../../../src/sheet/sheet.js"));
    await ready;
    Sap.mount();
    await turn();
    await turn();
    await turn();
    await new Promise((r) => setTimeout(r, 20));

    const inst = sheet.ui.of(document.querySelector("[sheet-workbook]"));
    expect(inst.chrome.roomChipSlot.children.length).toBe(1);
    expect(inst.chrome.roomChipSlot.textContent).toContain("Saved");
    inst.chrome.topShadow.querySelector('[data-command="more"]').click();
    await new Promise((r) => setTimeout(r, 25));
    const menuButtons = [...document.querySelectorAll('[clay~="editor-ui"], [editor-ui]')].flatMap((host) => [...(host.shadowRoot?.querySelectorAll("button") ?? [])]);
    const recoveredBtn = menuButtons.find((btn) => btn.textContent?.includes("Recovered edits"));
    expect(recoveredBtn).toBeTruthy();

    // Double-clicking "Recovered edits" mounts exactly one recovery drawer.
    recoveredBtn.click();
    recoveredBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    const drawers = [...document.querySelectorAll('[clay~="editor-ui"], [editor-ui]')].filter((host) => host.shadowRoot?.querySelector("[data-live-room-recovery]"));
    expect(drawers).toHaveLength(1);

    // Clicking "Download copy" on stored copy r99 writes a full HTML page with the copy's value.
    const dlBtn = [...drawers[0].shadowRoot.querySelectorAll("button")].find((btn) => btn.textContent?.includes("Download copy"));
    expect(dlBtn).toBeTruthy();
    dlBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    expect(capturedBlobs).toHaveLength(1);
    const downloadedText = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsText(capturedBlobs[0]);
    });
    expect(downloadedText).toContain("<!doctype html>");
    expect(downloadedText).toContain("RECOVERED_SECRET");
    expect(downloadedText).not.toContain(">1<");

    sheet.leaveRoom();
    expect(inst.chrome.roomChipSlot.children).toHaveLength(0);
    await joinedRoom.close();
  } finally {
    window.clay.getHTML = origGetHTML;
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
  }
});
