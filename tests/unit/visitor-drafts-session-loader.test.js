/**
 * Step 2 of the one-transaction drafts (05b) through the real loader: the boot from the
 * cache, a head that waits for the database, a save that is saved once its transaction
 * completed, and the page loads where the database is slow, failing or missing.
 */
import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import {
  A,
  B,
  bootPage,
  cacheOf,
  failingFactory,
  headFor,
  keyFor,
  otherTab,
  pause,
  readIdb,
  seedIdb,
  slowFactory,
  type,
  useFactory,
  noDatabase,
  waitFor,
} from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

const title = () => document.getElementById("title").textContent;
const note = () => document.getElementById("note").value;

test("a ClayJS 1.23.0 draft in localStorage restores at once and becomes the database's first record under its own id", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const { clay, key, local } = await bootPage({ slot: "load-move-1", localRaw: JSON.stringify(A) });

  expect(title()).toBe("title A");
  expect(clay.visitorDrafts.restored()).toEqual({ restored: true, hadDraft: true, parked: false });
  await waitFor(async () => (await readIdb(factory, key)).record !== null, "the record in the database");
  const { record, meta, v1base } = await readIdb(factory, key);
  expect(record).toEqual(A);
  expect(v1base).toEqual(A);
  expect(meta).toMatchObject({ gen: 1, rev: 1, foreign: A.id });
  await waitFor(() => JSON.parse(local()).w !== undefined, "the cache");
  expect(JSON.parse(local())).toEqual({ ...A, w: { rev: 1, reset: "" } });
});

test("a first visit does not wait for the database", async () => {
  const { factory, state } = slowFactory(new IDBFactory(), 300);
  useFactory(factory);
  const { clay } = await bootPage({ slot: "load-first-1" });

  expect(state.opened).toBe(false);
  expect(title()).toBe("owner title");
  expect(clay.visitorDrafts.restored()).toEqual({ restored: false, hadDraft: false, parked: false });
  expect(clay.visitorDrafts.hasDraft()).toBe(false);
});

test("a draft the cache holds in full is on the page before the database opens", async () => {
  const real = new IDBFactory();
  const key = keyFor("load-cache-1");
  await seedIdb(real, key, { record: B });
  const { factory, state } = slowFactory(real, 300);
  useFactory(factory);
  await bootPage({ slot: "load-cache-1", localRaw: cacheOf(B) });

  expect(state.opened).toBe(false);
  expect(title()).toBe("title B");
});

test("a head waits for the database, and the draft is on the page before the boot finishes", async () => {
  const real = new IDBFactory();
  const key = keyFor("load-head-1");
  await seedIdb(real, key, { record: B });
  const { factory, state } = slowFactory(real, 100);
  useFactory(factory);
  const { clay, local } = await bootPage({ slot: "load-head-1", localRaw: headFor(B) });

  expect(state.opened).toBe(true);
  expect(title()).toBe("title B");
  expect(note()).toBe("note B");
  expect(clay.visitorDrafts.restored()).toEqual({ restored: true, hadDraft: true, parked: false });
  expect(Object.keys(localStorage).filter((name) => name.includes(":unreadable:"))).toEqual([]);
  expect(JSON.parse(local()).w).toEqual({ rev: 1, reset: "" });
}, 10000);

test("a cache from before the last Start over is not shown: the page waits for what the database holds", async () => {
  const real = new IDBFactory();
  const key = keyFor("load-stale-1");
  await seedIdb(real, key, { meta: { gen: 2, rev: 3, reset: "2~new" } });
  useFactory(real);
  localStorage.clear();
  const { clay, local } = await bootPage({ slot: "load-stale-1", keep: true, localRaw: null });
  expect(title()).toBe("owner title");

  localStorage.setItem(key, cacheOf(B, { rev: 2, reset: "" }));
  localStorage.setItem(key + ":reset", "2~new");
  const again = await bootPage({ slot: "load-stale-1", keep: true });
  expect(title()).toBe("owner title");
  expect(again.clay.visitorDrafts.restored()).toEqual({ restored: false, hadDraft: false, parked: false });
  await waitFor(() => again.local() === null, "the stale copy to go");
  expect(clay).toBeDefined();
  expect(local()).toBe(null);
}, 10000);

test("a save says saved only once the database has it, and then the cache has it too", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const { clay, key, local, count, slots } = await bootPage({ slot: "load-save-1" });

  type("typed");
  const result = await clay.save();

  expect(result).toMatchObject({ ok: true, msg: "Saved in this browser" });
  const { record, meta } = await readIdb(factory, key);
  expect(record.data).toEqual({ title: "owner title", note: "typed", rows: [{ id: "r1", name: "First" }] });
  expect(JSON.parse(local())).toEqual({ ...record, w: { rev: meta.rev, reset: "" } });
  expect(slots()).toEqual([]);
  expect(count("clay:drafts-saved")).toBe(1);
  expect(clay.visitorDrafts.hasDraft()).toBe(true);
  expect(clay.hasUnsavedChanges()).toBe(false);
});

