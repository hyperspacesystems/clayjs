/**
 * Every Gate C finding of review rounds 1 to 4 (`gate-c-findings.md`, `astra-findings-r2.md`,
 * `gate-c-findings-r3.md`, `astra-findings-r4.md`, `opus-findings-r4.md`), as its story, on
 * the rebuilt drafts: real store, real session, one transaction per change. The findings
 * that are about the loader's own API are in `visitor-drafts-gate-c-loader.test.js`.
 */
import { beforeEach, expect, test } from "@jest/globals";
import { openSession } from "../../src/plugins/visitor-drafts/session.js";
import { SERVED, big, failing, oldTabPage, oldTabSave, openTab, stored, transactOnce, world } from "./helpers/visitor-drafts-session.js";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  for (const toast of document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')?.shadowRoot?.querySelectorAll("[data-clay-toast]") ?? []) toast.remove();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const recoveryRows = (all) => [...all.keys()].filter((name) => name.includes(":recovery:"));

// Runs `during` right after the next transaction of this draft has read `localStorage`.
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

test("round 1 finding 2: a save from a tab on a released ClayJS is not dropped, and the new tab's next save keeps it", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("new tab title");
  await t.save();
  oldTabSave(w, { note: "old tab note" });
  await settle();
  expect(t.shows().note).toBe("old tab note");
  t.title("new tab title, again");
  await t.save();
  const { record, conflict } = await stored(w);
  expect(record.data).toMatchObject({ title: "new tab title, again", note: "old tab note" });
  expect(conflict).toBe(null);
});

test.each([["the opening tab first", true], ["the saving tab first", false]])("round 1 finding 3, round 2 finding 2: a tab that opens beside an old tab's copy while another tab commits a large note keeps both (%s)", async (_, openFirst) => {
  const w = world();
  const t = await openTab(w);
  t.title("draft title");
  await t.save();
  oldTabSave(w, { title: "old tab title" }, { announce: false });
  const u = await openTab(w, { database: false });
  u.session = await openSession({ store: u.store, storage: localStorage, doc: u.doc, now: () => w.clock, reload: () => {} });
  await u.session.first;
  u.note(big("n"));
  u.capture();
  const steps = [() => openTab(w), () => u.sync()];
  await Promise.all((openFirst ? steps : steps.reverse()).map((step) => step()));
  await settle();
  const { record } = await stored(w);
  expect(record.data.note.length).toBe(big("n").length);
  expect(record.data.title).toBe("old tab title");
});

test("round 1 finding 5: the head of a page document never says it is the full draft", async () => {
  const w = world();
  const t = await openTab(w, { article: true });
  t.writePage("r1", { v: 1, y: big("y") });
  await t.save();
  const head = w.parsed();
  expect(head).toMatchObject({ v: 2, idb: true });
  expect("full" in head).toBe(false);
  expect((await stored(w)).record.blockeditor.rev).toBe("r1");
});

test("round 1 finding 6: an old tab's copy that still holds the values it opened with does not undo the new tab's edit", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("draft title");
  await t.save();
  t.title("new tab title");
  t.capture();
  // The old tab saves its note on the copy from before the new title.
  await whileCommitting(w, () => t.sync(), () => oldTabSave(w, { note: "old tab note" }));
  await settle();
  const { record, conflict, all } = await stored(w);
  expect(record.data).toMatchObject({ title: "new tab title", note: "old tab note" });
  expect(conflict).toBe(null);
  expect(recoveryRows(all)).toEqual([]);
  expect(t.shows()).toMatchObject({ title: "new tab title", note: "old tab note" });
});

