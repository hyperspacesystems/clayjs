/**
 * Step 3 of the one-transaction drafts (05b) through the real loader: another tab's Start
 * over reloads this page without the browser asking, Start over from the public API ends
 * the generation in the database before the page loads again, and what a closed tab
 * journaled is on the page after the boot.
 *
 * The first test is the only one that asks whether the browser would warn: every boot's
 * `beforeunload` listener stays on the window, so it runs before any other boot exists.
 */
import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { A, bootPage, cacheOf, failingFactory, keyFor, noDatabase, pause, readIdb, seedIdb, slowFactory, type, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

const title = () => document.getElementById("title").textContent;
const note = () => document.getElementById("note").value;
const flag = (key) => sessionStorage.getItem(key + ":started-over");

function leave() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

// `window.location.reload()` as a browser runs it: the page is asked, then hidden. `seen`
// is called at that moment, for what must already be true by then.
function reloads(seen = () => null) {
  const real = window.location;
  const calls = [];
  const fake = {
    href: real.href,
    pathname: real.pathname,
    search: real.search,
    hash: real.hash,
    origin: real.origin,
    reload() {
      calls.push({ asked: leave(), seen: seen() });
      window.dispatchEvent(new Event("pagehide"));
    },
  };
  Object.defineProperty(window, "location", { value: fake, configurable: true });
  return { calls, restore: () => Object.defineProperty(window, "location", { value: real, configurable: true }) };
}

// A factory that counts the read-write transactions that have not completed.
function countingFactory(real) {
  const state = { running: 0, total: 0 };
  const factory = {
    open(name, version) {
      const req = real.open(name, version);
      const fake = {};
      req.onupgradeneeded = (event) => { fake.result = req.result; fake.onupgradeneeded?.(event); };
      req.onsuccess = (event) => {
        const db = req.result;
        const transaction = db.transaction.bind(db);
        db.transaction = (stores, mode) => {
          const tx = transaction(stores, mode);
          if (mode === "readwrite") {
            state.running++;
            state.total++;
            const done = () => { state.running--; };
            tx.addEventListener("complete", done);
            tx.addEventListener("abort", done);
          }
          return tx;
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

test("another tab's Start over: this page drops what it had not saved and loads again without the browser asking", async () => {
  sessionStorage.clear();
  const base = new IDBFactory();
  const { factory, state } = failingFactory(base);
  useFactory(factory);
  const { clay, key, local, slots } = await bootPage({ slot: "over-other-1" });
  await pause();
  type("saved before");
  expect((await clay.save()).ok).toBe(true);

  // A save that failed: the browser would ask before this page goes.
  state.fail = true;
  type("never saved");
  expect((await clay.save()).ok).toBe(false);
  expect(leave()).toBe(true);
  expect(slots().length).toBe(1);
  state.fail = false;

  const page = reloads();
  try {
    localStorage.removeItem(key);
    localStorage.setItem(key + ":reset", "2~other");
    window.dispatchEvent(new StorageEvent("storage", { key: key + ":reset" }));
    await waitFor(() => page.calls.length === 1, "the reload");
    await pause();
  } finally {
    page.restore();
  }
  expect(page.calls.map((call) => call.asked)).toEqual([false]);
  expect(slots()).toEqual([]);
  expect(local()).toBe(null);
  expect(flag(key)).toBe("1");
  const { record, meta } = await readIdb(base, key);
  expect(record).toBe(null);
  expect(meta).toMatchObject({ gen: 2, reset: "2~other" });

  // The page that is going away saves nothing more.
  type("typed while the page loads again");
  await clay.save().catch(() => {});
  expect((await readIdb(base, key)).record).toBe(null);
  expect(local()).toBe(null);
});

test("Start over from the API ends the generation in the database before the page loads again, and the next page load has no draft", async () => {
  sessionStorage.clear();
  const { factory, state } = countingFactory(new IDBFactory());
  useFactory(factory);
  const { clay, key, local, slots } = await bootPage({ slot: "over-api-1" });
  type("a draft");
  expect((await clay.save()).ok).toBe(true);
  expect(clay.visitorDrafts.hasDraft()).toBe(true);
  const before = state.total;
  type("typed after the save");

  const page = reloads(() => ({ running: state.running, total: state.total, marker: local(":reset"), cache: local() }));
  try {
    expect(clay.visitorDrafts.reset()).toBe(true);
    expect(page.calls.length).toBe(0);
    await waitFor(() => page.calls.length === 1, "the reload");
    await pause();
  } finally {
    page.restore();
  }
  const [{ seen }] = page.calls;
  expect(seen.running).toBe(0);
  expect(seen.total).toBeGreaterThan(before);
  expect(seen.marker).toMatch(/^2~[a-z0-9]+$/);
  expect(seen.cache).toBe(null);
  const { record, meta } = await readIdb(factory, key);
  expect(record).toBe(null);
  expect(meta).toMatchObject({ gen: 2, reset: seen.marker });
  expect(local()).toBe(null);
  expect(slots()).toEqual([]);
  expect(flag(key)).toBe(null);

  const next = await bootPage({ slot: "over-api-1", keep: true });
  expect([title(), note()]).toEqual(["owner title", "owner note"]);
  expect(next.clay.visitorDrafts.restored()).toEqual({ restored: false, hadDraft: false, parked: false });
  expect(next.clay.visitorDrafts.hasDraft()).toBe(false);
  type("the next draft");
  expect((await next.clay.save()).ok).toBe(true);
  const after = await readIdb(factory, key);
  expect(after.record.data.note).toBe("the next draft");
  expect(after.record.ancestry).toEqual(["root:" + seen.marker]);
  expect(after.meta.gen).toBe(2);
});

test("Start over pressed before the database has opened waits for its generation to end, and no notice follows", async () => {
  sessionStorage.clear();
  const real = new IDBFactory();
  const key = keyFor("over-early-1");
  await seedIdb(real, key, { record: A, meta: { rev: 3 } });
  const { factory, state } = slowFactory(real, 200);
  useFactory(factory);
  const { clay, local } = await bootPage({ slot: "over-early-1", localRaw: cacheOf(A, { rev: 3, reset: "" }) });
  expect(title()).toBe("title A");
  expect(state.opened).toBe(false);

  const page = reloads();
  try {
    expect(clay.visitorDrafts.reset()).toBe(true);
    expect(page.calls.length).toBe(0);
    expect(local()).not.toBe(null);
    await waitFor(async () => state.opened && (await readIdb(real, key)).record === null, "the generation to end");
    await pause();
  } finally {
    page.restore();
  }
  const { meta } = await readIdb(real, key);
  expect(meta).toMatchObject({ gen: 2, reset: local(":reset") });
  expect(local(":reset")).not.toBe(null);
  expect(page.calls.length).toBe(1);
  expect(flag(key)).toBe(null);
  expect(local()).toBe(null);
});

test("what a closed tab journaled and never sent is on the page after the boot, and counts as a draft before that", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const key = keyFor("over-journal-1");
  localStorage.clear();
  localStorage.setItem(key + ":op:closed", JSON.stringify({ tab: "closed", reset: "", acked: 0, at: 0, ops: [{ seq: 1, savedAt: "2026-11-12T00:00:00.000Z", keys: { note: { b: "owner note", m: "typed, then the tab closed" } } }] }));
  const { clay, events, slots, local } = await bootPage({ slot: "over-journal-1", keep: true });

  expect(clay.visitorDrafts.hasDraft()).toBe(true);
  await waitFor(() => note() === "typed, then the tab closed", "the journaled note on the page");
  expect(events.filter((event) => event.name === "clay:drafts-restored").map((event) => Boolean(event.detail.external))).toEqual([false, true]);
  const { record, meta } = await readIdb(factory, key);
  expect(record.data).toEqual({ title: "owner title", note: "typed, then the tab closed", rows: [{ id: "r1", name: "First" }] });
  expect(meta.tabs.closed.seq).toBe(1);
  expect(meta.rev).toBe(1);
  expect(slots()).toEqual([]);
  expect(JSON.parse(local()).data.note).toBe("typed, then the tab closed");
  expect(clay.hasUnsavedChanges()).toBe(false);
});

test("a journal from before the last Start over is never applied", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const key = keyFor("over-journal-2");
  localStorage.clear();
  localStorage.setItem(key + ":reset", "2~since");
  localStorage.setItem(key + ":op:closed", JSON.stringify({ tab: "closed", reset: "", acked: 0, at: 0, ops: [{ seq: 1, savedAt: "2026-11-12T00:00:00.000Z", keys: { note: { b: "owner note", m: "from before Start over" } } }] }));
  const { slots, local } = await bootPage({ slot: "over-journal-2", keep: true });

  await waitFor(() => slots().length === 0, "the old journal to be swept");
  await pause();
  expect(note()).toBe("owner note");
  const { record, meta } = await readIdb(factory, key);
  expect(record).toBe(null);
  expect(meta).toMatchObject({ gen: 2, reset: "2~since" });
  expect(local()).toBe(null);
});
