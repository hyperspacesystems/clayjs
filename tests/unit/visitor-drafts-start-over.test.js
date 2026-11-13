/**
 * Step 3 of the one-transaction drafts (05b): Start over ends one generation, in the
 * database, and only the one the page shows; another tab on that generation drops what it
 * had not saved and loads again; a closed tab's journal is applied by the next tab, once,
 * unless its generation ended; and every replaced copy is kept under its own id.
 */
import { beforeEach, expect, jest, test } from "@jest/globals";
import { recoveryMark } from "../../src/plugins/visitor-drafts/commit.js";
import { SERVED, failing, openTab, stored, transactOnce, world } from "./helpers/visitor-drafts-session.js";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

const marker = (w) => localStorage.getItem(w.key + ":reset");
const noticeFlag = (w) => sessionStorage.getItem(w.key + ":started-over");
const notices = () => [...(document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')?.shadowRoot?.querySelectorAll("[data-clay-toast]") ?? [])].map((el) => el.textContent);
const TOLD = "This draft was started over in another tab.";

test("Start over ends the generation in the database: the record, the cache and the journal are gone, and the marker names the next generation", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("draft");
  await t.save();
  t.note("typed and journaled, never sent");
  t.capture();
  expect(w.slots().length).toBe(1);

  await t.session.startOver();
  const { record, meta } = await stored(w);
  expect(record).toBe(null);
  expect(meta.gen).toBe(2);
  expect(marker(w)).toMatch(/^2~[a-z0-9]+$/);
  expect(meta.reset).toBe(marker(w));
  expect(meta.tabs).toEqual({});
  expect(w.local()).toBe(null);
  expect(w.slots()).toEqual([]);
  expect(t.reloaded).toBe(0);
  expect(noticeFlag(w)).toBe(null);
  expect(notices()).toEqual([]);
  t.title("typed while the page loads again");
  expect(t.capture()).toBe(null);
});

test("Start over reaches another tab: it recovers its unsaved typing, clears its journal, and says why once after reload", async () => {
  const w = world();
  const [a, b] = [await openTab(w), await openTab(w)];
  a.title("draft");
  await a.save();
  await b.sync();
  expect(b.shows().title).toBe("draft");
  b.note("typed in the other tab");
  b.capture();
  const chain = structuredClone(b.store.chain());
  expect(w.slots()).toEqual([b.store.slotKey]);

  await a.session.startOver();
  await b.sync();
  expect(b.reloaded).toBe(1);
  expect(w.slots()).toEqual([]);
  expect(noticeFlag(w)).toBe("1");
  const after = await stored(w);
  expect(after.record).toBe(null);
  expect(JSON.parse(after.all.get(w.key + ":recovery:" + recoveryMark(chain)))).toEqual(chain);
  b.note("typed in the dead page");
  expect(b.capture()).toBe(null);
  await b.sync();
  expect(b.reloaded).toBe(1);

  const reloaded = await openTab(w);
  expect(noticeFlag(w)).toBe(null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(notices()).toEqual(["This draft was started over in another tab. The earlier draft was kept aside in this browser."]);
  expect(reloaded.shows()).toEqual(SERVED);
  expect(reloaded.reloaded).toBe(0);

  // The tab that started over, and a page load that follows no reload, say nothing.
  await openTab(w);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(notices().filter((text) => text.includes(TOLD)).length).toBe(1);
});

test("a stale tab's Start over keeps the work saved after the Start over it missed", async () => {
  const w = world();
  const [a, stale] = [await openTab(w), await openTab(w)];
  a.title("old draft");
  await a.save();
  await stale.sync();
  await a.session.startOver();
  const fresh = await openTab(w);
  fresh.title("newer work");
  await fresh.save();
  const newer = marker(w);

  await stale.session.startOver();
  const { record, meta } = await stored(w);
  expect(record.data.title).toBe("newer work");
  expect(meta.gen).toBe(2);
  expect(marker(w)).toBe(newer);
  expect(w.parsed().data.title).toBe("newer work");
});

test("Start over names the generation it ends: one that has already ended is not ended again, and the marker is put back", async () => {
  const w = world();
  const stale = await openTab(w);
  stale.title("old draft");
  await stale.save();
  // The generation ended and newer work was saved, and this browser's marker does not say so.
  await transactOnce(w, { resets: [{ ends: 1, marker: "2~a" }] });
  await transactOnce(w, { chains: [{ tab: "new", reset: "2~a", ops: [{ seq: 1, savedAt: "s", keys: { title: { b: "owner title", m: "newer work" } } }] }] });
  expect(marker(w)).toBe(null);

  await stale.session.startOver();
  const { record, meta } = await stored(w);
  expect(record.data.title).toBe("newer work");
  expect([meta.gen, meta.reset]).toEqual([2, "2~a"]);
  expect(marker(w)).toBe("2~a");
  expect(w.parsed().data.title).toBe("newer work");
});

// A draft saved under a marker ClayJS 1.23.0 wrote: generation 2, and the marker has no number.
async function underOldMarker(w) {
  const first = await openTab(w);
  first.title("draft");
  await first.save();
  localStorage.setItem(w.key + ":reset", "abcdef123456");
  await first.sync();
  const second = await openTab(w);
  second.title("draft under a 1.23.0 marker");
  await second.save();
  expect((await stored(w)).meta).toMatchObject({ gen: 2, reset: "abcdef123456" });
  return second;
}

test("a page on a 1.23.0 marker that has learned its generation's number ends exactly that generation", async () => {
  const w = world();
  const t = await underOldMarker(w);
  await t.session.startOver();
  const { record, meta } = await stored(w);
  expect(record).toBe(null);
  expect(meta.gen).toBe(3);
  expect(marker(w)).toMatch(/^3~[a-z0-9]+$/);
  expect(meta.reset).toBe(marker(w));
});

test("Start over refuses an unreadable generation and preserves the record and cache", async () => {
  const w = world();
  await underOldMarker(w);
  const state = failing(w);
  state.fail = true;
  const t = await openTab(w);
  expect(t.shows().title).toBe("draft under a 1.23.0 marker");
  const before = await stored(w);
  const cache = w.local();
  await expect(t.session.startOver()).rejects.toMatchObject({ code: "quota" });
  expect(await stored(w)).toEqual(before);
  expect(w.local()).toBe(cache);
  expect(marker(w)).toBe("abcdef123456");
  expect(t.reloaded).toBe(0);
});

test("a stale tab that never learned its generation's number keeps the newer work too", async () => {
  const w = world();
  await underOldMarker(w);
  const state = failing(w);
  state.fail = true;
  const stale = await openTab(w);
  state.fail = false;
  // Another tab started over since, and newer work was saved.
  localStorage.setItem(w.key + ":reset", "fedcba654321");
  const fresh = await openTab(w);
  fresh.title("newer work");
  await fresh.save();
  expect((await stored(w)).meta).toMatchObject({ gen: 3, reset: "fedcba654321" });

  await stale.session.startOver();
  const { record, meta } = await stored(w);
  expect(record.data.title).toBe("newer work");
  expect(meta.gen).toBe(3);
  expect(marker(w)).toBe("fedcba654321");
});

test("Start over while the database refuses to write: the marker and the missing cache carry it to the next page load", async () => {
  const w = world();
  const first = await openTab(w);
  first.title("draft");
  await first.save();
  const state = failing(w);
  const t = await openTab(w);
  expect(t.shows().title).toBe("draft");
  t.note("journaled, never sent");
  t.capture();
  state.fail = true;

  await t.session.startOver();
  expect(marker(w)).toMatch(/^2~[a-z0-9]+$/);
  expect(w.local()).toBe(null);
  expect(w.slots()).toEqual([]);
  expect((await stored(w)).record.data.title).toBe("draft");

  state.fail = false;
  const next = await openTab(w);
  expect(next.shows()).toEqual(SERVED);
  const { record, meta } = await stored(w);
  expect(record).toBe(null);
  expect([meta.gen, meta.reset]).toEqual([2, marker(w)]);
});

test("Start over when the marker cannot be written: the transaction ends the generation and the marker is written after it", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("draft");
  await t.save();
  const setItem = Storage.prototype.setItem;
  let refused = 0;
  Storage.prototype.setItem = function (name, value) {
    if (name === w.key + ":reset" && refused++ === 0) throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    return setItem.call(this, name, value);
  };
  try { await t.session.startOver(); } finally { Storage.prototype.setItem = setItem; }
  expect(refused).toBe(2);
  const { record, meta } = await stored(w);
  expect(record).toBe(null);
  expect(meta.gen).toBe(2);
  expect(marker(w)).toBe(meta.reset);
  expect(t.reloaded).toBe(0);
});

test("Start over pressed after a transaction of this tab has read its input still ends the generation, marker or not", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("draft");
  await t.save();
  t.note("in flight");
  t.capture();
  const getItem = Storage.prototype.getItem;
  const setItem = Storage.prototype.setItem;
  let armed = true;
  let over = null;
  Storage.prototype.getItem = function (name) {
    if (armed && name === w.key + ":reset") {
      armed = false;
      queueMicrotask(() => { over = t.session.startOver(); });
    }
    return getItem.call(this, name);
  };
  Storage.prototype.setItem = function (name, value) {
    if (name === w.key + ":reset") throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    return setItem.call(this, name, value);
  };
  try {
    await t.sync();
    expect(armed).toBe(false);
    await over;
  } finally {
    Storage.prototype.getItem = getItem;
    Storage.prototype.setItem = setItem;
  }
  const { record, meta } = await stored(w);
  expect(record).toBe(null);
  expect(meta.gen).toBe(2);
});

