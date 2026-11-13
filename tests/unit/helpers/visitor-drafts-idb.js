/**
 * A page booted through the real loader with IndexedDB where a browser has it, and the
 * seeding and reading of the draft database the loader tests share.
 */
import { jest } from "@jest/globals";
import { deserialize, serialize } from "node:v8";
import { IDBKeyRange } from "fake-indexeddb";
import { draftKey, merge3, unitMark } from "../../../src/plugins/visitor-drafts/store.js";
import { openDrafts } from "../../../src/plugins/visitor-drafts/idb.js";
import { metaKey, transact } from "../../../src/plugins/visitor-drafts/commit.js";

globalThis.structuredClone ??= (value) => deserialize(serialize(value));

export const PARAMS = "plugins=visitor-drafts,undo&exclude=richclay";
export const RULES = '{"title":"#title","note":"#note@value","rows":["#rows > li[item]:not([cms-template])",{"id":"@data-id","name":".n"}]}';
export const SEED = '<li item cms-template data-id=""><span class="n"></span></li>';
export const row = (id, name) => `<li item data-id="${id}"><span class="n">${name}</span></li>`;
export const PAGE = "/notes.html";
export const SERVED = { title: "owner title", note: "owner note", rows: [{ id: "r1", name: "First" }] };

export const keyFor = (slot) => draftKey(slot, PAGE);

