import { jest } from "@jest/globals";

/**
 * RichClay strips its runtime state out of every snapshot, so a peer frame
 * carries none of it and the merge removes it from the live editors. They stay
 * bound to their instances and can no longer be typed into, which is what the
 * plugin's `clay:sync-applied` listener repairs.
 */

class FakeEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
  }
  close() {}
}

const BODY = `
<main>
<h1 class="blockeditor-title">Surfaces</h1>
<p class="caption">A caption the CMS edits as plain text.</p>
<div class="block" editable><h2>Team plan</h2><p>$12 per seat per month, billed yearly.</p></div>
<div class="block" data-richclay aria-label="Attached editor"><p>Business: $24 per seat per month.</p></div>
<div class="block" editable="toolbar-on-select"><p>Starter: free for up to 3 people.</p></div>
<div class="hidden-panel block">
<div data-richclay aria-label="Editor inside the hidden panel"><p>Attached editor inside a hidden panel.</p></div>
<div editable><p>Editable block inside a hidden panel.</p></div>
</div>
<div class="block rail-block" editable><h2>FAQ</h2><p>Can I cancel any time? Yes.</p></div>
</main>`;

const EDITOR_SELECTOR = "[editable], [data-richclay]";

// The vendor's own chrome carries the editor marker too, so only the author's
// regions count as editors.
const editors = () =>
  [...document.querySelectorAll(EDITOR_SELECTOR)].filter(
    (el) => !el.closest("[data-richclay-toolbar], [data-richclay-float]")
  );

let LiveSync, liveSyncMod, save, snapshot, gate, RichClay;

beforeAll(async () => {
  window.clayEditMode = true;
  global.EventSource = FakeEventSource;
  window.EventSource = FakeEventSource;
  window.scrollTo = () => {};
  liveSyncMod = await import("../../src/sync/live-sync.js");
  ({ LiveSync } = liveSyncMod);
  liveSyncMod.liveSync.stop();
  save = await import("../../src/core/save.js");
  snapshot = await import("../../src/core/snapshot.js");
  gate = await import("../../src/lib/dirty-gate.js");
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: false, status: 500, statusText: "mock", text: async () => "" })
  );
  document.body.innerHTML = BODY;
  window.clay = {
    testMode: true,
    isEditMode: true,
    onSnapshot: snapshot.onSnapshot,
    addDocumentTransform: snapshot.addDocumentTransform,
    morph: liveSyncMod.morph,
  };
  const mod = await import("../../src/plugins/richclay.js");
  RichClay = mod.RichClay || mod.default;
  await new Promise((r) => setTimeout(r, 0));
});

// The plugin imports once, so each test gets its own page and its own mount:
// the previous test's editors (and their instances) go away with the markup.
beforeEach(async () => {
  document.body.innerHTML = BODY;
  RichClay.init();
  await new Promise((r) => setTimeout(r, 0));
});

// Unmount while jsdom is alive: RichClay destroys an editor when its host leaves,
// and that must not run during teardown.
afterAll(async () => {
  document.body.innerHTML = "";
  await new Promise((r) => setTimeout(r, 0));
});

/** A booted clean tab holding the mounted editors, both lanes seeded. */
async function cleanTab() {
  save.setLastSavedContents(snapshot.captureForComparison());
  save.setUnsavedChanges(false);
  await Promise.resolve();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
  const sync = new LiveSync();
  sync.lane = "live";
  sync._resolveProfile = () => new Promise(() => {});
  sync.start("surfaces.html");
  sync._requestFrame = () => null;
  return sync;
}

/** What a peer running this tab's runtime sends: the frame and its identity map. */
function peerFrame(sync, edit) {
  const clone = snapshot.captureSnapshot({ flushUndo: false });
  const map = sync.identity.exportMap(clone, snapshot.originalSnapshotNode);
  return [edit(snapshot.serializeForSync(clone)), map];
}

async function applyPeerEdit(noBase) {
  const before = editors();
  const beforeCount = before.length;
  const activeBefore = document.querySelectorAll(".richclay-active").length;
  const editableBefore = before.map((el) => el.getAttribute("contenteditable"));
  expect(beforeCount).toBe(6);
  expect(activeBefore).toBe(beforeCount);

  const sync = await cleanTab();
  const [frame, map] = peerFrame(sync, (h) => h.replace("Starter: free", "Starter: FREE"));
  expect(frame).toContain("Starter: FREE");
  expect(frame).not.toContain("richclay-active");
  expect(frame).not.toContain("contenteditable");
  expect(gate.pageMaybeDirty()).toBe(false);
  if (noBase) {
    sync.lastHtml = null;
    sync._lastIdentityMap = null;
  }

  await sync._doApplyUpdate(frame, 1, map, null);
  await new Promise((r) => setTimeout(r, 0));

  expect(document.body.textContent).toContain("Starter: FREE");
  expect(gate.pageMaybeDirty()).toBe(false);
  expect(editors().length).toBe(beforeCount);
  expect(document.querySelectorAll(".richclay-active").length).toBe(activeBefore);
  expect(editors().map((el) => el.getAttribute("contenteditable"))).toEqual(editableBefore);
  editors().forEach((el, i) => expect(el).toBe(before[i]));
  sync.stop();
}

