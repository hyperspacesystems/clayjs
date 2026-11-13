/**
 * Step 4 of the one-transaction drafts (05b): a record another writer left in
 * `localStorage` (a tab on a released ClayJS, or a page load of this one without the
 * database), met after the draft moved into the database. It is taken in once: merged
 * exactly when the copy it was built on is held, kept whole as a recovery copy when it is
 * not. The first half is `commit()` alone; the second is tabs on the real session.
 */
import { beforeEach, expect, jest, test } from "@jest/globals";
import { RECOVERY_KEEP, commit as commitWith, foreignMark, recoveryKey } from "../../src/plugins/visitor-drafts/commit.js";
import { unitMark } from "../../src/plugins/visitor-drafts/store.js";
import { TOOLS } from "./helpers/visitor-drafts-tabs.js";
import { SERVED, big, oldTabPage, oldTabSave, oldTabWrite, openTab, stored, transactOnce, world } from "./helpers/visitor-drafts-session.js";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const toast of document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')?.shadowRoot?.querySelectorAll("[data-clay-toast]") ?? []) toast.remove();
});

const NOW = Date.parse("2026-11-12T12:00:00Z");
let ids = 0;
const commit = (state, input = {}) => commitWith(state, { seed: SERVED, now: NOW, newId: () => "n" + ++ids, ...TOOLS, ...input });

const rows = (...names) => names.map((name) => ({ id: name, name }));
const record = (id, ancestry, data, extra = {}) => ({ v: 1, savedAt: "2026-11-12T10:00:00.000Z", id, ancestry, data: { ...SERVED, ...data }, ...extra });
const meta = (extra = {}) => ({ gen: 1, rev: 5, reset: "", tabs: {}, foreign: null, unit: null, ...extra });
const cacheOf = (copy, w = { rev: 4, reset: "" }) => ({ ...copy, w });
const pageOf = (rev, y) => ({ live: { blockeditor: { v: 1, y } }, blockeditor: { rev, html: `<p>${y}</p>` } });

const S1 = record("s1", ["root:"], { title: "first title" });
const S2 = record("s2", ["s1", "root:"], { title: "second title" });

test("a record built on the stored record merges exactly, gets a new id above its own, and is taken in once", () => {
  const F = record("f1", ["s2", "s1", "root:"], { title: "second title", note: "old tab note" });
  const out = commit({ meta: meta(), record: S2, v1base: null }, { local: F });
  expect(out.record.data).toEqual({ ...SERVED, title: "second title", note: "old tab note" });
  expect(out.record.ancestry.slice(0, 3)).toEqual(["f1", "s2", "s1"]);
  expect(out.record.id).not.toBe("f1");
  expect([out.meta.foreign, out.meta.rev]).toEqual(["f1", 6]);
  expect(out.v1base).toEqual(F);
  expect([out.conflicts, out.recovered]).toEqual([[], []]);

  const again = commit({ meta: out.meta, record: out.record, v1base: out.v1base }, { local: F });
  expect(again.changed).toBe(false);
  expect(again.record).toEqual(out.record);
});

test("a record built on a cache one commit behind merges from the copy a storage event says it replaced", () => {
  const F = record("f1", ["s1", "root:"], { title: "first title", note: "old tab note" });
  const out = commit({ meta: meta(), record: S2, v1base: null }, { local: F, seen: cacheOf(S1), direct: true });
  expect(out.record.data).toEqual({ ...SERVED, title: "second title", note: "old tab note" });
  expect(out.recovered).toEqual([]);
  expect(out.conflicts).toEqual([]);
});

test("a later record of that tab still merges from the cache copy its line names, with every change since", () => {
  const F2 = record("f2", ["f1", "s1", "root:"], { title: "first title", note: "old tab note", rows: [...SERVED.rows, ...rows("old")] });
  const out = commit({ meta: meta(), record: S2, v1base: null }, { local: F2, seen: cacheOf(S1), direct: false });
  expect(out.record.data).toEqual({ title: "second title", note: "old tab note", rows: [...SERVED.rows, ...rows("old")] });
  expect(out.recovered).toEqual([]);
});

