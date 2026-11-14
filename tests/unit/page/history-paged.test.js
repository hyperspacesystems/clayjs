/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/notes.html"}
 */
import { jest } from "@jest/globals";

/**
 * One owner for every undo route.
 *
 * A page that loads both `blockeditor` and `undo` has one history: typing in the essay is a
 * page entry, the editor's own Cmd+Z, its features' undo and `clay.blockeditor.history` all
 * walk the page's timeline, and the dock reads the same one. While a proposal preview shows
 * the page history is held. A page without `undo` behaves as it always did.
 */

const BLOCKS = [{ id: "p", t: "paragraph", text: "Hello" }];
const BOARD = { id: "bd", t: "board", attrs: { columns: { todo: { pos: "1", name: "To do" } }, cards: {} } };

const clone = (value) => JSON.parse(JSON.stringify(value));
const flushAsync = async (turns = 40) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };
const until = async (check, tries = 300) => {
  for (let i = 0; i < tries; i++) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
};

let clock = 0;
beforeEach(() => {
  clock = 1000000;
  jest.spyOn(Date, "now").mockImplementation(() => clock);
});

let session = null;
let page = null;
const watched = [];

afterEach(() => {
  for (const { type, handler } of watched.splice(0)) document.removeEventListener(type, handler);
  try { page?.dispose(); } catch {}
  page = null;
  session?.dispose();
  session = null;
  jest.restoreAllMocks();
  window.clay = undefined;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

const tagHtml = (value) => `<script type="application/json" merge="blockeditor" clay="live">${JSON.stringify(value)}</script>`;

const NOTE = '<p id="side">side</p>';

async function open({ blocks = BLOCKS, paged = true, extra = "" } = {}) {
  jest.resetModules();
  const { seedValue } = await import("../../../src/page/ybind/seed.js");
  const { renderFromTags } = await import("../../../src/page/save-projection.js");
  const value = seedValue(clone(blocks));
  const { html, rev } = renderFromTags([JSON.stringify(value)]);
  document.head.innerHTML = tagHtml(value);
  document.body.innerHTML = `<article data-blockeditor="1" data-rev="${rev}">${html}</article>${extra}`;

  await jest.unstable_mockModule("../../../src/core/host-meta.js", () => ({
    hostMeta: async () => ({ spec: 1, extensions: ["blockeditor"], document: null }),
    hostSupports: async (name) => name === "blockeditor",
    hostMetaOutcome: () => "ok",
    querySaveOutcome: () => null,
    resetHostMeta: () => ({}),
  }));

  await jest.unstable_mockModule("../../../src/core/save.js", () => ({
    claimFailure: () => {},
    savesAdmitted: () => true,
    savePageForce: async () => ({ ok: true, msgType: "success" }),
    savePage: async () => ({ ok: true, msgType: "success" }),
    savePageThrottled: () => {},
    baselineSettled: () => true,
    isSaveConflicted: () => false,
    autosaveIsSuspended: () => false,
    suspendAutosave: () => {},
    resumeAutosave: () => {},
    holdAllSaves: () => {},
    releaseAllSaves: () => {},
    getLastSavedDirty: () => false,
    setLastSavedBaselines: () => {},
    getLastSavedBytes: () => null,
  }));

  await jest.unstable_mockModule("../../../src/live/local-lane.js", () => ({
    localLaneSupported: () => false,
    localTransport: () => ({}),
  }));

  await jest.unstable_mockModule("../../../src/live/server-lane.js", () => ({
    serverTransport: () => ({
      start(handlers) {
        handlers.open({ clientId: "tab-1", lane: "live" });
        handlers.state({ epoch: "e1", seq: 0, writer: null, conn: 0, stores: { blockeditor: { value: clone(value), ephemeral: false, last: 0, landed: 0 } } });
        return () => {};
      },
      async send() { return { status: 200, body: { seq: 1, epoch: "e1" } }; },
      async fetchState() {
        return { epoch: "e1", seq: 0, writer: null, conn: 0, stores: { blockeditor: { value: clone(value), ephemeral: false, last: 0, landed: 0 } } };
      },
    }),
  }));

  const undoMod = paged ? await import("../../../src/plugins/undo.js") : null;
  const { live } = await import("../../../src/plugins/live.js");
  window.clay = { live, ...(undoMod ? { undo: undoMod.undo } : {}) };

  const pm = await import("../../../src/vendor/prosemirror.vendor.js");
  const Y = await import("../../../src/vendor/yjs.vendor.js");
  const ai = await import("../../../src/page/ai-preview.js");
  const mod = await import("../../../src/plugins/page.js");
  page = mod.page;
  const engine = undoMod?.undo ?? null;

  window.clay.blockeditor = page;

  await page.install();
  await page.ready;
  await flushAsync();
  if (!await until(() => page.status?.phase === "ready")) {
    throw new Error(`the page did not boot: ${JSON.stringify(page.status)}`);
  }

  // The session can start after the editor mounts, and this one does: the adapter made at
  // the mount records nothing until it is live.
  if (paged) {
    const lease = await undoMod.undoParticipant().prepare({ generation: 1, isCurrent: () => true });
    lease.enable();
    session = lease;
  }

  return { page, engine, pm, Y, ai };
}

const text = (page) => page.view.state.doc.child(0).textContent;
const putCaret = (pm, view, pos) => view.dispatch(view.state.tr.setSelection(pm.state.TextSelection.create(view.state.doc, pos)));
const type = (view, chars) => {
  for (const ch of chars) {
    const { from, to } = view.state.selection;
    view.someProp("handleTextInput", (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
  }
};
// The note sits on the page before the session starts, so its own arrival is no entry.
const side = () => document.getElementById("side");
const watch = (type) => {
  const seen = [];
  const handler = (event) => seen.push(event.detail);
  document.addEventListener(type, handler);
  watched.push({ type, handler });
  return seen;
};
// A Cmd+Z the editor's own key map sees: prosemirror reads Mod off Ctrl or Meta by platform.
const editorUndoKey = (view) => {
  const press = (opts) => view.someProp("handleKeyDown", (f) => f(view, new KeyboardEvent("keydown", { key: "z", cancelable: true, ...opts })));
  return press({ ctrlKey: true }) || press({ metaKey: true });
};
test("typing in the essay makes a page entry, and clay.blockeditor.history.undo takes the newest one", async () => {
  const { page, engine, pm } = await open();
  putCaret(pm, page.view, 6);
  type(page.view, " there");
  await flushAsync();

  expect(text(page)).toBe("Hello there");
  expect(engine.history.map((entry) => entry.label)).toEqual(["Edit"]);

  window.clay.blockeditor.history.undo();
  await flushAsync();

  expect(text(page)).toBe("Hello");
  expect(engine.history).toEqual([]);
});

test("the editor's own undo callback takes a plain change made after the last block step", async () => {
  const { page, engine, pm } = await open({ extra: NOTE });
  const note = side();
  putCaret(pm, page.view, 6);
  type(page.view, "one");
  await flushAsync();
  engine.commit("Rename side", () => { note.textContent = "changed"; });
  await flushAsync();
  expect(engine.history.map((entry) => entry.label)).toEqual(["Edit", "Rename side"]);

  expect(editorUndoKey(page.view)).toBe(true);
  await flushAsync();

  expect(note.textContent).toBe("side");
  expect(text(page)).toBe("Helloone");
});

test("clay.blockeditor.history.canUndo is the page's canUndo", async () => {
  const { page, engine, pm } = await open();
  expect(window.clay.blockeditor.history.canUndo).toBe(engine.canUndo);
  expect(window.clay.blockeditor.history.canRedo).toBe(engine.canRedo);

  putCaret(pm, page.view, 6);
  type(page.view, "one");
  await flushAsync();
  expect(window.clay.blockeditor.history.canUndo).toBe(true);
  expect(window.clay.blockeditor.history.canUndo).toBe(engine.canUndo);

  engine.undo();
  await flushAsync();
  expect(window.clay.blockeditor.history.canUndo).toBe(engine.canUndo);
  expect(window.clay.blockeditor.history.canRedo).toBe(engine.canRedo);
  expect(window.clay.blockeditor.history.canRedo).toBe(true);
});

test("only the undo plugin announces the history", async () => {
  const { page, engine, pm } = await open();
  const seen = watch("clay:undo-change");
  putCaret(pm, page.view, 6);
  type(page.view, "one");
  await flushAsync();
  expect(seen.length).toBeGreaterThan(0);
  engine.undo();
  await flushAsync();

  expect(seen.length).toBeGreaterThan(0);
  for (const detail of seen) {
    expect(Object.prototype.hasOwnProperty.call(detail, "undo")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(detail, "redo")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(detail, "canUndo")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(detail, "canRedo")).toBe(true);
  }
});

test("a proposal preview holds the page history until it goes", async () => {
  const { page, engine, pm, ai } = await open();
  putCaret(pm, page.view, 6);
  type(page.view, "one");
  await flushAsync();
  const seen = watch("clay:undo-change");

  const dom = document.createElement("div");
  dom.className = "blockeditor-ai-preview";
  dom.textContent = "The proposed blocks.";
  ai.showPreview(page.view, { ids: ["p"], dom });
  await flushAsync();

  expect(seen.at(-1).canUndo).toBe(false);
  expect(engine.undo()).toMatchObject({ ok: false, code: "held" });
  expect(text(page)).toBe("Helloone");

  ai.clearPreview(page.view);
  await flushAsync();
  expect(engine.undo().ok).toBe(true);
  expect(text(page)).toBe("Hello");
});

test("a hold answers no to canUndo and canRedo, and yes again once it goes", async () => {
  const { page, engine, pm } = await open({ extra: NOTE });
  const note = side();
  putCaret(pm, page.view, 6);
  type(page.view, "one");
  await flushAsync();
  expect(engine.canUndo).toBe(true);

  const release = engine.hold();
  await flushAsync();
  expect(engine.canUndo).toBe(false);
  expect(window.clay.blockeditor.history.canUndo).toBe(false);

  release();
  await flushAsync();
  expect(engine.canUndo).toBe(true);
  expect(window.clay.blockeditor.history.canUndo).toBe(true);

  engine.commit("Rename side", () => { note.textContent = "changed"; });
  expect(engine.undo().ok).toBe(true);
  await flushAsync();
  expect(note.textContent).toBe("side");
  expect(engine.canRedo).toBe(true);

  const kept = engine.hold();
  await flushAsync();
  expect(engine.canRedo).toBe(false);
  expect(window.clay.blockeditor.history.canRedo).toBe(false);

  kept();
  await flushAsync();
  expect(engine.canRedo).toBe(true);
  expect(window.clay.blockeditor.history.canRedo).toBe(true);
});

test("a page without undo keeps the editor's own history and announces it", async () => {
  const { page, pm, ai } = await open({ paged: false, extra: NOTE });
  const note = side();
  const seen = watch("clay:undo-change");
  putCaret(pm, page.view, 6);
  type(page.view, "one");
  await flushAsync();

  expect(window.clay.undo).toBeUndefined();
  expect(seen.length).toBeGreaterThan(0);
  for (const detail of seen) expect(Object.keys(detail).sort()).toEqual(["canRedo", "canUndo"]);

  window.clay.blockeditor.history.undo();
  await flushAsync();
  expect(text(page)).toBe("Hello");
  expect(note.textContent).toBe("side");

  // A preview takes no hold, because there is no page history to hold: the editor's own
  // stack still says whether anything is undoable.
  const dom = document.createElement("div");
  dom.className = "blockeditor-ai-preview";
  ai.showPreview(page.view, { ids: ["p"], dom });
  await flushAsync();
  expect(seen.at(-1)).toMatchObject({ canUndo: false, canRedo: false });
});

test("leaving Edit disposes the adapter and releases a live hold", async () => {
  const { page, engine, pm, ai, Y } = await open({ extra: NOTE });
  const note = side();
  const stop = jest.spyOn(Y.UndoManager.prototype, "stopCapturing");
  putCaret(pm, page.view, 6);
  type(page.view, "one");
  await flushAsync();
  engine.commit("Rename side", () => { note.textContent = "changed"; });
  expect(stop).toHaveBeenCalled();

  const dom = document.createElement("div");
  dom.className = "blockeditor-ai-preview";
  ai.showPreview(page.view, { ids: ["p"], dom });
  await flushAsync();
  const seen = watch("clay:undo-change");
  expect(engine.undo()).toMatchObject({ ok: false, code: "held" });

  page.dispose();
  await flushAsync();
  expect(seen.at(-1).canUndo).toBe(true);

  stop.mockClear();
  engine.commit("Rename side again", () => { note.textContent = "again"; });
  expect(stop).not.toHaveBeenCalled();
});

test("the undo handed to features is the page route", async () => {
  const { page, engine, pm } = await open({ blocks: [...BLOCKS, BOARD], extra: NOTE });
  const note = side();
  const board = page.view.dom.querySelector(".blockeditor-board");
  expect(board).toBeTruthy();
  putCaret(pm, page.view, 6);
  type(page.view, "one");
  await flushAsync();
  engine.commit("Rename side", () => { note.textContent = "changed"; });
  await flushAsync();
  expect(engine.history.map((entry) => entry.label)).toEqual(["Edit", "Rename side"]);

  board.dispatchEvent(new KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
  await flushAsync();

  expect(note.textContent).toBe("side");
  expect(page.view.state.doc.child(0).textContent).toBe("Helloone");
});
