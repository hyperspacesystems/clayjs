/**
 * Visitor drafts v2: a `@codec(...)` region's inner HTML is kept as parts in IndexedDB,
 * beside a version 2 record, and restored before the page's plugins read the document.
 * Real store, real session, real transaction, fake IndexedDB.
 */
import { beforeEach, expect, jest, test } from "@jest/globals";
import { deserialize, serialize } from "node:v8";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createStore, draftKey, rawRegionInner, spliceRawRegion } from "../../src/plugins/visitor-drafts/store.js";
import { openSession } from "../../src/plugins/visitor-drafts/session.js";
import { openDrafts } from "../../src/plugins/visitor-drafts/idb.js";
import { createRecovery } from "../../src/plugins/visitor-drafts/recovery.js";

globalThis.structuredClone ??= (value) => deserialize(serialize(value));

const RULES = JSON.stringify({ docName: "#docName", sheets: "[items=sheets]@codec(sheet)" });

const section = (cells) => `<section data-id="s1"><table grid>${cells.map((text) => `<tbody><tr><td>${text}</td></tr></tbody>`).join("")}</table></section>`;
const SERVED = section(["one", "two"]);

let current = null;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  delete window.clayEditMode;
  delete window.__hyperclayEditMode;
  current = null;
  window.clay = { getHTML: () => current.html() };
});

let worlds = 0;

function world() {
  const factory = new IDBFactory();
  globalThis.indexedDB = factory;
  globalThis.IDBKeyRange = IDBKeyRange;
  const slot = "regions-" + ++worlds;
  const w = { factory, slot, path: "/sheet.html", key: draftKey(slot, "/sheet.html"), clock: Date.parse("2026-11-12T12:00:00Z") };
  w.local = (name = "") => localStorage.getItem(w.key + name);
  w.parsed = (name = "") => JSON.parse(w.local(name));
  return w;
}

// The page source as the served file states it, for a capture that reads the text itself.
const pageSource = (w, inner) =>
  `<!DOCTYPE html><html visitor-drafts="${w.slot}"><head><script type="application/json" data-rules-name="api" data-rules-version="2">${RULES}</script></head><body><h1 id="docName">Served</h1><div items="sheets">${inner}</div></body></html>`;

