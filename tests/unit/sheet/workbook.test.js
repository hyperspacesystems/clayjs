/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { jest } from "@jest/globals";

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function page(body) {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.Sap;
  delete window.sapPlugins;
  delete window.clayEditMode;
  window.clay = { ready: new Promise(() => {}) };
  document.head.innerHTML = "";
  document.body.innerHTML = body;
}

const loadCore = async () => (await import("../../../src/vendor/sap-core.vendor.js")).default;

const BOOK = () => `<main sap plugins="grid"><div items="sheets" sheet-workbook>
<section item data-id="s1" data-pos="V"><h2 bind="name">Sheet1</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="3">3</td><td n></td></tr>
<tr data-id="r2" data-pos="l"><td n v="4">4</td><td n></td></tr>
</tbody></table></section>

<section item data-id="s2" data-pos="l"><h2 bind="name">Sheet2</h2><table grid><colgroup><col data-id="c1" data-pos="V"><col data-id="c2" data-pos="l"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n f="=Sheet1!A1*2" v="0">0</td><td n></td></tr>
</tbody></table></section>
<script type="application/json" sheet-commit>{"rev":1}</script>
</div>
</main>`;

async function start(body = BOOK()) {
  page(body);
  const Sap = await loadCore();
  // The loader gives a plugin ClayJS's region API on window.clay before any plugin loads.
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const onRebuild = jest.fn();
  const books = ownWorkbooks({ onRebuild });
  await books.ready;
  Sap.mount();
  await turn();
  const root = document.querySelector("[sheet-workbook]");
  return { Sap, books, book: books.books.get(root), root, onRebuild };
}

const tableOf = (id) => document.querySelector(`section[data-id="${id}"] table[grid]`);