test("of two held copies a record descends from, the nearer one is its base", () => {
  // The old tab read the cache of s2 and wrote f2 on it; this side still holds the merged f1.
  const F1 = record("f1", ["s1", "root:"], { title: "first title", note: "old one" });
  const C2 = record("s2", ["f1", "s1", "root:"], { title: "second title", note: "old one" });
  const F2 = record("f2", ["s2", "f1", "s1", "root:"], { title: "second title", note: "old two" });
  const S3 = record("s3", ["s2", "f1", "s1", "root:"], { title: "third title", note: "old one" });
  const out = commit({ meta: meta({ foreign: "f1" }), record: S3, v1base: F1 }, { local: F2, seen: cacheOf(C2) });
  expect(out.record.data).toEqual({ ...SERVED, title: "third title", note: "old two" });
  expect(out.conflicts).toEqual([]);
});

test("a replaced copy is a base only when it is this generation's cache and the record names it or replaced it directly", () => {
  const F = record("f1", ["s1", "root:"], { note: "old tab note" });
  const unnamed = record("f9", ["zz", "root:"], { note: "old tab note" });
  const kept = (input) => commit({ meta: meta(), record: S2, v1base: null }, input);
  expect(kept({ local: F, seen: S1, direct: true }).recovered).toEqual([F]);
  expect(kept({ local: F, seen: cacheOf(S1, { rev: 4, reset: "0~gone" }), direct: true }).recovered).toEqual([F]);
  expect(kept({ local: unnamed, seen: cacheOf(S1), direct: false }).recovered).toEqual([unnamed]);
  expect(kept({ local: unnamed, seen: cacheOf(S1), direct: true }).recovered).toEqual([]);
});

test("a record with no id (ClayJS 1.22.0 and earlier) merges only from the copy it replaced directly", () => {
  const F = { v: 1, savedAt: "2026-11-12T11:00:00.000Z", data: { ...SERVED, title: "first title", note: "from 1.22" } };
  const merged = commit({ meta: meta(), record: S2, v1base: null }, { local: F, seen: cacheOf(S1), direct: true });
  expect(merged.record.data).toEqual({ ...SERVED, title: "second title", note: "from 1.22" });
  expect(merged.record.ancestry.slice(0, 2)).toEqual(["s2", "s1"]);
  expect(merged.meta.foreign).toBe("at:2026-11-12T11:00:00.000Z");

  const aside = commit({ meta: meta(), record: S2, v1base: null }, { local: F });
  expect(aside.recovered).toEqual([F]);
  expect(aside.record).toEqual(S2);
  expect(commit({ meta: aside.meta, record: aside.record, v1base: null }, { local: F }).changed).toBe(false);
});

test("a record that descends from the last merged record of that writer merges from it", () => {
  const F1 = record("f1", ["s1", "root:"], { title: "first title", note: "old one" });
  const F2 = record("f2", ["f1", "s1", "root:"], { title: "first title", note: "old two" });
  const M = record("m1", ["f1", "s2", "s1", "root:"], { title: "second title", note: "old one" });
  const out = commit({ meta: meta({ foreign: "f1" }), record: record("s3", ["m1"], { title: "third title", note: "old one" }), v1base: F1 }, { local: F2 });
  expect(out.record.data).toEqual({ ...SERVED, title: "third title", note: "old two" });
  expect(out.v1base).toEqual(F2);
  expect(M.id).toBe("m1");
});

test("a whole page written over a draft it never read is kept as a recovery copy: nothing is merged and no row is removed", () => {
  const draft = record("s9", ["s8"], { title: "draft title", rows: rows("one", "two", "three", "four") });
  const F = record("page1", ["root:"], { rows: rows("one", "nine") });
  const before = meta();
  const out = commit({ meta: before, record: draft, v1base: null }, { local: F });
  expect(out.record).toEqual(draft);
  expect(out.recovered).toEqual([F]);
  expect(out.meta.recovery).toEqual(["page1"]);
  expect([out.meta.foreign, out.meta.rev]).toEqual(["page1", before.rev]);
  expect(out.v1base).toBe(null);
  expect(out.conflicts).toEqual([]);
  expect(out.changed).toBe(true);
});