function page(w) {
  const doc = document.implementation.createHTMLDocument("sheet");
  doc.documentElement.setAttribute("visitor-drafts", w.slot);
  doc.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="2">${RULES}</script>`;
  doc.body.innerHTML = `<h1 id="docName">Served</h1><div items="sheets">${SERVED}</div>`;
  return doc;
}

async function openTab(w, { restore = true, database = true } = {}) {
  const doc = page(w);
  let edits = 0;
  const store = createStore({
    doc,
    storage: localStorage,
    path: w.path,
    now: () => new Date(w.clock),
    gate: () => ({ token: () => edits, unchangedSince: (at) => at === edits }),
  });
  const region = () => doc.querySelector("[items=sheets]");
  const rows = () => [...region().querySelectorAll("tbody")];
  const tab = {
    doc,
    store,
    session: null,
    events: [],
    restored: restore ? store.restore() : null,
    region,
    html: () => doc.documentElement.outerHTML,
    name: (text) => {
      doc.getElementById("docName").textContent = text;
      edits++;
    },
    cell: (index, text) => {
      rows()[index].querySelector("td").textContent = text;
      edits++;
    },
    removeRowGroup: (index) => {
      rows()[index].remove();
      edits++;
    },
    capture: () => store.capture(tab.html(), { at: edits }),
    captureSource: (html) => store.capture(html, { at: edits }),
    save() {
      store.capture(tab.html(), { at: edits });
      return tab.session.sync();
    },
    sync: () => tab.session.sync(),
    use: () => current = tab,
  };
  for (const name of ["clay:drafts-saved", "clay:drafts-restored", "clay:drafts-store-failed", "clay:drafts-region-external"]) {
    doc.addEventListener(name, (event) => tab.events.push({ name, detail: event.detail }));
  }
  tab.count = (name) => tab.events.filter((event) => event.name === name).length;
  if (database) {
    tab.session = await openSession({ store, storage: localStorage, doc, now: () => w.clock, reload: () => {} });
    await tab.session.first.catch(() => {});
  }
  return tab;
}

async function withDrafts(w, fn) {
  const drafts = await openDrafts({ factory: w.factory, keyRange: IDBKeyRange });
  try {
    return await fn(drafts);
  } finally {
    drafts.close();
  }
}

const storedRecord = (w) =>
  withDrafts(w, async (drafts) => {
    const text = (await drafts.readAll(w.key)).get(w.key);
    return text === undefined ? null : JSON.parse(text);
  });

const storedParts = (w, rKey = "sheets") =>
  withDrafts(w, async (drafts) => drafts.readParts(w.key, rKey));

const partIds = async (w) => [...(await storedParts(w)).keys()];

const joinedParts = async (w, record) => {
  const parts = await storedParts(w);
  return record.regions.sheets.order.map((id) => parts.get(id).text).join("");
};

test("an untouched region is not recorded even when canonical markup differs from DOM innerHTML serialization", async () => {
  const w = world();
  const doc = document.implementation.createHTMLDocument("sheet");
  doc.documentElement.setAttribute("visitor-drafts", w.slot);
  doc.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="2">${RULES}</script>`;
  // Include bare boolean attrs (grid, n, open, stacked), `>` inside an attribute, and `\u00a0`
  // so DOM innerHTML produces `grid=""`, `open=""`, `stacked=""`, `&nbsp;` while canonical HTML keeps them bare.
  const canonical = `<section data-id="s1"><table grid><tbody><tr><td f="=IF(A1>0,1,0)" n>A\u00a0B</td></tr></tbody></table><template rules><rule id="k1" kind="list" range="A1" open></rule><rule id="c1" kind="chart" range="B1:C4" stacked></rule></template></section>`;
  doc.body.innerHTML = `<h1 id="docName">Served</h1><div items="sheets">${canonical}</div>`;
  const store = createStore({ doc, storage: localStorage, path: w.path, now: () => new Date(w.clock) });
  store.restore();
  const session = await openSession({ store, storage: localStorage, doc, now: () => w.clock, reload: () => {} });
  await session.first.catch(() => {});

  doc.getElementById("docName").textContent = "Edited";
  const canonicalPage = pageSource(w, canonical).replace("Served", "Edited");
  store.capture(canonicalPage, { at: 1 });
  await session.sync();

  const record = await storedRecord(w);
  expect(record.v).toBe(1);
  expect("regions" in record).toBe(false);
  expect(await partIds(w)).toEqual([]);
  expect(w.parsed()).toEqual({ ...record, w: { rev: 1, reset: "" } });
  expect(w.parsed().v).toBe(1);
  expect(w.parsed().full).toBeUndefined();
});

test("editing a cell writes a version 2 record with its parts and a head, and a part keeps its non-breaking space", async () => {
  const w = world();
  const t = await openTab(w);
  const inner = `<section data-id="s1"><table grid><tbody><tr><td>A\u00a0B</td></tr></tbody><tbody><tr><td>two</td></tr></tbody></table></section>`;
  t.captureSource(pageSource(w, inner));
  await t.sync();

  const record = await storedRecord(w);
  expect(record.v).toBe(2);
  expect(record.regions.sheets).toEqual({
    selector: "[items=sheets]",
    codec: "sheet",
    rev: 1,
    order: ["s1:0", "s1:1", "s1:2", "s1:3"],
  });
  const parts = await storedParts(w);
  expect(parts.get("s1:1")).toEqual({ rev: 1, text: "<tbody><tr><td>A\u00a0B</td></tr></tbody>" });
  const joined = await joinedParts(w, record);
  expect(joined).toBe(inner);
  expect(joined).toContain("\u00a0");
  expect(joined).not.toContain("&nbsp;");

  const head = w.parsed();
  expect(head).toMatchObject({ v: 2, idb: true, data: { docName: "Served" } });
  expect(head.full).toBeUndefined();
  expect(head.regions).toBeUndefined();
});

