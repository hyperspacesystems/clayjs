/**
 * Step 2 of the one-transaction drafts (05b): a tab's saves as operations, its journal slot,
 * the acknowledgement, the cache `localStorage` gets after a commit, and what a tab does
 * with another tab's commit. Real store, real session, real transaction, fake IndexedDB.
 */
import { beforeEach, expect, test } from "@jest/globals";
import { SERVED, big, failing, openTab, stored, transactOnce, world } from "./helpers/visitor-drafts-session.js";

beforeEach(() => localStorage.clear());

const slotOf = (tab) => JSON.parse(localStorage.getItem(tab.store.slotKey));

test("a save is an operation: the keys the page changed, each with the stored value it was built on, journaled at once", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("typed");
  const op = t.capture();
  expect(op.keys).toEqual({ title: { b: "owner title", m: "typed" } });
  expect(op.seq).toBe(1);
  expect(slotOf(t)).toMatchObject({ tab: t.store.tab, reset: "", acked: 0, ops: [op] });
  expect((await stored(w)).record).toBe(null);
  expect(t.count("clay:drafts-saved")).toBe(0);

  await t.sync();
  const { record, meta } = await stored(w);
  expect(record.data).toEqual({ ...SERVED, title: "typed" });
  expect(meta.tabs[t.store.tab].seq).toBe(1);
  expect(w.slots()).toEqual([]);
  expect(w.parsed()).toEqual({ ...record, w: { rev: meta.rev, reset: "" } });
  expect(t.events.filter((event) => event.name === "clay:drafts-saved").map((event) => event.detail)).toEqual([{ data: record.data }]);
});

test("a save of an unchanged page makes no operation and says so", async () => {
  const w = world();
  const t = await openTab(w);
  expect(t.capture()).toBe(null);
  expect(w.slots()).toEqual([]);
  expect(t.events.map((event) => event.detail)).toEqual([{ data: SERVED, unchanged: true }]);
  await t.sync();
  expect((await stored(w)).record).toBe(null);
});

test("a tab with nothing unsaved takes another tab's commit in; a tab with unsaved changes is not rewritten and merges at its next save", async () => {
  const w = world();
  const [a, b] = [await openTab(w), await openTab(w)];
  a.addRow("r2", "from a");
  await a.save();
  await b.sync();
  expect(b.shows().rows).toEqual([{ id: "r1", name: "First" }, { id: "r2", name: "from a" }]);
  expect(b.events.filter((event) => event.name === "clay:drafts-restored").map((event) => event.detail.external)).toEqual([true]);

  b.note("b is typing");
  a.title("a title");
  await a.save();
  await b.sync();
  expect(b.shows()).toMatchObject({ title: "owner title", note: "b is typing" });

  await b.save();
  expect((await stored(w)).record.data).toEqual({ title: "a title", note: "b is typing", rows: [{ id: "r1", name: "First" }, { id: "r2", name: "from a" }] });
  expect(b.shows().title).toBe("a title");
  expect(b.store.changed()).toBe(false);
});

test("a tab's own commit is not taken in as another tab's: no restore event follows its save", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("mine");
  await t.save();
  t.note("mine too");
  await t.save();
  expect(t.count("clay:drafts-restored")).toBe(0);
  expect(t.count("clay:drafts-saved")).toBe(2);
});

test("a failed transaction keeps its operation: it goes again unchanged, ahead of the tab's later ones", async () => {
  const w = world();
  const state = failing(w);
  const t = await openTab(w);
  t.title("one");
  state.fail = true;
  await expect(t.save()).rejects.toMatchObject({ code: "draft-storage" });
  expect(t.count("clay:drafts-store-failed")).toBe(1);
  const first = slotOf(t).ops[0];
  t.note("two");
  await expect(t.save()).rejects.toMatchObject({ code: "draft-storage" });
  expect(slotOf(t).ops.map((op) => op.seq)).toEqual([1, 2]);
  expect(slotOf(t).ops[0]).toEqual(first);
  expect(t.count("clay:drafts-saved")).toBe(0);

  state.fail = false;
  await t.sync();
  const { record, meta } = await stored(w);
  expect(record.data).toMatchObject({ title: "one", note: "two" });
  expect(meta.rev).toBe(2);
  expect(w.slots()).toEqual([]);
  expect(t.count("clay:drafts-saved")).toBe(1);
});