test("a later copy of a kept line replaces the copy it descends from, and only the newest copies are kept", () => {
  const draft = record("s9", ["s8"], {});
  const F1 = record("page1", ["root:"], { note: "one" });
  const F2 = record("page2", ["page1", "root:"], { note: "two" });
  const first = commit({ meta: meta(), record: draft, v1base: null }, { local: F1 });
  const second = commit({ meta: first.meta, record: first.record, v1base: first.v1base }, { local: F2 });
  expect(second.recovered).toEqual([F2]);
  expect(second.dropped).toEqual(["page1"]);
  expect(second.meta.recovery).toEqual(["page2"]);

  let state = { meta: meta(), record: draft, v1base: null };
  const dropped = [];
  for (let n = 1; n <= RECOVERY_KEEP + 2; n++) {
    const out = commit(state, { local: record("lone" + n, ["root:"], { note: "copy " + n }) });
    dropped.push(...out.dropped);
    state = { meta: out.meta, record: out.record, v1base: out.v1base };
  }
  expect(state.meta.recovery.length).toBe(RECOVERY_KEEP);
  expect(state.meta.recovery[0]).toBe("lone" + (RECOVERY_KEEP + 2));
  expect(dropped).toEqual(["lone1", "lone2"]);
});

test("with nothing stored in this generation, another writer's record is the draft, under its own id", () => {
  const F = record("page1", ["root:2~x"], { note: "written back after Start over" });
  const out = commit({ meta: meta({ gen: 2, reset: "2~x" }), record: null, v1base: null }, { local: F, marker: "2~x" });
  expect(out.record).toEqual(F);
  expect(out.v1base).toEqual(F);
  expect(out.recovered).toEqual([]);
  expect(out.meta.foreign).toBe("page1");
});

test("both changed one field since the copy the record was built on: its value is stored and the replaced record is kept", () => {
  const F = record("f1", ["s1", "root:"], { title: "old tab title" });
  const out = commit({ meta: meta(), record: S2, v1base: null }, { local: F, seen: cacheOf(S1), direct: true });
  expect(out.record.data.title).toBe("old tab title");
  expect(out.conflicts).toEqual([S2]);
});

test("a page (ClayJS 1.24.0 writes it into the record) replaces the stored page only when that tab changed it", () => {
  const [p1, p2, p3] = [pageOf("r1", "A"), pageOf("r2", "AB"), pageOf("r3", "AC")];
  const stored1 = record("s1", ["root:"], {}, p1);
  const state = (held) => ({ meta: meta({ unit: unitMark(held) }), record: record("s2", ["s1", "root:"], {}, held), v1base: null });

  const changed = commit(state(p1), { local: record("f1", ["s2", "s1"], { note: "n" }, p2) });
  expect(changed.record.blockeditor.rev).toBe("r2");
  expect(changed.meta.unit).toBe(unitMark(p2));
  expect(changed.conflicts).toEqual([]);

  const untouched = commit(state(p3), { local: record("f1", ["s1"], { note: "n" }, p1), seen: cacheOf(stored1), direct: true });
  expect(untouched.record.blockeditor.rev).toBe("r3");
  expect(untouched.record.data.note).toBe("n");
  expect(untouched.conflicts).toEqual([]);

  const both = commit(state(p3), { local: record("f1", ["s1"], {}, p2), seen: cacheOf(stored1), direct: true });
  expect(both.record.blockeditor.rev).toBe("r2");
  expect(both.conflicts.map((copy) => copy.blockeditor.rev)).toEqual(["r3"]);
  expect(both.meta.unit).toBe(unitMark(p2));

  const none = commit(state(p3), { local: record("f1", ["s2", "s1"], { note: "from 1.23.0" }) });
  expect(none.record.blockeditor.rev).toBe("r3");
  expect(none.record.live).toEqual(p3.live);
  expect(none.record.data.note).toBe("from 1.23.0");
});