test("a failed transaction is a failed save; the operation stays journaled and the next save delivers both", async () => {
  const base = new IDBFactory();
  const { factory, state } = failingFactory(base);
  useFactory(factory);
  const { clay, key, count, slots } = await bootPage({ slot: "load-failed-1" });
  await pause();

  state.fail = true;
  type("first");
  const failed = await clay.save();
  expect(failed.ok).toBe(false);
  expect(count("clay:drafts-store-failed")).toBeGreaterThanOrEqual(1);
  expect(clay.hasUnsavedChanges()).toBe(true);
  expect(slots().length).toBe(1);

  state.fail = false;
  document.getElementById("title").textContent = "second";
  const saved = await clay.save();
  expect(saved).toMatchObject({ ok: true });
  const { record, meta } = await readIdb(base, key);
  expect(record.data).toMatchObject({ title: "second", note: "first" });
  expect(meta.rev).toBe(2);
  expect(clay.hasUnsavedChanges()).toBe(false);
  expect(slots()).toEqual([]);
});

test("a save made while the database is still opening is journaled at once and committed when it opens", async () => {
  const real = new IDBFactory();
  const { factory, state } = slowFactory(real, 200);
  useFactory(factory);
  const { clay, key, slots } = await bootPage({ slot: "load-opening-1" });

  type("typed early");
  expect(clay.visitorDrafts.saveNow()).toBe(true);
  expect(state.opened).toBe(false);
  expect(slots().length).toBe(1);
  expect(clay.visitorDrafts.hasDraft()).toBe(true);

  await waitFor(async () => (await readIdb(real, key)).record?.data.note === "typed early", "the commit");
  await waitFor(() => slots().length === 0, "the journal slot to go");
}, 10000);

test("the database does not open: localStorage is the record for this page load, and what was journaled is saved there", async () => {
  const { factory } = slowFactory(new IDBFactory(), 100, { fail: true });
  useFactory(factory);
  const { clay, key, local, slots } = await bootPage({ slot: "load-nodb-1" });

  type("typed early");
  expect(clay.visitorDrafts.saveNow()).toBe(true);
  expect(slots().length).toBe(1);
  await waitFor(() => local() !== null, "the localStorage record");
  expect(slots()).toEqual([]);
  expect(JSON.parse(local())).toMatchObject({ v: 1, data: { note: "typed early" } });
  expect("w" in JSON.parse(local())).toBe(false);

  type("typed later");
  expect(await clay.save()).toMatchObject({ ok: true });
  expect(JSON.parse(localStorage.getItem(key)).data.note).toBe("typed later");
}, 10000);

test("a head whose database does not open is never written over, and nothing is saved for this page load", async () => {
  useFactory({ open: () => { throw new Error("no database"); } });
  const raw = headFor(B);
  const { clay, local, count } = await bootPage({ slot: "load-refused-1", localRaw: raw });

  expect(clay.visitorDrafts.restored()).toEqual({ restored: false, hadDraft: true, parked: false, blocked: true });
  expect(title()).toBe("owner title");
  expect(count("clay:drafts-store-failed")).toBe(1);
  type("typed over nothing");
  expect((await clay.save()).ok).toBe(false);
  expect(clay.visitorDrafts.saveNow()).toBe(false);
  window.dispatchEvent(new Event("pagehide"));
  expect(local()).toBe(raw);
  const mine = Object.keys(localStorage).filter((name) => name.startsWith(keyFor("load-refused-1")) && !name.endsWith(":ui"));
  expect(mine).toEqual([keyFor("load-refused-1")]);
  expect(clay.hasUnsavedChanges()).toBe(true);
});

test("another tab's commit reaches a page with nothing unsaved, and a closed tab's journal counts as a draft", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const key = keyFor("load-other-1");
  localStorage.clear();
  localStorage.setItem(key + ":op:closed", JSON.stringify({ tab: "closed", reset: "", acked: 0, at: 0, ops: [{ seq: 1, savedAt: "2026-11-12T00:00:00.000Z", keys: { title: { b: "owner title", m: "left in a journal" } } }] }));
  const { clay, slots, events } = await bootPage({ slot: "load-other-1", keep: true });
  expect(clay.visitorDrafts.hasDraft()).toBe(true);

  await waitFor(() => title() === "left in a journal", "the closed tab's operation on the page");
  expect((await readIdb(factory, key)).record.data.title).toBe("left in a journal");
  await waitFor(() => slots().length === 0, "the closed tab's slot to go");

  await otherTab(factory, key, { ops: [{ seq: 1, savedAt: "2026-11-12T00:00:01.000Z", keys: { note: { b: "owner note", m: "from the other tab" } } }] });
  await waitFor(() => note() === "from the other tab", "the other tab's note");
  expect(events.filter((event) => event.name === "clay:drafts-restored").map((event) => Boolean(event.detail.external))).toEqual([false, true, true]);
}, 10000);