function docOf(inner) {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body><main sap plugins="grid"><div items="sheets" sheet-workbook>${inner}</div></main></body></html>`,
    "text/html",
  );
}

// A peer's copy of the page: the bytes a save would have written, with one cell changed.
function withCell(inner, tabId, rowId, column, text) {
  const doc = docOf(inner);
  doc.querySelector(`section[data-id="${tabId}"] tr[data-id="${rowId}"] td:nth-child(${column})`).textContent = text;
  return doc;
}

afterEach(() => {
  window.Sap?.unmount?.();
  delete window.Sap;
  delete window.clay;
  jest.restoreAllMocks();
});

test("an untouched workbook writes the same bytes twice and its revision does not move", async () => {
  const { book, root } = await start();

  const first = book.serialize({ purpose: "save" });
  const second = book.serialize({ purpose: "save" });
  const gap = root.querySelector('section[data-id="s1"]').nextSibling.data;

  expect(second).toBe(first);
  expect(book.revision).toBe(0);
  expect(gap).toBeTruthy();
  expect(first).toContain(`</section>${gap}<section`);
  expect(first).toMatch(/<script type="application\/json" sheet-commit(?:="")?>\{"rev":1\}<\/script>/);
  // The file held a stale result; the bytes carry the one the engine computed.
  expect(first).toContain(">6<");
});

test("a cell edit moves the revision and reaches the bytes", async () => {
  const { Sap, book } = await start();
  book.serialize({});

  Sap.grid(tableOf("s1")).set("A1", "5");

  expect(book.revision).toBe(1);
  expect(book.serialize({})).toContain(">5<");
});

test("a changed input's result on another tab reaches the bytes", async () => {
  const { Sap, book } = await start();
  expect(book.serialize({})).toContain(">6<");

  Sap.grid(tableOf("s1")).set("A1", "5");

  expect(book.serialize({})).toContain(">10<");
});

test("a peer's change to another tab is taken, and our unsaved edit keeps the page dirty", async () => {
  const { Sap, book, onRebuild } = await start();
  const saved = book.serialize({ purpose: "save" });
  Sap.grid(tableOf("s1")).set("A1", "5");
  const revised = book.revision;

  const after = book.merge({ document: withCell(saved, "s2", "r1", 2, "theirs"), base: docOf(saved) });

  expect(after()).toBe(true);
  const bytes = book.serialize({});
  expect(bytes).toContain(">5<");
  expect(bytes).toContain(">theirs<");
  expect(onRebuild).toHaveBeenCalledTimes(1);
  expect(book.revision).toBeGreaterThan(revised);
});

test("after a save, a peer's change to the same tab is taken", async () => {
  const { Sap, book } = await start();
  Sap.grid(tableOf("s1")).set("A1", "5");
  // The file on disk as an author's own form of the same cells: the save wrote this
  // tab, and the peer's base is that file, so this tab's text only matches it as cells.
  const saved = book.serialize({ purpose: "save" });
  document.dispatchEvent(new CustomEvent("clay:snapshot-ready", { detail: { forSave: true, captureId: 7 } }));
  document.dispatchEvent(new CustomEvent("clay:save-saved", { detail: { captureId: 7 } }));
  const file = saved.replace(/\n/g, "");

  const after = book.merge({ document: withCell(file, "s1", "r1", 2, "nine"), base: docOf(file) });

  expect(after()).toBe(false);
  const bytes = book.serialize({});
  expect(bytes).toContain(">5<");
  expect(bytes).toContain(">nine<");
});

test("an edit after the save's capture stays unsaved when that save lands, even if a download captured it", async () => {
  const { Sap, book } = await start();
  Sap.grid(tableOf("s1")).set("A1", "5");
  const saved = book.serialize({ purpose: "save" });
  document.dispatchEvent(new CustomEvent("clay:snapshot-ready", { detail: { forSave: true, captureId: 7 } }));
  Sap.grid(tableOf("s1")).set("A2", "6");
  // A download asks for save bytes too, with no capture of a save behind it.
  book.serialize({ purpose: "save" });
  document.dispatchEvent(new CustomEvent("clay:save-saved", { detail: { captureId: 7 } }));

  // The peer's version is the saved file with another cell of s1 changed: our A2 edit clashes.
  expect(() => book.merge({ document: withCell(saved, "s1", "r1", 2, "nine"), base: docOf(saved) })).toThrow(/s1/);
  expect(book.serialize({})).toContain(">6<");
});

test("both sides changed one tab: the merge fails and the live tab is left alone", async () => {
  const { Sap, book } = await start();
  const saved = book.serialize({ purpose: "save" });
  Sap.grid(tableOf("s1")).set("A1", "5");

  expect(() => book.merge({ document: withCell(saved, "s1", "r1", 1, "9"), base: docOf(saved) })).toThrow(/s1/);
  const bytes = book.serialize({});
  expect(bytes).toContain(">5<");
  expect(bytes).not.toContain(">9<");
});

const NEW_TAB = `<section item data-id="s3" data-pos="t"><h2 bind="name">New</h2><table grid><colgroup><col data-id="c1" data-pos="V"></colgroup>
<tbody>
<tr data-id="r1" data-pos="V"><td n v="7">7</td></tr>
</tbody></table></section>`;

test("a tab the peer added appears, with a Grid on the engine", async () => {
  const { Sap, book } = await start();
  const saved = book.serialize({ purpose: "save" });
  const theirs = docOf(saved);
  theirs.querySelector("[sheet-workbook]").insertAdjacentHTML("beforeend", NEW_TAB);
  const revised = book.revision;

  expect(book.merge({ document: theirs, base: docOf(saved) })()).toBe(false);

  const section = document.querySelector('[sheet-workbook] > section[data-id="s3"]');
  expect(section).not.toBeNull();
  expect(Sap.grid(tableOf("s3")).sheet.id).toBe("s3");
  expect(book.revision).toBe(revised + 1);

  Sap.grid(tableOf("s1")).set("B1", "=SUM('New'!A1)*2");
  expect(book.serialize({})).toContain(">14<");
  expect(book.revision).toBe(revised + 2);

  Sap.grid(tableOf("s3")).set("A1", "8");
  expect(book.revision).toBe(revised + 3);
});

test("no base: a tab with no unsaved edit takes theirs, and an unsaved edit that differs fails the merge", async () => {
  const { Sap, book } = await start();
  const saved = book.serialize({ purpose: "save" });

  expect(book.merge({ document: withCell(saved, "s1", "r1", 1, "9") })()).toBe(false);
  expect(book.serialize({})).toContain(">9<");

  Sap.grid(tableOf("s2")).set("B1", "x");
  const now = book.serialize({});
  expect(() => book.merge({ document: withCell(now, "s2", "r1", 2, "y") })).toThrow(/s2/);
  expect(book.serialize({})).toContain(">x<");
});

test("a local unsaved edit and a peer frame that changes another tab leave the page unsaved", async () => {
  const { Sap, book } = await start();
  const saved = book.serialize({ purpose: "save" });
  window.clayEditMode = true;
  const snapshot = await import("../../../src/core/snapshot.js");
  const save = await import("../../../src/core/save.js");
  const gate = await import("../../../src/lib/dirty-gate.js");
  const unsavedWarning = await import("../../../src/core/unsaved-warning.js");
  const liveSyncModule = await import("../../../src/sync/live-sync.js");
  const { LiveSync } = liveSyncModule;
  liveSyncModule.liveSync.stop();
  const Mutation = (await import("../../../src/lib/mutation.js")).default;

  window.clay = { Mutation };
  save.setLastSavedBaselines(snapshot.captureForComparison(), snapshot.captureForDirtyCheck());
  save.setUnsavedChanges(false);
  const sync = new LiveSync();
  sync.lane = "live";
  sync._requestFrame = () => null;
  sync._diskBase = snapshot.captureForSaveAndComparison({ emitForSync: false }).forSave;
  sync.lastHtml = snapshot.serializeForSync(snapshot.captureSnapshot({ flushUndo: false, purpose: "sync" }));
  await turn();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
  expect(unsavedWarning.hasUnsavedChanges()).toBe(false);

  Sap.grid(tableOf("s1")).set("A1", "5");
  await turn();
  expect(unsavedWarning.hasUnsavedChanges()).toBe(true);

  const peer = withCell(saved, "s2", "r1", 2, "theirs");
  await sync._doApplyUpdate(`<!doctype html><html><head></head><body>${peer.body.innerHTML}</body></html>`, 10, null, "etag-10");
  await turn();
  sync.stop();

  expect(book.serialize({})).toContain(">theirs<");
  expect(unsavedWarning.hasUnsavedChanges()).toBe(true);
});

test("a merge before the workbook has started fails, so the live content is left alone", async () => {
  page(BOOK());
  const real = await import("../../../src/vendor/sap-grid.vendor.js");
  const download = deferred();
  jest.unstable_mockModule("../../../src/vendor/sap-grid.vendor.js", async () => {
    await download.promise;
    return real;
  });
  await loadCore();
  // The loader gives a plugin ClayJS's region API on window.clay before any plugin loads.
  window.clay.region = (await import("../../../src/lib/region-policy.js")).regionShape;
  const { ownWorkbooks } = await import("../../../src/sheet/workbook.js");
  const books = ownWorkbooks({});
  const book = books.books.get(document.querySelector("[sheet-workbook]"));
  const live = document.querySelector("[sheet-workbook]").innerHTML;

  expect(book.built).toBe(false);
  expect(() => book.merge({ document: docOf(live) })).toThrow();
  expect(document.querySelector("[sheet-workbook]").innerHTML).toBe(live);

  download.resolve();
  await books.ready;
  expect(book.built).toBe(true);
});

test("a peer's edit that only changes our tab's formula results is no clash", async () => {
  const { Sap, book } = await start();
  const saved = book.serialize({ purpose: "save" });
  Sap.grid(tableOf("s2")).set("B1", "note");
  // The peer changed Sheet1!A1, so its file holds a new result for s2's =Sheet1!A1*2 too.
  const peer = withCell(saved, "s1", "r1", 1, "4");
  peer.querySelector('section[data-id="s1"] tr[data-id="r1"] td').setAttribute("v", "4");
  const result = peer.querySelector('section[data-id="s2"] td[f]');
  result.setAttribute("v", "8");
  result.textContent = "8";

  expect(book.merge({ document: peer, base: docOf(saved) })()).toBe(true);
  const bytes = book.serialize({});
  expect(bytes).toContain(">note<");
  expect(bytes).toContain(">8<");
});

test("a tab a step added gets a listener, so its edits move the revision", async () => {
  const { Sap, book } = await start();
  const html = '<table grid><colgroup><col data-id="c1" data-pos="V"></colgroup>\n<tbody>\n<tr data-id="r1" data-pos="V"><td n v="7">7</td></tr>\n</tbody></table>';
  Sap.grid(tableOf("s1")).apply({ v: 1, t: "insertSheet", sheet: { id: "s3", name: "New", pos: "t", html } });
  const before = book.revision;
  Sap.grid(tableOf("s3")).set("A1", "8");
  expect(book.revision).toBe(before + 1);
  expect(book.serialize({})).toContain(">8<");
});

test("a formula in a format the page cannot draw keeps its saved text", async () => {
  const body = BOOK().replace('<td n></td></tr>\n<tr data-id="r2"', '<td n f="=A1*10" v="30" fmt="0.00 &quot;kg&quot;">30.00 kg</td></tr>\n<tr data-id="r2"');
  const { Sap, book } = await start(body);
  expect(book.serialize({})).toContain(">30.00 kg<");
  Sap.grid(tableOf("s1")).set("A2", "40");
  expect(book.serialize({ purpose: "save" })).toContain(">30.00 kg<");
});

test("a peer's new commit record is taken, and a tab added to an empty workbook goes before it", async () => {
  const { book, root } = await start();
  const saved = book.serialize({ purpose: "save" });
  const peer = docOf(saved);
  peer.querySelector("script[sheet-commit]").textContent = '{"rev":9}';

  expect(book.merge({ document: peer, base: docOf(saved) })()).toBe(false);
  expect(book.serialize({})).toContain('{"rev":9}');

  const empty = docOf(saved);
  for (const section of empty.querySelectorAll("section[item]")) section.remove();
  const fresh = docOf(saved);
  for (const section of fresh.querySelectorAll('section[item]:not([data-id="s2"])')) section.remove();
  fresh.querySelector('section[data-id="s2"]').setAttribute("data-id", "s9");
  for (const section of root.querySelectorAll("section[item]")) section.remove();
  book.merge({ document: fresh, base: empty })();
  expect([...root.children].map((el) => el.localName)).toEqual(["section", "script"]);
});

test("this tab's own state and parts no save keeps stay out of the bytes", async () => {
  const { book, root } = await start();
  const section = root.querySelector('section[data-id="s1"]');
  section.setAttribute("route-active", "");
  section.setAttribute("ephemeral", "selected");
  section.insertAdjacentHTML("beforeend", '<div no-save class="tab-menu">menu</div>');
  root.setAttribute("sap-error", "E52");

  const bytes = book.serialize({ purpose: "save" });
  expect(bytes).not.toContain("route-active");
  expect(bytes).not.toContain("ephemeral");
  expect(bytes).not.toContain("tab-menu");
  expect(bytes).toContain('<section item="" data-id="s1" data-pos="V">');
});