test("a moved record with no id never leaves an empty entry in an ancestry", () => {
  const old = { v: 1, savedAt: "2026-10-01T00:00:00.000Z", data: { ...SERVED, note: "from 1.22" } };
  const moved = commit({ meta: null, record: null, v1base: null }, { local: old });
  expect(moved.record).toEqual(old);
  expect(moved.meta.foreign).toBe(foreignMark(old));
  const op = { tab: "t", reset: "", acked: 0, ops: [{ seq: 1, savedAt: "s", keys: { title: { b: "owner title", m: "typed" } } }] };
  const next = commit({ meta: moved.meta, record: moved.record, v1base: moved.v1base }, { local: old, chains: [op] });
  expect(next.record.ancestry).toEqual(["root:"]);
  expect(next.record.data).toMatchObject({ note: "from 1.22", title: "typed" });
});

// Tabs on the real session from here on.

const notices = () => [...(document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')?.shadowRoot?.querySelectorAll("[data-clay-toast]") ?? [])].map((el) => el.textContent).filter((text) => text.includes("kept aside"));
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("the move: a released ClayJS's record becomes the first record once, and the cache is written with its mark", async () => {
  const w = world();
  const old = record("v1a", ["root:"], { note: "from 1.24.0" });
  localStorage.setItem(w.key, JSON.stringify(old));
  const t = await openTab(w);
  const first = await stored(w);
  expect(first.record).toEqual(old);
  expect(w.parsed()).toEqual({ ...old, w: { rev: first.meta.rev, reset: "" } });
  const u = await openTab(w);
  expect((await stored(w)).meta.rev).toBe(first.meta.rev);
  expect(u.shows().note).toBe("from 1.24.0");
  expect(t.shows().note).toBe("from 1.24.0");
});

test("an old tab's save beside a new tab's save: both are kept, it is taken in once, and a late copy of it is ignored", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("first title");
  await t.save();
  const { next, text } = oldTabSave(w, { note: "old tab note" }, { announce: false });
  t.title("new tab title");
  await t.save();
  const after = await stored(w);
  expect([after.record.data.title, after.record.data.note]).toEqual(["new tab title", "old tab note"]);
  expect(after.meta.foreign).toBe(next.id);
  expect(w.parsed().w.rev).toBe(after.meta.rev);

  t.note("changed again in the new tab");
  await t.save();
  const settledRev = (await stored(w)).meta.rev;
  localStorage.setItem(w.key, text);
  await t.sync();
  const last = await stored(w);
  expect(last.record.data.note).toBe("changed again in the new tab");
  expect(last.meta.rev).toBe(settledRev);
  expect(w.parsed().w.rev).toBe(settledRev);
  expect([...last.all.keys()].filter((name) => name.includes(":recovery:"))).toEqual([]);
});

test("an old tab's save found after the record moved on merges from the cache copy it replaced", async () => {
  const w = world();
  const [t, u] = [await openTab(w), await openTab(w)];
  t.title("first title");
  await t.save();
  await u.sync();
  const behind = w.local();
  // Another tab commits; its cache write has not landed when the old tab saves.
  u.title("second title");
  u.capture();
  const getItem = Storage.prototype.getItem;
  let armed = true;
  Storage.prototype.getItem = function (name) {
    const value = getItem.call(this, name);
    if (armed && name === w.key + ":reset") {
      armed = false;
      queueMicrotask(() => oldTabSave(w, { note: "old tab note" }));
    }
    return value;
  };
  try { await u.sync(); } finally { Storage.prototype.getItem = getItem; }
  expect(JSON.parse(behind).data.title).toBe("first title");
  await settle();
  await t.sync();
  const { record: merged, all } = await stored(w);
  expect([merged.data.title, merged.data.note]).toEqual(["second title", "old tab note"]);
  expect([...all.keys()].filter((name) => name.includes(":recovery:"))).toEqual([]);
  expect(notices()).toEqual([]);
});

test("the cache is never written over an old tab's save that has not been taken in; the next transaction takes it", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("first title");
  await t.save();
  t.title("second title");
  t.capture();
  const getItem = Storage.prototype.getItem;
  let armed = true;
  let written = null;
  Storage.prototype.getItem = function (name) {
    const value = getItem.call(this, name);
    if (armed && name === w.key + ":reset") {
      armed = false;
      queueMicrotask(() => { written = oldTabSave(w, { note: "written between the transaction and the cache write" }, { announce: false }); });
    }
    return value;
  };
  try { await t.sync(); } finally { Storage.prototype.getItem = getItem; }
  expect(w.parsed().id).toBe(written.next.id);
  expect(w.parsed().w).toBe(undefined);
  await settle();
  const { record: merged, meta: after } = await stored(w);
  expect([merged.data.title, merged.data.note]).toEqual(["second title", "written between the transaction and the cache write"]);
  expect(w.parsed().w.rev).toBe(after.rev);
});

