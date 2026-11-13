/**
 * Tabs of one visitor draft on the draft database: each is a document of its own with the
 * real store and the real session, sharing this file's `localStorage` and one fake
 * IndexedDB. The loader's wiring (`src/plugins/visitor-drafts.js`) is not in this; the
 * loader tests cover it.
 */
import { deserialize, serialize } from "node:v8";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { extractData } from "../../../src/vendor/hyper-html-api-data.vendor.js";
import { createStore, draftKey, merge3, unitMark } from "../../../src/plugins/visitor-drafts/store.js";
import { openSession } from "../../../src/plugins/visitor-drafts/session.js";
import { openDrafts } from "../../../src/plugins/visitor-drafts/idb.js";
import { metaKey, transact } from "../../../src/plugins/visitor-drafts/commit.js";

globalThis.structuredClone ??= (value) => deserialize(serialize(value));

export const RULES = '{"title":"#title","note":"#note@value","rows":["#rows > li[item]:not([cms-template])",{"id":"@data-id","name":".n"}]}';
const SEED = '<li item cms-template data-id=""><span class="n"></span></li>';
const row = (id, name) => `<li item data-id="${id}"><span class="n">${name}</span></li>`;

export const SERVED = { title: "owner title", note: "owner note", rows: [{ id: "r1", name: "First" }] };

let worlds = 0;

// One draft: a slot of its own, a database of its own, and a clock the test moves.
export function world({ rules = RULES } = {}) {
  const factory = new IDBFactory();
  globalThis.indexedDB = factory;
  globalThis.IDBKeyRange = IDBKeyRange;
  const slot = "session-" + ++worlds;
  const w = { factory, slot, path: "/notes.html", key: draftKey(slot, "/notes.html"), rules, clock: Date.parse("2026-11-12T12:00:00Z"), reloads: [] };
  w.local = (name = "") => localStorage.getItem(w.key + name);
  w.parsed = (name = "") => JSON.parse(w.local(name));
  w.slots = () => Object.keys(localStorage).filter((name) => name.startsWith(w.key + ":op:"));
  return w;
}

// `article: true` makes it a page document: one Block editor article and its live stores.
export function page(w, { rules = w.rules, article = false } = {}) {
  const doc = document.implementation.createHTMLDocument("notes");
  doc.documentElement.setAttribute("visitor-drafts", w.slot);
  doc.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="1">${rules}</script>`;
  doc.body.innerHTML = `<h1 id="title">${SERVED.title}</h1><input id="note" persist value="${SERVED.note}"><ul id="rows">${SEED}${SERVED.rows.map((r) => row(r.id, r.name)).join("")}</ul>`;
  if (article) doc.body.insertAdjacentHTML("beforeend", '<script type="application/json" merge="blockeditor.settings" clay="live">{}</script><article class="blockeditor" clay="freeze" data-blockeditor="1" data-rev="r0"><p>served</p></article>');
  return doc;
}

// A tab: its page, its store, and (unless `database: false`) its session. `restore: false`
// leaves the page as served, for a test that restores by hand.
export async function openTab(w, { rules = w.rules, restore = true, database = true, article = false, ...options } = {}) {
  const doc = page(w, { rules, article });
  let edits = 0;
  const store = createStore({ doc, storage: localStorage, path: w.path, now: () => new Date(w.clock), gate: () => ({ token: () => edits, unchangedSince: (at) => at === edits }), ...options });
  const restored = restore ? store.restore() : null;
  const tab = {
    doc,
    store,
    restored,
    session: null,
    events: [],
    reloaded: 0,
    title: (text) => {
      doc.getElementById("title").textContent = text;
      edits++;
    },
    note: (text) => {
      const input = doc.getElementById("note");
      input.value = text;
      input.setAttribute("value", text);
      edits++;
    },
    addRow: (id, name) => {
      doc.getElementById("rows").insertAdjacentHTML("beforeend", row(id, name));
      edits++;
    },
    removeRow: (id) => {
      doc.querySelector(`#rows > li[data-id="${id}"]`).remove();
      edits++;
    },
    // What the page editor leaves in the document at a save: the store's value and the article.
    writePage(rev, value) {
      const el = doc.querySelector("article[data-blockeditor]");
      let tag = doc.querySelector('script[merge="blockeditor"]');
      if (!tag) {
        el.insertAdjacentHTML("beforebegin", '<script type="application/json" merge="blockeditor" clay="live"></script>');
        tag = doc.querySelector('script[merge="blockeditor"]');
      }
      tag.textContent = JSON.stringify(value);
      el.setAttribute("data-rev", rev);
      el.innerHTML = `<p>${rev}</p>`;
    },
    shows: () => extractData(doc, store.rules),
    // As the save capture does, a persisted control's live value goes into the markup: a
    // value another tab's save put on the page is there as the property only.
    html: () => {
      const input = doc.getElementById("note");
      if (input.getAttribute("value") !== input.value) input.setAttribute("value", input.value);
      return doc.documentElement.outerHTML;
    },
    // The synchronous half of a save, then its transaction.
    capture: () => store.capture(tab.html(), { at: edits }),
    save() {
      store.capture(tab.html(), { at: edits });
      return tab.session.sync();
    },
    sync: () => tab.session.sync(),
  };
  for (const name of ["clay:drafts-saved", "clay:drafts-restored", "clay:drafts-store-failed", "clay:drafts-blockeditor-external"]) {
    doc.addEventListener(name, (event) => tab.events.push({ name, detail: event.detail }));
  }
  tab.count = (name) => tab.events.filter((event) => event.name === name).length;
  if (database) {
    tab.session = await openSession({ store, storage: localStorage, doc, now: () => w.clock, reload: () => { tab.reloaded++; } });
    await tab.session.first.catch(() => {});
  }
  return tab;
}