test("round 1 finding 7: an old tab's Start over ends the draft however long its ancestry is, and a dirty new tab does not bring it back", async () => {
  const w = world();
  const t = await openTab(w);
  for (let n = 1; n <= 40; n++) {
    t.title("draft " + n);
    await t.save();
  }
  expect((await stored(w)).record.ancestry.length).toBe(32);
  t.note("typed in the new tab, not saved");
  // ClayJS 1.24.0's Start over: the record goes and a marker without a number is written.
  localStorage.removeItem(w.key);
  localStorage.setItem(w.key + ":reset", "abcdef123456");
  window.dispatchEvent(new StorageEvent("storage", { key: w.key + ":reset" }));
  await settle();
  expect(t.reloaded).toBe(1);
  const { record, meta } = await stored(w);
  expect(record).toBe(null);
  expect(meta).toMatchObject({ gen: 2, reset: "abcdef123456" });
  t.title("typed in the page that is loading again");
  t.capture();
  await t.sync();
  expect((await stored(w)).record).toBe(null);
  expect((await openTab(w)).shows()).toEqual(SERVED);
});

test("round 2 finding 1: a retry after a failed save never puts older text over newer", async () => {
  const w = world();
  const state = failing(w);
  const t = await openTab(w);
  t.note(big("a"));
  t.capture();
  state.fail = true;
  await expect(t.sync()).rejects.toThrow();
  // The visitor types on; the page-hide flush records the newer text; the database works again.
  t.note(big("b"));
  t.capture();
  state.fail = false;
  await t.sync();
  expect((await stored(w)).record.data.note[0]).toBe("b");
  const { rev } = (await stored(w)).meta;
  t.capture();
  await t.sync();
  const after = await stored(w);
  expect(after.record.data.note[0]).toBe("b");
  expect(after.meta.rev).toBe(rev);
  expect(t.store.pending()).toBe(0);
});

test("round 2 finding 3: an old tab that cannot read the head and edits the served page does not replace the saved title", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("my private title");
  t.note(big("n"));
  await t.save();
  expect(w.parsed().v).toBe(2);
  oldTabPage(w, { ...SERVED, note: "old tab note on the served page" });
  await settle();
  const { record, all } = await stored(w);
  expect(record.data.title).toBe("my private title");
  expect(record.data.note.length).toBe(big("n").length);
  expect(recoveryRows(all).length).toBe(1);
  expect(t.shows().title).toBe("my private title");
});

test("round 2 finding 5: a save from a tab that knows no pages (ClayJS 1.23.0) keeps the stored page", async () => {
  const w = world();
  const t = await openTab(w, { article: true });
  t.writePage("r1", { v: 1, y: "AAA" });
  await t.save();
  const held = w.parsed();
  expect(held.blockeditor.rev).toBe("r1");
  // 1.23.0 reads the data and writes a record without the page.
  const { live, blockeditor, w: mark, ...plain } = held;
  const next = { ...plain, savedAt: "2026-11-12T13:00:00.000Z", id: "old123000001", ancestry: [held.id, ...held.ancestry], data: { ...held.data, note: "from 1.23.0" } };
  localStorage.setItem(w.key, JSON.stringify(next));
  await t.sync();
  const { record } = await stored(w);
  expect(record.data.note).toBe("from 1.23.0");
  expect(record.blockeditor.rev).toBe("r1");
  expect(record.live.blockeditor).toEqual({ v: 1, y: "AAA" });
  expect(w.parsed().blockeditor.rev).toBe("r1");
  expect([live, blockeditor, mark].every(Boolean)).toBe(true);
});

test("round 2 finding 6: a marker older than the stored generation ends nothing and is put right", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("old draft");
  await t.save();
  await transactOnce(w, { resets: [{ ends: 1, marker: "2~b" }] });
  await transactOnce(w, { resets: [{ ends: 2, marker: "3~c" }], marker: "3~c" });
  await transactOnce(w, { marker: "3~c", chains: [{ tab: "new", reset: "3~c", ops: [{ seq: 1, savedAt: "s", keys: { title: { b: "owner title", m: "newest work" } } }] }] });
  localStorage.removeItem(w.key);
  localStorage.setItem(w.key + ":reset", "2~b");
  const late = await openTab(w);
  const { record, meta } = await stored(w);
  expect(record.data.title).toBe("newest work");
  expect([meta.gen, meta.reset]).toEqual([3, "3~c"]);
  expect(w.local(":reset")).toBe("3~c");
  expect(late.shows().title).toBe("newest work");
});