test("Start over pressed while a save of this tab is in flight still ends the generation", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("draft");
  await t.save();
  t.note("in flight");
  const flying = t.save();
  const over = t.session.startOver();
  await Promise.all([flying, over]);
  const { record, meta } = await stored(w);
  expect(record).toBe(null);
  expect(meta.gen).toBe(2);
});

test("a closed tab's journal is applied by the next tab once; one from a generation that ended is never applied", async () => {
  const w = world();
  const closed = await openTab(w);
  closed.title("typed, then the tab closed");
  closed.capture();
  expect(w.slots().length).toBe(1);

  const next = await openTab(w);
  expect((await stored(w)).record.data.title).toBe("typed, then the tab closed");
  expect(next.shows().title).toBe("typed, then the tab closed");
  await next.sync();
  expect((await stored(w)).meta.rev).toBe(1);

  await next.session.startOver();
  localStorage.setItem(w.key + ":op:ghost", JSON.stringify({ tab: "ghost", reset: "", acked: 0, at: 0, ops: [{ seq: 1, savedAt: "s", keys: { title: { b: "owner title", m: "from before Start over" } } }] }));
  const after = await openTab(w);
  expect((await stored(w)).record).toBe(null);
  expect(after.shows()).toEqual(SERVED);
  expect(localStorage.getItem(w.key + ":op:ghost")).toBe(null);
});