test("one changed row group writes one part; the others keep their revision; a removed one is deleted", async () => {
  const w = world();
  const t = await openTab(w);
  t.cell(0, "uno");
  await t.save();
  let record = await storedRecord(w);
  expect(record.regions.sheets.rev).toBe(1);

  t.cell(1, "dos");
  const partStoreProto = await new Promise((resolve, reject) => {
    const req = w.factory.open("clay-visitor-drafts", 1);
    req.onsuccess = () => {
      const db = req.result;
      const proto = Object.getPrototypeOf(db.transaction("parts", "readonly").objectStore("parts"));
      db.close();
      resolve(proto);
    };
    req.onerror = () => reject(req.error);
  });
  const putSpy = jest.spyOn(partStoreProto, "put");
  await t.save();
  const partPutKeys = putSpy.mock.calls.filter(([, k]) => Array.isArray(k) && k[0] === w.key && k[1] === "sheets").map(([, k]) => k[2]);
  putSpy.mockRestore();
  expect(partPutKeys).toEqual(["s1:2"]);
  record = await storedRecord(w);
  expect(record.regions.sheets.rev).toBe(2);
  let parts = await storedParts(w);
  expect(parts.get("s1:1")).toEqual({ rev: 1, text: "<tbody><tr><td>uno</td></tr></tbody>" });
  expect(parts.get("s1:2")).toEqual({ rev: 2, text: "<tbody><tr><td>dos</td></tr></tbody>" });
  expect(parts.get("s1:0").rev).toBe(1);
  expect(parts.get("s1:3").rev).toBe(1);

  t.removeRowGroup(1);
  await t.save();
  record = await storedRecord(w);
  expect(record.regions.sheets.order).toEqual(["s1:0", "s1:1", "s1:2"]);
  parts = await storedParts(w);
  expect([...parts.keys()]).toEqual(["s1:0", "s1:1", "s1:2"]);
  expect(parts.get("s1:1").rev).toBe(1);
  expect(await joinedParts(w, record)).toBe(t.region().innerHTML);
});

test("an ordinary field saved after a region edit keeps the version 2 record and its regions", async () => {
  const w = world();
  const t = await openTab(w);
  t.cell(0, "uno");
  await t.save();

  t.name("Renamed");
  await t.save();
  const record = await storedRecord(w);
  expect(record.v).toBe(2);
  expect(record.data.docName).toBe("Renamed");
  expect(record.regions.sheets.order).toEqual(["s1:0", "s1:1", "s1:2", "s1:3"]);
  expect(await partIds(w)).toEqual(["s1:0", "s1:1", "s1:2", "s1:3"]);
  expect(w.parsed().v).toBe(2);
  expect(w.parsed().idb).toBe(true);
});

test("two open draft tabs: a region save reaches the other tab's page and announces itself", async () => {
  const w = world();
  const [a, b] = [await openTab(w), await openTab(w)];
  a.use();
  a.cell(0, "from a");
  await a.save();

  b.use();
  await b.sync();
  expect(b.region().innerHTML).toBe(a.region().innerHTML);
  expect(b.region().innerHTML).toContain("from a");
  const external = b.events.filter((event) => event.name === "clay:drafts-region-external");
  expect(external).toHaveLength(1);
  expect(external[0].detail).toMatchObject({ key: "sheets", selector: "[items=sheets]", codec: "sheet" });
  expect(external[0].detail.html).toBe(a.region().innerHTML);
});