test("an old tab that began from the served page cannot change the draft: its page is kept aside whole, and the visitor is told once", async () => {
  const w = world();
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const t = await openTab(w);
    t.title("draft title");
    t.note(big("n"));
    t.addRow("r2", "draft two");
    t.addRow("r3", "draft three");
    await t.save();
    expect(w.parsed()).toMatchObject({ v: 2, idb: true });
    const before = await stored(w);

    const first = oldTabPage(w, { ...SERVED, rows: [SERVED.rows[0], { id: "r9", name: "old tab row" }] });
    await settle();
    const after = await stored(w);
    expect(after.record).toEqual(before.record);
    expect(JSON.parse(after.all.get(recoveryKey(w.key, first.next.id)))).toEqual(first.next);
    expect(after.meta.rev).toBe(before.meta.rev);
    expect(w.parsed()).toMatchObject({ v: 2, idb: true, id: before.record.id });
    expect(t.shows().rows.map((row) => row.id)).toEqual(["r1", "r2", "r3"]);
    expect(notices().length).toBe(1);
    expect(warn.mock.calls.filter(([text]) => String(text).includes("could not be merged exactly")).length).toBe(1);

    // The same old tab saves its whole page again: a second copy, the same notice.
    const second = oldTabPage(w, { ...SERVED, note: "old tab note", rows: [SERVED.rows[0], { id: "r9", name: "old tab row" }, { id: "r10", name: "second old row" }] });
    await settle();
    const last = await stored(w);
    expect(last.record).toEqual(before.record);
    expect([...last.all.keys()].filter((name) => name.includes(":recovery:")).sort()).toEqual([recoveryKey(w.key, first.next.id), recoveryKey(w.key, second.next.id)].sort());
    expect(notices().length).toBe(1);
    expect(warn.mock.calls.filter(([text]) => String(text).includes("could not be merged exactly")).length).toBe(2);
  } finally {
    warn.mockRestore();
  }
});

test("an old tab's record that names the record this side stores never becomes a recovery copy, with or without a storage event", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("first title");
  await t.save();
  oldTabSave(w, { note: "one" });
  await settle();
  oldTabSave(w, { note: "two" }, { announce: false });
  await t.sync();
  const { record: merged, all, v1base } = await stored(w);
  expect([merged.data.title, merged.data.note]).toEqual(["first title", "two"]);
  expect(v1base.data.note).toBe("two");
  expect([...all.keys()].filter((name) => name.includes(":recovery:"))).toEqual([]);
  expect(t.shows().note).toBe("two");
  expect(notices()).toEqual([]);
});

test("after Start over, a dirty old tab's page comes back as the new draft, as it does between two tabs of that ClayJS", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("draft");
  await t.save();
  await t.session.startOver();
  expect((await stored(w)).record).toBe(null);
  const page = oldTabPage(w, { ...SERVED, title: "draft", note: "typed in the old tab" });
  const next = await openTab(w);
  const { record: taken, all } = await stored(w);
  expect(taken).toEqual(page.next);
  expect([...all.keys()].filter((name) => name.includes(":recovery:"))).toEqual([]);
  expect(next.shows().note).toBe("typed in the old tab");
  expect(oldTabWrite).toBeDefined();
});