test("after a peer frame every RichClay editor can still be typed into (with a peer base)", async () => {
  await applyPeerEdit(false);
});

test("after a peer frame every RichClay editor can still be typed into (with no peer base, when every editor is merged)", async () => {
  await applyPeerEdit(true);
});

// A field's editor keeps its own undo history as copies of the field's markup. A frame
// that rewrites the field has to restart that history, in the same tick as the write,
// or the person's next undo puts the older copy back over the collaborator's text.

const attached = () => document.querySelector('[data-richclay][aria-label="Attached editor"]');
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** The person's own typing, as one undo step of the field's editor. */
async function typeInto(el, text) {
  const editor = RichClay.init([el])[0];
  editor.squire.saveUndoState();
  el.querySelector("p").textContent += text;
  await settle();
  return editor;
}

const priceRaised = (html) => {
  expect(html).toContain("Business: $24");
  return html.replace("Business: $24", "Business: $99");
};

test("undo after a peer frame rewrote the field keeps the collaborator's text", async () => {
  const el = attached();
  const editor = await typeInto(el, " local");
  const sync = await cleanTab();
  const [frame, map] = peerFrame(sync, priceRaised);

  await sync._doApplyUpdate(frame, 1, map, null);
  await settle();
  expect(el.textContent).toContain("Business: $99");

  editor.squire.undo();
  await settle();
  sync.stop();
  expect(el.textContent).toContain("Business: $99");
});

test("undo pressed before the frame is announced keeps the collaborator's text", async () => {
  const el = attached();
  const editor = await typeInto(el, " local");
  const sync = await cleanTab();
  const [frame, map] = peerFrame(sync, priceRaised);
  let announced = false;
  document.addEventListener("clay:sync-applied", () => { announced = true; }, { once: true });
  // The first moment anything can run after the merge: an observer callback, in the
  // same checkpoint as the editor's own observer and before the resource wait ends.
  let pressed = null;
  const observer = new MutationObserver(() => {
    if (pressed || !el.textContent.includes("$99")) return;
    pressed = { announced };
    editor.squire.undo();
  });
  observer.observe(el, { childList: true, characterData: true, subtree: true });

  await sync._doApplyUpdate(frame, 1, map, null);
  await settle();
  observer.disconnect();
  sync.stop();

  expect(pressed).toEqual({ announced: false });
  expect(announced).toBe(true);
  expect(el.textContent).toContain("Business: $99");
});

test("undo after a disk frame rewrote the field keeps the other writer's text", async () => {
  const el = attached();
  const editor = await typeInto(el, " local");
  const sync = await cleanTab();
  const disk = snapshot.captureForSaveAndComparison({ emitForSync: false }).forSave;
  sync._diskBase = disk;

  await sync._doApplyExternal(priceRaised(disk), 40);
  await settle();
  expect(el.textContent).toContain("Business: $99");

  editor.squire.undo();
  await settle();
  sync.stop();
  expect(el.textContent).toContain("Business: $99");
});

test.each([
  ["with a peer base", false],
  ["with no peer base", true],
])("a frame that leaves a field alone keeps the person's own undo there (%s)", async (_name, noBase) => {
  const el = attached();
  const editor = await typeInto(el, " local");
  const told = [];
  for (const field of editors()) field.addEventListener("clay:external-write", () => told.push(field));
  const sync = await cleanTab();
  const [frame, map] = peerFrame(sync, (h) => h.replace("Starter: free", "Starter: FREE"));
  if (noBase) {
    sync.lastHtml = null;
    sync._lastIdentityMap = null;
  }

  await sync._doApplyUpdate(frame, 1, map, null);
  await settle();
  expect(document.body.textContent).toContain("Starter: FREE");
  expect(told).toEqual([document.querySelector('[editable="toolbar-on-select"]')]);
  expect(el.textContent).toContain("per month. local");

  editor.squire.undo();
  await settle();
  sync.stop();
  expect(el.textContent).not.toContain("local");
  expect(el.textContent).toContain("Business: $24");
  expect(document.body.textContent).toContain("Starter: FREE");
});

test("a frame tells a field under every attribute RichClay mounts on", async () => {
  const names = RichClay.selector.split(",").map((part) => part.trim().replace(/^\[|\]$/g, ""));
  expect(names.length).toBeGreaterThan(1);
  document.body.innerHTML = `<main>${names.map((name) => `<div id="by-${name}" ${name}><p>${name}: old</p></div>`).join("")}</main>`;
  RichClay.init();
  await settle();
  const told = [];
  for (const name of names) {
    document.getElementById(`by-${name}`).addEventListener("clay:external-write", () => told.push(name));
  }
  const sync = await cleanTab();
  const [frame, map] = peerFrame(sync, (h) => h.replaceAll(": old", ": new"));

  await sync._doApplyUpdate(frame, 1, map, null);
  await settle();
  sync.stop();

  expect(document.body.textContent).not.toContain(": old");
  expect(told).toEqual(names);
});