test("two tabs changing the same region: the later save wins and the replaced copy is kept", async () => {
  const w = world();
  const [a, b] = [await openTab(w), await openTab(w)];
  a.use();
  a.cell(0, "from a");
  await a.save();
  const fromA = await storedRecord(w);

  b.use();
  b.cell(1, "from b");
  await b.save();

  const after = await storedRecord(w);
  expect(after.v).toBe(2);
  expect(after.regions.sheets.rev).toBe(fromA.regions.sheets.rev + 1);
  const joined = await joinedParts(w, after);
  expect(joined).toContain("from b");
  expect(joined).not.toContain("from a");

  const conflict = await withDrafts(w, async (drafts) => JSON.parse((await drafts.readAll(w.key)).get(w.key + ":conflict")));
  expect(conflict.id).toBe(fromA.id);
  expect(conflict.v).toBe(2);
  expect(conflict.regions.sheets.rev).toBe(fromA.regions.sheets.rev);
  expect(Object.values(conflict.regionParts.sheets).join("")).toContain("from a");

  // Recovery html() re-splices the archived copy's cells, and restore() keeps both active and
  // displaced sheet parts intact instead of wiping them.
  const rec = createRecovery({ store: b.store, session: b.session, getHTML: () => b.html() });
  const conflictHtml = rec.html(conflict);
  expect(conflictHtml).toContain("from a");
  expect(conflictHtml).not.toContain("from b");

  // Save conflict under a recovery slot (same flow as reset/earlier drafts) and restore it.
  await withDrafts(w, async (drafts) => {
    await drafts.change(w.key, () => ({
      puts: [[w.key + ":recovery:" + conflict.id, JSON.stringify(conflict)]],
      deletes: [],
      result: true,
    }));
  });
  await b.session.restoreRecovery(conflict.id);
  const restored = await storedRecord(w);
  expect(restored.v).toBe(2);
  const restoredJoined = await joinedParts(w, restored);
  expect(restoredJoined).toContain("from a");
  expect(restoredJoined).not.toContain("from b");
  // The displaced Tab B draft was kept aside with its own regionParts too!
  const keptList = await b.session.listRecovery();
  const displaced = keptList.find((row) => row.mark !== conflict.id);
  expect(displaced).toBeDefined();
  expect(Object.values(displaced.copy.regionParts.sheets).join("")).toContain("from b");
});

test("Start over removes every part row of the draft", async () => {
  const w = world();
  const t = await openTab(w);
  t.cell(0, "uno");
  await t.save();
  expect(await partIds(w)).toHaveLength(4);

  await t.session.startOver();
  expect(await partIds(w)).toEqual([]);
});