test("two tabs change the same field: the later save wins, each replaced copy is kept under its own id, and the console says where", async () => {
  const w = world();
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const [a, b] = [await openTab(w), await openTab(w)];
    const warned = () => warn.mock.calls.filter(([text]) => String(text).includes("its copy was kept")).length;
    a.title("a's title");
    b.title("b's title");
    a.capture();
    b.capture();
    // One transaction carries both: b's journal slot first, then a's own operation.
    await a.sync();
    const { record, conflict: first, all } = await stored(w);
    expect(record.data.title).toBe("a's title");
    expect(first.data.title).toBe("b's title");
    expect(first.id).not.toBe(record.id);
    expect(JSON.parse(all.get(`${w.key}:conflict:${first.id}`))).toEqual(first);
    expect(warned()).toBe(1);
    await b.sync();
    expect(b.shows().title).toBe("a's title");
    expect(warned()).toBe(1);

    b.title("b's second title");
    b.capture();
    a.title("a's second title");
    await a.save();
    const { record: last, conflict: second, all: rows } = await stored(w);
    expect(last.data.title).toBe("a's second title");
    expect(second.data.title).toBe("b's second title");
    expect([...rows.keys()].filter((name) => name.includes(":conflict:")).sort()).toEqual([`${w.key}:conflict:${first.id}`, `${w.key}:conflict:${second.id}`].sort());
    expect(JSON.parse(rows.get(`${w.key}:conflict:${first.id}`)).data.title).toBe("b's title");
    expect(warned()).toBe(2);
  } finally {
    warn.mockRestore();
  }
});
