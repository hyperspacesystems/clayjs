import { beforeEach, expect, jest, test } from "@jest/globals";
import { SERVED, failing, oldTabPage, oldTabSave, openTab, stored, transactOnce, world } from "./helpers/visitor-drafts-session.js";
import { seedIdb } from "./helpers/visitor-drafts-idb.js";

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); delete window.clay; document.querySelectorAll("clay-editor-ui").forEach((el) => el.remove()); });

const recovered = (w, state, copy) => JSON.parse(state.all.get(`${w.key}:recovery:${copy.id}`));
const refuseMarker = (w) => {
  const original = Storage.prototype.setItem;
  return jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (name, value) {
    if (name === w.key + ":reset") throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    return original.call(this, name, value);
  });
};
const oldReset = (w) => {
  localStorage.removeItem(w.key);
  localStorage.setItem(w.key + ":reset", "legacy-marker");
};

test("an old tab's Start over with no observer starts empty and keeps the exact discarded record", async () => {
  const w = world();
  const current = await openTab(w, { article: true });
  current.title("discard this draft");
  current.writePage("draft", { text: "whole page to keep" });
  await current.save();
  const before = await stored(w);
  oldReset(w);
  const next = await openTab(w, { article: true });
  const after = await stored(w);
  expect(after.record).toBe(null);
  expect(after.meta).toMatchObject({ gen: 2, reset: "legacy-marker", recovery: [before.record.id] });
  expect(recovered(w, after, before.record)).toEqual(before.record);
  expect(next.shows()).toEqual(SERVED);
  await next.sync();
  expect(await stored(w)).toEqual(after);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')).toBe(null);
  await current.sync();
  await openTab(w);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const root = document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')?.shadowRoot;
  expect([...root.querySelectorAll("[data-clay-toast]")].map((el) => el.textContent)).toEqual(["This draft was started over in another tab. The earlier draft was kept aside in this browser."]);
});

test("a fresh page with an empty key and a bare marker can save its first typing", async () => {
  const w = world();
  localStorage.setItem(w.key + ":reset", "legacy-marker");
  const fresh = await openTab(w);
  expect((await stored(w)).record).toBe(null);
  fresh.title("first typing on the fresh page");
  await fresh.save();
  expect((await stored(w)).record.data.title).toBe("first typing on the fresh page");
  expect(fresh.reloaded).toBe(0);
});

test("a known ended marker is corrected without ending the newer generation", async () => {
  const w = world();
  localStorage.setItem(w.key + ":reset", "legacy-marker");
  const { next: foreign } = oldTabPage(w, { ...SERVED, title: "foreign work" }, { announce: false });
  await seedIdb(w.factory, w.key, { record: foreign, meta: { gen: 8, reset: "legacy-marker", foreign: foreign.id } });
  const state = failing(w);
  state.fail = true;
  const stale = await openTab(w);
  const newer = await transactOnce(w, {
    resets: [{ ends: 8, marker: "9~other" }],
    chains: [{ tab: "other", reset: "9~other", ops: [{ seq: 1, keys: { title: { b: SERVED.title, m: "newer work" } } }] }],
  });
  state.fail = false;
  const writes = refuseMarker(w);
  try { await stale.session.startOver(); }
  finally { writes.mockRestore(); }
  expect((await stored(w)).record).toEqual(newer.record);
  await openTab(w);
  const after = await stored(w);
  expect(after.meta).toMatchObject({ gen: 9, reset: "9~other" });
  expect(after.record).toEqual(newer.record);
  expect(w.parsed().data).toEqual(newer.record.data);
});

test.each([false, true])("released work is active after its reset and recovered before a numbered reset (bare marker: %s)", async (bare) => {
  const w = world();
  const current = await openTab(w);
  current.title("stored draft");
  await current.save();
  const before = await stored(w);
  let foreign;
  if (bare) {
    oldReset(w);
    ({ next: foreign } = oldTabPage(w, { ...SERVED, note: "old tab saved after reset" }, { announce: false }));
    await current.sync();
  } else {
    ({ next: foreign } = oldTabSave(w, { note: "old tab saved before reset" }, { announce: false }));
    await current.session.startOver();
  }
  const after = await stored(w);
  expect(after.meta.gen).toBe(2);
  expect(after.record).toEqual(bare ? foreign : null);
  if (bare) expect(after.all.has(w.key + ":recovery:" + foreign.id)).toBe(false);
  else expect(recovered(w, after, foreign)).toEqual(foreign);
  if (bare) expect(recovered(w, after, before.record)).toEqual(before.record);
  if (bare) expect(w.parsed().data).toEqual(foreign.data);
  else expect(w.local()).toBe(null);
  expect(sessionStorage.getItem(w.key + ":recovery-notice") !== null).toBe(bare);
  const next = await openTab(w);
  expect(sessionStorage.getItem(w.key + ":recovery-notice")).toBe(null);
  expect(next.shows()).toEqual(bare ? foreign.data : SERVED);
  expect((await stored(w)).record).toEqual(bare ? foreign : null);
});

test("Opus 5: first typing survives after a refused numbered marker and a reload onto its bare predecessor", async () => {
  const w = world();
  const first = await openTab(w);
  first.title("generation one");
  await first.save();
  oldReset(w);
  await first.sync();
  const second = await openTab(w);
  second.title("generation two");
  await second.save();
  const writes = refuseMarker(w);
  try {
    await second.session.startOver();
    expect((await stored(w)).meta.gen).toBe(3);
    const fresh = await openTab(w);
    expect(fresh.shows()).toEqual(SERVED);
    fresh.title("first typing after reload");
    await fresh.save();
    const after = await stored(w);
    expect(after.record.data.title).toBe("first typing after reload");
    expect(after.meta.gen).toBe(3);
    expect(fresh.reloaded).toBe(0);
  } finally { writes.mockRestore(); }
});

test("a refused reset transaction leaves a pending foreign save for the next page to park", async () => {
  const w = world();
  const state = failing(w);
  const current = await openTab(w);
  current.title("stored draft");
  await current.save();
  const { next: foreign, text } = oldTabSave(w, { note: "pending foreign work" }, { announce: false });
  state.fail = true;
  await current.session.startOver();
  expect(w.local(":reset")).toMatch(/^2~/);
  expect(w.local()).toBe(text);
  expect((await stored(w)).record.data.title).toBe("stored draft");
  state.fail = false;
  const next = await openTab(w, { restore: false });
  const after = await stored(w);
  next.store.restore(after.record && { raw: JSON.stringify(after.record), record: after.record });
  expect(after.record).toBe(null);
  expect(recovered(w, after, foreign)).toEqual(foreign);
  expect(w.local()).toBe(null);
  expect(next.shows()).toEqual(SERVED);
});

test("Opus 6: Start over frees the old cache before attempting its marker, even if every marker write fails", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("old cache");
  await t.save();
  const original = Storage.prototype.setItem;
  const cacheAtMarker = [];
  const writes = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (name, value) {
    if (name === w.key + ":reset") {
      cacheAtMarker.push(w.local());
      throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    }
    return original.call(this, name, value);
  });
  try { await t.session.startOver(); } finally { writes.mockRestore(); }
  expect(cacheAtMarker.length).toBeGreaterThan(0);
  expect(cacheAtMarker.every((value) => value === null)).toBe(true);
  expect(w.local()).toBe(null);
  expect((await stored(w)).record).toBe(null);
  const next = await openTab(w);
  expect(next.shows()).toEqual(SERVED);
  expect(next.reloaded).toBe(0);
});