test("a page load with only a version 2 head restores the region from IndexedDB before the plugins start", async () => {
  const w = world();
  const t = await openTab(w);
  t.cell(0, "from idb");
  await t.save();
  expect(w.parsed().v).toBe(2);
  expect(w.parsed().idb).toBe(true);
  const saved = t.region().innerHTML;

  jest.resetModules();
  window.history.replaceState({}, "", "/sheet.html");
  const root = document.documentElement;
  for (const name of Array.from(root.attributes, (attribute) => attribute.name)) root.removeAttribute(name);
  root.setAttribute("visitor-drafts", w.slot);
  document.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="2">${RULES}</script>`;
  document.body.innerHTML = `<h1 id="docName">Served</h1><div items="sheets">${SERVED}</div>`;
  expect(document.querySelector("[items=sheets]").innerHTML).not.toContain("from idb");

  // Record what a downstream plugin (listening for clay:plugin-loaded or loaded after visitor-drafts)
  // sees in the DOM during boot: it must already see "from idb" before downstream plugins run.
  let cellWhenNextPluginRan = null;
  const onRestored = () => { cellWhenNextPluginRan = document.querySelector("[items=sheets]").innerHTML; };
  document.addEventListener("clay:drafts-restored", onRestored, { once: true });

  window.clay = {};
  window.fetch = jest.fn(async () => new Response("", { status: 404 }));
  const { boot } = await import("../../src/loader.js");
  await new Promise((resolve) => boot(null, new URLSearchParams("plugins=visitor-drafts,undo&exclude=richclay,source"), resolve));

  expect(cellWhenNextPluginRan).toContain("from idb");
  expect(window.clay.visitorDrafts.active).toBe(true);
  expect(window.clay.undo).toBeDefined();
  expect(document.querySelector("[items=sheets]").innerHTML).toBe(saved);
  expect(document.querySelector("[items=sheets]").innerHTML).toContain("from idb");
});

test("a page without IndexedDB refuses a region save instead of dropping the region", async () => {
  const w = world();
  const t = await openTab(w, { database: false });
  t.cell(0, "uno");
  expect(() => t.store.write(t.html())).toThrow(expect.objectContaining({ code: "draft-storage" }));
  expect(t.count("clay:drafts-store-failed")).toBe(1);
  expect(w.local()).toBe(null);
});

test("rawRegionInner and spliceRawRegion handle compound selectors, unquoted apostrophes, and HTML5 empty comments", () => {
  const html = `<!doctype html><html><body><!--><!---><div data-note=visitor's items="sheets" sheet-workbook><section data-id="s1"><table grid><tbody><tr><td>A\u00a0B</td></tr></tbody></table></section></div></body></html>`;
  expect(rawRegionInner(html, "div[items=sheets][sheet-workbook]")).toBe(
    `<section data-id="s1"><table grid><tbody><tr><td>A\u00a0B</td></tr></tbody></table></section>`,
  );
  const next = spliceRawRegion(html, "div[items=sheets]", `<section data-id="s1"><table grid><tbody><tr><td>X\u00a0Y</td></tr></tbody></table></section>`);
  expect(next).toContain("<td>X\u00a0Y</td>");
  expect(next).toContain("<table grid>");
});

test("cleared IndexedDB with a surviving localStorage v2 head applies surviving small keys instead of wiping them", async () => {
  const w = world();
  const t = await openTab(w);
  t.name("2027 Plan");
  t.cell(0, "uno");
  await t.save();
  expect(w.parsed()).toMatchObject({ v: 2, idb: true, data: { docName: "2027 Plan" } });

  // Simulate browser clearing IndexedDB while localStorage keeps the v2 head.
  w.factory = new IDBFactory();
  globalThis.indexedDB = w.factory;
  const fresh = await openTab(w, { restore: false });
  const result = await fresh.session.first;
  expect(result.record).not.toBeNull();
  expect(result.record.data.docName).toBe("2027 Plan");
  expect(result.partial).toBe(true);
  expect(w.parsed().data.docName).toBe("2027 Plan");
});

test("reloading after a close-flushed :op:<tab> journal with no v2 head yet still waits and restores the cell", async () => {
  const w = world();
  const t = await openTab(w);
  t.use();
  t.cell(0, "flushed-on-close");
  // Capture + keep() synchronously journals to localStorage[key:op:<tab>] without committing to IDB.
  t.capture();
  expect(t.store.keep()).toBe(true);
  expect(w.local()).toBe(null);

  jest.resetModules();
  window.history.replaceState({}, "", "/sheet.html");
  const root = document.documentElement;
  for (const name of Array.from(root.attributes, (attribute) => attribute.name)) root.removeAttribute(name);
  root.setAttribute("visitor-drafts", w.slot);
  document.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="2">${RULES}</script>`;
  document.body.innerHTML = `<h1 id="docName">Served</h1><div items="sheets">${SERVED}</div>`;

  window.clay = {};
  window.fetch = jest.fn(async () => new Response("", { status: 404 }));
  const { boot } = await import("../../src/loader.js");
  await new Promise((resolve) => boot(null, new URLSearchParams("plugins=visitor-drafts&exclude=richclay,source"), resolve));

  expect(window.clay.visitorDrafts.active).toBe(true);
  expect(window.clay.visitorDrafts.restored()).toEqual({ restored: true, hadDraft: true, parked: false });
  expect(document.querySelector("[items=sheets]").innerHTML).toContain("flushed-on-close");
});