// Runs `during` right after the next transaction of this draft has read `localStorage`:
// what it writes is not in that transaction, and is there before its cache write.
async function whileCommitting(w, run, during) {
  const getItem = Storage.prototype.getItem;
  let armed = true;
  Storage.prototype.getItem = function (name) {
    const value = getItem.call(this, name);
    if (armed && name === w.key + ":reset") {
      armed = false;
      queueMicrotask(during);
    }
    return value;
  };
  try { await run(); } finally { Storage.prototype.getItem = getItem; }
  expect(armed).toBe(false);
}

test("with no storage event, the tab whose transaction read the cache merges an old tab's save from it", async () => {
  const w = world();
  const [t, u] = [await openTab(w), await openTab(w)];
  t.title("first title");
  await t.save();
  u.note("u note");
  u.capture();
  await whileCommitting(w, () => u.sync(), () => oldTabSave(w, { title: "old tab title" }, { announce: false }));
  await settle();
  const { record: merged, all } = await stored(w);
  expect(merged.data).toMatchObject({ title: "old tab title", note: "u note" });
  expect([...all.keys()].filter((name) => name.includes(":recovery:"))).toEqual([]);
  expect(t.session).not.toBe(null);
});

test("with no storage event, the tab that wrote the cache merges an old tab's save from it", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("first title");
  await t.save();
  const u = await openTab(w);
  u.note("u note");
  u.capture();
  await whileCommitting(w, () => u.sync(), () => oldTabSave(w, { title: "old tab title" }, { announce: false }));
  // This tab's transaction is queued before the other tab's second one.
  await t.sync();
  const { record: merged, meta: after, all } = await stored(w);
  expect(after.foreign).toMatch(/^old/);
  expect(merged.data).toMatchObject({ title: "old tab title", note: "u note" });
  expect([...all.keys()].filter((name) => name.includes(":recovery:"))).toEqual([]);
  await settle();
});

test("a save from a tab on ClayJS 1.22.0 (no id) merges from the copy a storage event says it replaced, and is kept aside without one", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("first title");
  await t.save();
  const idless = (change, at) => ({ v: 1, savedAt: at, data: { ...w.parsed().data, ...change } });
  oldTabWrite(w, idless({ note: "from 1.22, announced" }, "2026-11-12T13:00:00.000Z"));
  await settle();
  const first = await stored(w);
  expect(first.record.data).toMatchObject({ title: "first title", note: "from 1.22, announced" });
  expect([...first.all.keys()].filter((name) => name.includes(":recovery:"))).toEqual([]);
  expect(t.shows().note).toBe("from 1.22, announced");

  const silent = oldTabWrite(w, idless({ note: "from 1.22, silent" }, "2026-11-12T13:05:00.000Z"), { announce: false });
  await t.sync();
  const second = await stored(w);
  expect(second.record).toEqual(first.record);
  expect(JSON.parse(second.all.get(recoveryKey(w.key, foreignMark(silent.next))))).toEqual(silent.next);
});

test("in the database, a later copy of a kept line takes the place of the copy it descends from", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("draft");
  await t.save();
  const F1 = record("page1", ["root:"], { note: "one" });
  const F2 = record("page2", ["page1", "root:"], { note: "two" });
  await transactOnce(w, { local: F1 });
  expect([...(await stored(w)).all.keys()].filter((name) => name.includes(":recovery:"))).toEqual([recoveryKey(w.key, "page1")]);
  await transactOnce(w, { local: F2 });
  const { all, record: kept } = await stored(w);
  expect([...all.keys()].filter((name) => name.includes(":recovery:"))).toEqual([recoveryKey(w.key, "page2")]);
  expect(kept.data.title).toBe("draft");
});