test("an operation another tab delivered from the journal slot is not applied again by its own tab", async () => {
  const w = world();
  const [a, b] = [await openTab(w), await openTab(w)];
  a.addRow("r2", "once");
  a.capture();
  await Promise.all([b.sync(), a.sync(), b.sync()]);
  const { record, meta } = await stored(w);
  expect(record.data.rows.map((r) => r.id)).toEqual(["r1", "r2"]);
  expect(meta.rev).toBe(1);
  expect(a.store.pending()).toBe(0);
});

test("the cache is the record with a w field up to 256 KB, and a head of the small keys beyond that", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("small");
  await t.save();
  expect(w.parsed().v).toBe(1);
  expect(w.parsed().w).toEqual({ rev: 1, reset: "" });

  t.note(big("x"));
  await t.save();
  const head = w.parsed();
  expect(head).toMatchObject({ v: 2, idb: true, data: { title: "small", rows: SERVED.rows }, w: { rev: 2, reset: "" } });
  expect("note" in head.data).toBe(false);
  expect("full" in head).toBe(false);
  expect(head.id).toBe((await stored(w)).record.id);
  expect(w.local().length).toBeLessThan(2048);
});

test("a transaction's result never replaces a cache a later transaction left", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("first");
  await t.save();
  const cached = w.parsed();
  const later = JSON.stringify({ ...cached, data: { ...cached.data, title: "from a later transaction" }, w: { rev: 9, reset: "" } });
  localStorage.setItem(w.key, later);
  await t.sync();
  expect(w.local()).toBe(later);

  localStorage.setItem(w.key, JSON.stringify({ ...cached, w: { rev: 0, reset: "" } }));
  await t.sync();
  expect(w.parsed()).toEqual(cached);
});

test("two tabs add rows at the same moment: both rows are stored and both tabs show them", async () => {
  const w = world();
  const [a, b] = [await openTab(w), await openTab(w)];
  a.addRow("r2", "from a");
  b.addRow("r3", "from b");
  a.capture();
  b.capture();
  await Promise.all([a.sync(), b.sync()]);
  await a.sync();
  const { record, conflict } = await stored(w);
  expect(record.data.rows.map((r) => r.id).sort()).toEqual(["r1", "r2", "r3"]);
  expect(conflict).toBe(null);
  expect(a.shows().rows.map((r) => r.id).sort()).toEqual(["r1", "r2", "r3"]);
  expect(b.shows().rows.map((r) => r.id).sort()).toEqual(["r1", "r2", "r3"]);
});

test("an operation too large for the journal slot is unconfirmed until its transaction completes", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("small first");
  t.capture();
  expect(t.store.unsafe()).toBe(false);
  t.note(big("x", 600 * 1024));
  t.capture();
  expect(t.store.unsafe()).toBe(true);
  expect(slotOf(t).ops.map((op) => op.seq)).toEqual([1]);
  t.title("small after");
  t.capture();
  expect(t.store.unsafe()).toBe(true);
  expect(t.store.keep()).toBe(false);

  await t.sync();
  expect(t.store.unsafe()).toBe(false);
  expect(t.store.keep()).toBe(true);
  expect((await stored(w)).record.data.note.length).toBe(600 * 1024);
});