test("round 3 finding 1: a retry after another tab's save and its late notification keeps that tab's title", async () => {
  const w = world();
  const state = failing(w);
  const [t, u] = [await openTab(w), await openTab(w)];
  t.note("t note");
  t.capture();
  state.fail = true;
  await expect(t.sync()).rejects.toThrow();
  state.fail = false;
  u.title("u title");
  await u.save();
  window.dispatchEvent(new StorageEvent("storage", { key: w.key }));
  await settle();
  await t.sync();
  const { record, conflict } = await stored(w);
  expect(record.data).toMatchObject({ title: "u title", note: "t note" });
  expect(conflict).toBe(null);
  expect(t.shows()).toMatchObject({ title: "u title", note: "t note" });
});

test("round 3 finding 2: one id, one content, and the head carries the stored record's id", async () => {
  const w = world();
  const [t, u] = [await openTab(w), await openTab(w)];
  const seen = new Map();
  const check = async () => {
    const { record } = await stored(w);
    const content = JSON.stringify(record.data);
    expect(seen.get(record.id) ?? content).toBe(content);
    seen.set(record.id, content);
    expect(w.parsed()).toMatchObject({ v: 2, id: record.id });
  };
  t.note(big("a"));
  await t.save();
  await check();
  for (let n = 1; n <= 4; n++) {
    const tab = n % 2 ? u : t;
    await tab.sync();
    tab.title("title " + n);
    await tab.save();
    await check();
  }
  expect(seen.size).toBe(5);
});

test("round 3 finding 3, round 4 Astra 3 and Opus S1: a delayed Start over never removes work begun after it, 33 saves on", async () => {
  const w = world();
  const state = failing(w);
  const a = await openTab(w);
  a.title("old draft");
  await a.save();
  state.fail = true;
  await a.session.startOver();
  state.fail = false;
  const fresh = await openTab(w);
  expect((await stored(w)).meta.gen).toBe(2);
  fresh.note(big("n"));
  await fresh.save();
  for (let n = 1; n <= 33; n++) {
    fresh.title("fresh " + n);
    await fresh.save();
  }
  expect((await stored(w)).record.ancestry.some((id) => id.startsWith("root:"))).toBe(false);
  // The first tab's reset arrives now.
  await a.sync();
  await transactOnce(w, { resets: [{ ends: 1, marker: "2~late" }] });
  const { record, meta } = await stored(w);
  expect(record.data.title).toBe("fresh 33");
  expect(record.data.note.length).toBe(big("n").length);
  expect(meta.gen).toBe(2);
  expect((await openTab(w)).shows().title).toBe("fresh 33");
});

test("round 3 finding 4: an old tab's 33 saves after Start over stay active and the earlier draft is recovered", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("discarded title");
  t.addRow("r2", "discarded row");
  await t.save();
  const before = (await stored(w)).record;
  // The old tab starts over and goes on working alone; no new tab is open to see it.
  localStorage.removeItem(w.key);
  localStorage.setItem(w.key + ":reset", "abcdef123456");
  oldTabPage(w, { ...SERVED, note: "new work 0" }, { announce: false });
  for (let n = 1; n <= 33; n++) oldTabSave(w, { note: "new work " + n }, { announce: false });
  const last = w.parsed();
  expect(last.ancestry.some((id) => id.startsWith("root:"))).toBe(false);
  const next = await openTab(w, { restore: false });
  const { record, meta, all } = await stored(w);
  next.store.restore(record && { raw: JSON.stringify(record), record });
  expect(meta).toMatchObject({ gen: 2, reset: "abcdef123456" });
  expect(record).toEqual(last);
  expect(JSON.parse(all.get(`${w.key}:recovery:${before.id}`))).toEqual(before);
  expect(all.has(`${w.key}:recovery:${last.id}`)).toBe(false);
  expect(recoveryRows(all)).toHaveLength(1);
  expect(next.shows()).toEqual(last.data);
});