// Every boot gets its own slot: the plugin's listeners outlive the module registry, so two
// boots on one slot would let an earlier boot's store answer for the boot under test.
export function setPage({ slot, rows = row("r1", "First"), localRaw = null, keep = false }) {
  const root = document.documentElement;
  for (const name of Array.from(root.attributes, (attribute) => attribute.name)) root.removeAttribute(name);
  root.setAttribute("visitor-drafts", slot);
  document.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="1">${RULES}</script>`;
  document.body.innerHTML = `<h1 id="title">owner title</h1><input id="note" persist value="owner note"><ul id="rows">${SEED}${rows}</ul>`;
  if (keep) return;
  localStorage.clear();
  if (localRaw != null) localStorage.setItem(keyFor(slot), localRaw);
}

export const WATCHED = ["clay:drafts-restored", "clay:drafts-saved", "clay:drafts-store-failed", "clay:save-saved", "clay:save-error"];

function notFound() {
  return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
}

export async function bootPage({ slot, params = PARAMS, url = PAGE, localRaw = null, keep = false, rows } = {}) {
  jest.resetModules();
  delete window.clayEditMode;
  delete window.__hyperclayEditMode;
  document.cookie = "isAdminOfCurrentResource=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  window.history.replaceState({}, "", url);
  setPage({ slot, rows, localRaw, keep });
  window.clay = {};
  let settleReady;
  window.clay.ready = new Promise((resolve) => { settleReady = resolve; });
  window.scrollTo = () => {};
  window.scrollBy = () => {};
  const mock = jest.fn(async () => notFound());
  window.fetch = mock;
  global.fetch = mock;
  const events = [];
  for (const name of WATCHED) document.addEventListener(name, (event) => events.push({ name, detail: event.detail }));
  const { boot } = await import("../../../src/loader.js");
  await new Promise((resolve) => boot(null, new URLSearchParams(params), (clay) => { settleReady(clay); resolve(clay); }));
  const key = keyFor(slot);
  return {
    clay: window.clay,
    key,
    events,
    count: (name) => events.filter((event) => event.name === name).length,
    local: (name = "") => localStorage.getItem(key + name),
    slots: () => Object.keys(localStorage).filter((name) => name.startsWith(key + ":op:")),
  };
}

// The plugin finds IndexedDB on the global object, as in a browser.
export function useFactory(factory) {
  globalThis.indexedDB = factory;
  globalThis.IDBKeyRange = IDBKeyRange;
}

export function noDatabase() {
  delete globalThis.indexedDB;
  delete globalThis.IDBKeyRange;
}

// Rows put straight into the database, as an earlier page load left them.
export async function seedIdb(factory, key, { record = null, meta = null, rows = [] } = {}) {
  const drafts = await openDrafts({ factory, keyRange: IDBKeyRange });
  const puts = [...rows];
  if (record) puts.push([key, JSON.stringify(record)]);
  if (record || meta) puts.push([metaKey(key), JSON.stringify({ gen: 1, rev: 1, reset: "", tabs: {}, foreign: null, unit: null, ...meta })]);
  await drafts.change(key, () => ({ puts, deletes: [], result: null }));
  drafts.close();
}

export async function readIdb(factory, key) {
  const drafts = await openDrafts({ factory, keyRange: IDBKeyRange });
  const all = await drafts.readAll(key);
  drafts.close();
  const read = (name) => (all.has(name) ? JSON.parse(all.get(name)) : null);
  return { meta: read(metaKey(key)), record: read(key), conflict: read(key + ":conflict"), v1base: read(key + ":v1base"), all };
}

// Another tab on this ClayJS, as the database sees it: one transaction with its operations,
// then the cache it would leave and the storage event this page would get.
export async function otherTab(factory, key, { tab = "other", reset = "", ops = [], resets = [], announce = true } = {}) {
  const drafts = await openDrafts({ factory, keyRange: IDBKeyRange });
  let n = 0;
  const result = await transact(drafts, key, () => ({
    merge3,
    unitMark,
    seed: SERVED,
    now: Date.now(),
    newId: () => `${tab}${++n}`,
    marker: localStorage.getItem(key + ":reset"),
    resets,
    chains: ops.length ? [{ tab, reset, acked: 0, ops }] : [],
  }));
  drafts.close();
  if (result.record) localStorage.setItem(key, JSON.stringify({ ...result.record, w: { rev: result.meta.rev, reset: result.meta.reset } }));
  else localStorage.removeItem(key);
  if (announce) window.dispatchEvent(new StorageEvent("storage", { key }));
  return result;
}

export async function waitFor(check, what, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export const pause = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

// A factory whose open answers `ms` later (with an error when `fail`), and says when it has.
export function slowFactory(real, ms, { fail = false } = {}) {
  const state = { opened: false };
  const factory = {
    open(name, version) {
      const fake = {};
      setTimeout(() => {
        if (fail) {
          fake.error = Object.assign(new Error("no database"), { name: "UnknownError" });
          state.opened = true;
          return fake.onerror?.({});
        }
        const req = real.open(name, version);
        req.onupgradeneeded = (event) => { fake.result = req.result; fake.onupgradeneeded?.(event); };
        req.onsuccess = (event) => { fake.result = req.result; state.opened = true; fake.onsuccess?.(event); };
        req.onerror = (event) => { fake.error = req.error; fake.onerror?.(event); };
        req.onblocked = (event) => fake.onblocked?.(event);
      }, ms);
      return fake;
    },
  };
  return { factory, state };
}

// A factory whose read-write transactions throw while `state.fail` is set.
export function failingFactory(real) {
  const state = { fail: false };
  const factory = {
    open(name, version) {
      const req = real.open(name, version);
      const fake = {};
      req.onupgradeneeded = (event) => { fake.result = req.result; fake.onupgradeneeded?.(event); };
      req.onsuccess = (event) => {
        const db = req.result;
        const transaction = db.transaction.bind(db);
        db.transaction = (stores, mode) => {
          if (state.fail && mode === "readwrite") throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
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
  return { factory, state };
}

// Two records of one draft as ClayJS 1.23.0 wrote them: B was saved on top of A.
export const A = { v: 1, savedAt: "2026-11-10T00:00:00.000Z", id: "a1aaaaaaaaaa", ancestry: ["root:"], data: { title: "title A", note: "note A", rows: [{ id: "r1", name: "First" }] } };
export const B = { v: 1, savedAt: "2026-11-11T00:00:00.000Z", id: "b2bbbbbbbbbb", ancestry: ["a1aaaaaaaaaa", "root:"], data: { title: "title B", note: "note B", rows: [{ id: "r1", name: "First" }] } };

export const cacheOf = (record, w = { rev: 1, reset: "" }) => JSON.stringify({ ...record, w });
export const headFor = (record, w = { rev: 1, reset: "" }, data = { title: record.data.title, rows: record.data.rows }) =>
  JSON.stringify({ v: 2, savedAt: record.savedAt, id: record.id, ancestry: record.ancestry, idb: true, data, w });

export function type(text) {
  const note = document.getElementById("note");
  note.value = text;
  note.dispatchEvent(new Event("input", { bubbles: true }));
}

export const big = (letter, size = 300 * 1024) => letter.repeat(size);