test("the pending budget: once full nothing more is captured, the page keeps the change, and the next save takes it", async () => {
  const w = world();
  const state = failing(w);
  const t = await openTab(w, { pendingLimit: 300 });
  state.fail = true;
  t.note("n".repeat(400));
  await expect(t.save()).rejects.toMatchObject({ code: "draft-storage" });
  t.title("held back");
  expect(() => t.capture()).toThrow(/Couldn't save in this browser/);
  expect(t.store.pending()).toBe(1);
  expect(t.store.changed()).toBe(true);

  state.fail = false;
  await t.sync();
  expect(t.store.pending()).toBe(0);
  await t.save();
  expect((await stored(w)).record.data).toMatchObject({ title: "held back", note: "n".repeat(400) });
});

test("fields the stored value has and this page's rules lack are carried through a save", async () => {
  const w = world();
  const WIDE = '{"title":"#title","note":"#note@value","extra":"#title@data-extra","rows":["#rows > li[item]:not([cms-template])",{"id":"@data-id","name":".n","done":"@data-done"}]}';
  const wide = await openTab(w, { rules: WIDE });
  wide.doc.getElementById("title").setAttribute("data-extra", "kept");
  wide.doc.querySelector('#rows > li[data-id="r1"]').setAttribute("data-done", "yes");
  await wide.save();
  expect((await stored(w)).record.data).toMatchObject({ extra: "kept", rows: [{ id: "r1", name: "First", done: "yes" }] });

  const narrow = await openTab(w);
  narrow.doc.querySelector('#rows > li[data-id="r1"] .n').textContent = "Renamed";
  const op = narrow.capture();
  expect(Object.keys(op.keys)).toEqual(["rows"]);
  await narrow.sync();
  const { record, conflict } = await stored(w);
  expect(record.data).toMatchObject({ extra: "kept", rows: [{ id: "r1", name: "Renamed", done: "yes" }] });
  expect(conflict).toBe(null);
});

test("a field the rules gained after the draft was stored is saved without a conflict copy", async () => {
  const w = world();
  const narrow = await openTab(w);
  narrow.title("draft");
  await narrow.save();
  const WIDE = '{"title":"#title","note":"#note@value","rows":["#rows > li[item]:not([cms-template])",{"id":"@data-id","name":".n","done":"@data-done"}]}';
  const wide = await openTab(w, { rules: WIDE });
  expect(wide.shows().title).toBe("draft");
  wide.doc.querySelector('#rows > li[data-id="r1"]').setAttribute("data-done", "yes");
  await wide.save();
  const { record, conflict } = await stored(w);
  expect(record.data.rows).toEqual([{ id: "r1", name: "First", done: "yes" }]);
  expect(conflict).toBe(null);
});

test("another tab's journal slot is removed only once it is settled and its tab has gone quiet", async () => {
  const w = world();
  const t = await openTab(w);
  const dead = w.key + ":op:dead";
  const chain = { tab: "dead", reset: "", acked: 0, at: w.clock, ops: [{ seq: 1, savedAt: "s", keys: { title: { b: "owner title", m: "left behind" } } }] };
  localStorage.setItem(dead, JSON.stringify(chain));
  await t.sync();
  expect((await stored(w)).record.data.title).toBe("left behind");
  expect(t.shows().title).toBe("left behind");
  expect(localStorage.getItem(dead)).not.toBe(null);

  w.clock += 11 * 1000;
  await t.sync();
  expect(localStorage.getItem(dead)).toBe(null);
  expect((await stored(w)).meta.rev).toBe(1);

  const waiting = w.key + ":op:gap";
  localStorage.setItem(waiting, JSON.stringify({ tab: "gap", reset: "", acked: 0, at: 0, ops: [{ seq: 2, savedAt: "s", keys: { note: { m: "after a gap" } } }] }));
  await t.sync();
  expect(localStorage.getItem(waiting)).not.toBe(null);
});

test("a page that shows nothing of a draft enters the stored generation, and the marker in localStorage is put right", async () => {
  const w = world();
  await transactOnce(w, { resets: [{ ends: 1, marker: "2~x" }] });
  expect(localStorage.getItem(w.key + ":reset")).toBe(null);
  const t = await openTab(w);
  expect(t.reloaded).toBe(0);
  expect(t.store.generation()).toBe("2~x");
  expect(localStorage.getItem(w.key + ":reset")).toBe("2~x");
  t.title("in the new generation");
  await t.save();
  expect((await stored(w)).record.data.title).toBe("in the new generation");
  expect(w.parsed().w).toEqual({ rev: 2, reset: "2~x" });
});

test("a page that shows a draft whose generation ended stops saving, drops its journal and loads again", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("draft");
  await t.save();
  t.note("typed after");
  t.capture();
  expect(w.slots().length).toBe(1);

  localStorage.setItem(w.key + ":reset", "2~y");
  await t.sync();
  expect(t.reloaded).toBe(1);
  expect(w.slots()).toEqual([]);
  expect(w.local()).toBe(null);
  const { record, meta } = await stored(w);
  expect([record, meta.gen, meta.reset]).toEqual([null, 2, "2~y"]);
  t.title("typed in the dead page");
  expect(t.capture()).toBe(null);
  expect(t.store.keep()).toBe(true);
});

test("a marker that names a generation that had already ended is replaced by the stored one", async () => {
  const w = world();
  await transactOnce(w, { resets: [{ ends: 1, marker: "2~a" }] });
  localStorage.setItem(w.key + ":reset", "2~b");
  const t = await openTab(w);
  expect(localStorage.getItem(w.key + ":reset")).toBe("2~a");
  expect(t.store.generation()).toBe("2~a");
  expect((await stored(w)).meta).toMatchObject({ gen: 2, reset: "2~a" });
});