test.each(["lands", "fails", "is delivered by another tab"])("round 4 Astra 1: a change taken back while its save is in flight stays taken back when that save %s", async (outcome) => {
  const w = world();
  const state = failing(w);
  const t = await openTab(w);
  t.note("changed");
  t.capture();
  const revert = () => {
    t.note("owner note");
    t.capture();
    if (outcome === "fails") state.fail = true;
  };
  if (outcome === "fails") {
    // The first transaction aborts after the revert was journaled.
    state.fail = true;
    await expect(t.sync()).rejects.toThrow();
    revert();
    state.fail = false;
    await t.sync();
  } else {
    await whileCommitting(w, () => t.sync(), revert);
    expect((await stored(w)).record.data.note).toBe("changed");
    if (outcome === "lands") await t.sync();
    else await openTab(w);
  }
  const { record, meta } = await stored(w);
  expect(record.data.note).toBe("owner note");
  expect(meta.tabs[t.store.tab].seq).toBe(2);
});

test.each([["the journal first", true], ["the save first", false]])("round 4 Astra 2, Opus N1 and N2: an idle tab that catches up keeps the saved title and the journaled note (%s)", async (_, journalFirst) => {
  const w = world();
  const [a, b, idle] = [await openTab(w), await openTab(w), await openTab(w)];
  a.title("a title");
  b.note("b note");
  b.capture();
  if (journalFirst) {
    await idle.sync();
    await a.save();
  } else {
    await a.save();
    await idle.sync();
  }
  const { record, meta, conflict } = await stored(w);
  expect(record.data).toMatchObject({ title: "a title", note: "b note" });
  expect(meta.rev).toBe(2);
  expect(conflict).toBe(null);
  await idle.sync();
  expect(idle.shows()).toMatchObject({ title: "a title", note: "b note" });
});

test("round 4 Opus 1: two tabs save at the same moment while a third catches up, and every tab ends on both", async () => {
  const w = world();
  const [a, b, c] = [await openTab(w), await openTab(w), await openTab(w)];
  a.title("a title");
  b.note("b note");
  a.capture();
  b.capture();
  await Promise.all([c.sync(), a.sync(), b.sync()]);
  for (const tab of [a, b, c]) await tab.sync();
  const { record, meta, conflict } = await stored(w);
  expect(record.data).toMatchObject({ title: "a title", note: "b note" });
  expect(meta.rev).toBe(2);
  expect(conflict).toBe(null);
  for (const tab of [a, b, c]) expect(tab.shows()).toMatchObject({ title: "a title", note: "b note" });
});

test("round 4 Opus B1: a save made right after the page loads does not undo what a closed tab had journaled", async () => {
  const w = world();
  const closed = await openTab(w);
  closed.note("v1");
  await closed.save();
  closed.note("v2, typed last and only journaled");
  closed.capture();
  // The next page boots from the cache and saves before its first transaction.
  const next = await openTab(w, { database: false });
  expect(next.shows().note).toBe("v1");
  next.title("typed at once");
  next.capture();
  next.session = await openSession({ store: next.store, storage: localStorage, doc: next.doc, now: () => w.clock, reload: () => {} });
  await next.session.first;
  const { record, conflict } = await stored(w);
  expect(record.data).toMatchObject({ title: "typed at once", note: "v2, typed last and only journaled" });
  expect(conflict).toBe(null);
  expect(next.shows()).toMatchObject({ title: "typed at once", note: "v2, typed last and only journaled" });
});

test("round 4 Opus S2, David's choice 3: Start over in a tab on an old page keeps the fresh work saved since", async () => {
  const w = world();
  const [a, stale] = [await openTab(w), await openTab(w)];
  a.title("old draft");
  await a.save();
  await stale.sync();
  await a.session.startOver();
  const fresh = await openTab(w);
  fresh.title("fresh work");
  await fresh.save();
  await stale.session.startOver();
  expect((await stored(w)).record.data.title).toBe("fresh work");
  expect((await openTab(w)).shows().title).toBe("fresh work");
});