// What the database holds for the draft.
export async function stored(w) {
  const drafts = await openDrafts({ factory: w.factory, keyRange: IDBKeyRange });
  const all = await drafts.readAll(w.key);
  drafts.close();
  const read = (name) => (all.has(name) ? JSON.parse(all.get(name)) : null);
  return { meta: read(metaKey(w.key)), record: read(w.key), conflict: read(w.key + ":conflict"), v1base: read(w.key + ":v1base"), all };
}

// One transaction from outside any tab, with what `input` gives `commit()`.
export async function transactOnce(w, input) {
  const drafts = await openDrafts({ factory: w.factory, keyRange: IDBKeyRange });
  let n = 0;
  const result = await transact(drafts, w.key, () => ({ merge3, unitMark, seed: SERVED, now: w.clock, newId: () => "x" + ++n, marker: localStorage.getItem(w.key + ":reset"), ...input }));
  drafts.close();
  return result;
}

// A database whose read-write transactions throw while `state.fail` is set. With
// `state.fail = "change"` only the read-merge-write transaction throws, and a blind row lands.
export function failing(w) {
  const state = { fail: false };
  const real = w.factory;
  globalThis.indexedDB = {
    open(name, version) {
      const req = real.open(name, version);
      const fake = {};
      req.onupgradeneeded = (event) => { fake.result = req.result; fake.onupgradeneeded?.(event); };
      req.onsuccess = (event) => {
        const db = req.result;
        const transaction = db.transaction.bind(db);
        db.transaction = (stores, mode) => {
          if (state.fail && mode === "readwrite" && (state.fail !== "change" || Array.isArray(stores))) throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
          return transaction(stores, mode);
        };
        fake.result = db;
        fake.onsuccess?.(event);
      };
      req.onerror = (event) => { fake.error = req.error; fake.onerror?.(event); };
      req.onblocked = (event) => fake.onblocked?.(event);
      return fake;
    },
  };
  return state;
}

export const big = (letter, size = 300 * 1024) => letter.repeat(size);

// A tab on a released ClayJS (1.23.0, 1.24.0), reduced to what it does to `localStorage` at
// a save: it reads the record the key holds and writes a child of it. A storage event
// reaches the other tabs unless `announce` is false.
let oldSaves = 0;
export function oldTabSave(w, change, { announce = true, extra = {} } = {}) {
  const was = w.local();
  const held = JSON.parse(was);
  const next = { v: 1, savedAt: new Date(w.clock + ++oldSaves).toISOString(), id: "old" + oldSaves, ancestry: [held.id, ...(held.ancestry ?? [])].slice(0, 32), data: { ...held.data, ...change }, ...extra };
  return oldTabWrite(w, next, { announce, was });
}

// The same tab when it cannot read what the key holds (a head, or nothing): it writes its
// whole page, rooted nowhere.
export function oldTabPage(w, data, { announce = true, extra = {} } = {}) {
  const next = { v: 1, savedAt: new Date(w.clock + ++oldSaves).toISOString(), id: "page" + oldSaves, ancestry: ["root:" + (w.local(":reset") ?? "")], data, ...extra };
  return oldTabWrite(w, next, { announce, was: w.local() });
}

export function oldTabWrite(w, next, { announce = true, was = w.local() } = {}) {
  const text = JSON.stringify(next);
  localStorage.setItem(w.key, text);
  if (announce) window.dispatchEvent(new StorageEvent("storage", { key: w.key, oldValue: was, newValue: text }));
  return { next, seen: was === null ? null : JSON.parse(was), text };
}