test("at a hide, an operation too large for the journal slot goes into the database blind, and the next tab applies it once", async () => {
  const w = world();
  const state = failing(w);
  const t = await openTab(w);
  t.note(big("x", 600 * 1024));
  t.capture();
  expect(w.slots()).toEqual([]);
  state.fail = "change";
  t.session.hide();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const row = (await stored(w)).all.get(`${w.key}:op:${t.store.tab}`);
  expect(JSON.parse(row).ops.map((op) => op.seq)).toEqual([1]);
  expect((await stored(w)).record).toBe(null);

  state.fail = false;
  const next = await openTab(w);
  const { record, meta, all } = await stored(w);
  expect(record.data.note.length).toBe(600 * 1024);
  expect(meta.rev).toBe(1);
  expect([...all.keys()].filter((name) => name.includes(":op:"))).toEqual([]);
  expect(next.shows().note.length).toBe(600 * 1024);
  await t.sync();
  expect((await stored(w)).meta.rev).toBe(1);
});

test("at a hide, operations the journal slot holds in full are not written blind", async () => {
  const w = world();
  const state = failing(w);
  const t = await openTab(w);
  t.note("small");
  t.capture();
  state.fail = "change";
  t.session.hide();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect([...(await stored(w)).all.keys()].filter((name) => name.includes(":op:"))).toEqual([]);
  expect(w.slots().length).toBe(1);
});

test("an operation made while a transaction is in flight is not acknowledged by it, and goes with the next", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("first");
  t.capture();
  // The transaction reads the Start over marker once its reads are in; the next operation is
  // made right after it has built what it will write.
  const getItem = Storage.prototype.getItem;
  let armed = true;
  Storage.prototype.getItem = function (name) {
    if (armed && name === w.key + ":reset") {
      armed = false;
      queueMicrotask(() => { t.note("second"); t.capture(); });
    }
    return getItem.call(this, name);
  };
  try { await t.sync(); } finally { Storage.prototype.getItem = getItem; }
  expect(armed).toBe(false);
  expect(t.store.pending()).toBe(1);
  expect(slotOf(t).ops.map((op) => op.seq)).toEqual([2]);
  expect((await stored(w)).record.data).toMatchObject({ title: "first", note: "owner note" });

  await t.sync();
  const { record, meta } = await stored(w);
  expect(record.data).toMatchObject({ title: "first", note: "second" });
  expect(meta.rev).toBe(2);
  expect(t.count("clay:drafts-saved")).toBe(1);
});

test("a page document: another tab's page goes to the page editor, a page built on it replaces it, and a page that never saw it keeps it as a copy", async () => {
  const w = world();
  const [a, b] = [await openTab(w, { article: true }), await openTab(w, { article: true })];
  a.writePage("r1", { v: 1, y: "AAA" });
  await a.save();
  const first = await stored(w);
  expect(first.record.blockeditor.rev).toBe("r1");
  expect(first.record.live.blockeditor).toEqual({ v: 1, y: "AAA" });
  expect(first.meta.unit).not.toBe(null);

  await b.sync();
  const external = b.events.filter((event) => event.name === "clay:drafts-blockeditor-external");
  expect(external.map((event) => event.detail.live.blockeditor)).toEqual([{ v: 1, y: "AAA" }]);
  await b.sync();
  expect(b.count("clay:drafts-blockeditor-external")).toBe(2);
  external[0].detail.adopted();
  await b.sync();
  expect(b.count("clay:drafts-blockeditor-external")).toBe(2);

  b.writePage("r2", { v: 1, y: "AAABBB" });
  await b.save();
  const second = await stored(w);
  expect(second.record.blockeditor.rev).toBe("r2");
  expect(second.conflict).toBe(null);

  a.writePage("r3", { v: 1, y: "AAACCC" });
  await a.save();
  const third = await stored(w);
  expect(third.record.blockeditor.rev).toBe("r3");
  expect(third.conflict.blockeditor.rev).toBe("r2");
  expect([...third.all.keys()].filter((name) => name.includes(":conflict:"))).toEqual([`${w.key}:conflict:${second.record.id}`]);
});

test("a page document: a save that leaves the page alone keeps the stored page", async () => {
  const w = world();
  const [a, b] = [await openTab(w, { article: true }), await openTab(w, { article: true })];
  a.writePage("r1", { v: 1, y: "AAA" });
  await a.save();
  b.title("b changed a field only");
  const op = b.capture();
  expect("unit" in op).toBe(false);
  await b.sync();
  const { record, conflict } = await stored(w);
  expect(record.data.title).toBe("b changed a field only");
  expect(record.blockeditor.rev).toBe("r1");
  expect(conflict).toBe(null);
});
