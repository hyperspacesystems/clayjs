import { afterEach, expect, jest, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { A, bootPage, cacheOf, failingFactory, keyFor, noDatabase, otherTab, readIdb, seedIdb, type, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

test.each([true, false])("a stale reset keeps newer work, and typing after its reload is saved (current cache: %s)", async (currentCache) => {
  const real = new IDBFactory();
  const slot = "review-r5-refused-marker-save-" + currentCache;
  const key = keyFor(slot);
  await seedIdb(real, key, { record: A, meta: { gen: 8, reset: "legacy-marker" } });
  localStorage.clear();
  const raw = currentCache ? cacheOf(A, { rev: 1, reset: "legacy-marker" }) : JSON.stringify(A);
  localStorage.setItem(key, raw);
  localStorage.setItem(key + ":reset", "legacy-marker");
  const { factory, state } = failingFactory(real);
  state.fail = true;
  useFactory(factory);
  const page = await bootPage({ slot, keep: true });
  const { ready } = await import("../../src/plugins/visitor-drafts.js");
  await ready;
  const newer = await otherTab(real, key, {
    reset: "9~other", announce: false,
    resets: [{ ends: 8, marker: "9~other" }],
    ops: [{ seq: 1, keys: { note: { b: "owner note", m: "newer work from another tab" } } }],
  });
  if (!currentCache) localStorage.setItem(key, raw);
  expect(newer.meta.gen).toBe(9);
  expect(newer.record.data.note).toBe("newer work from another tab");
  state.fail = false;
  const original = Storage.prototype.setItem;
  const writes = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (name, value) {
    if (name === key + ":reset") throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    return original.call(this, name, value);
  });
  const location = window.location;
  let reloads = 0;
  Object.defineProperty(window, "location", { configurable: true, value: {
    href: location.href, pathname: location.pathname, search: location.search, hash: location.hash, origin: location.origin,
    reload() { reloads++; },
  } });
  try {
    page.clay.visitorDrafts.reset();
    await waitFor(() => reloads === 1, "stale page reload");
    expect((await readIdb(real, key)).record).toEqual(newer.record);
    expect(localStorage.getItem(key + ":reset")).toBe("legacy-marker");
  } finally {
    writes.mockRestore();
    Object.defineProperty(window, "location", { configurable: true, value: location });
  }
  const reloaded = await bootPage({ slot, keep: true });
  expect(document.getElementById("note").value).toBe("newer work from another tab");
  type("ordinary typing after stale reset");
  const saved = await reloaded.clay.save();
  const after = await readIdb(real, key);
  expect(saved.ok).toBe(true);
  expect(after.meta.gen).toBe(9);
  expect(after.record.data.note).toBe("ordinary typing after stale reset");
  expect(reloaded.slots()).toEqual([]);
});

test("after a refused Start over, a successful save must preserve subsequent typing", async () => {
  const real = new IDBFactory();
  const slot = "review-r5-refused-reset-save";
  const key = keyFor(slot);
  await seedIdb(real, key, { record: A, meta: { gen: 8, reset: "legacy-marker" } });
  localStorage.clear();
  localStorage.setItem(key, cacheOf(A, { rev: 1, reset: "legacy-marker" }));
  localStorage.setItem(key + ":reset", "legacy-marker");
  const { factory, state } = failingFactory(real);
  state.fail = true;
  useFactory(factory);
  const page = await bootPage({ slot, keep: true });
  const { ready } = await import("../../src/plugins/visitor-drafts.js");
  await ready;
  page.clay.visitorDrafts.reset();
  await waitFor(() => page.count("clay:drafts-store-failed") > 0, "Start over refusal");
  expect((await readIdb(real, key)).record).toEqual(A);
  state.fail = false;
  type("new typing after reset was refused");
  const saved = await page.clay.save();
  const after = await readIdb(real, key);
  expect(saved.ok).toBe(true);
  expect(after.record.data.note).toBe("new typing after reset was refused");
  expect(page.slots()).toEqual([]);
  type("large typing after refusal " + "R".repeat(600 * 1024));
  state.fail = true;
  expect(page.clay.visitorDrafts.saveNow()).toBe(false);
  await waitFor(() => page.count("clay:drafts-store-failed") > 1, "failed large save");
  expect((await readIdb(real, key)).record.data.note).toBe("new typing after reset was refused");
  state.fail = false;
  expect((await page.clay.save()).ok).toBe(true);
  expect((await readIdb(real, key)).record.data.note).toBe(document.getElementById("note").value);
});

test("a reset refused by both stores retains its queue and can save again", async () => {
  const real = new IDBFactory();
  const { factory, state } = failingFactory(real);
  useFactory(factory);
  const page = await bootPage({ slot: "r6-both-stores-refuse" });
  type("saved before reset");
  expect((await page.clay.save()).ok).toBe(true);
  const { ready } = await import("../../src/plugins/visitor-drafts.js");
  await ready;
  type("typing before refused reset");
  state.fail = true;
  expect(page.clay.visitorDrafts.saveNow()).toBe(true);
  await waitFor(() => page.count("clay:drafts-store-failed") > 0, "failed save");
  const before = await readIdb(real, page.key);
  const cache = page.local();
  const journal = localStorage.getItem(page.slots()[0]);
  const failures = page.count("clay:drafts-store-failed");
  const original = Storage.prototype.setItem;
  const writes = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (name, value) {
    if (name === page.key + ":reset") throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    return original.call(this, name, value);
  });
  try {
    page.clay.visitorDrafts.reset();
    await waitFor(() => page.count("clay:drafts-store-failed") > failures, "reset refusal");
    expect(await readIdb(real, page.key)).toEqual(before);
    expect(page.local()).toBe(cache);
    expect(page.local(":reset")).toBe(null);
    expect(localStorage.getItem(page.slots()[0])).toBe(journal);
  } finally { writes.mockRestore(); }
  state.fail = false;
  type("typing after both stores refused reset");
  expect((await page.clay.save()).ok).toBe(true);
  expect((await readIdb(real, page.key)).record.data.note).toBe("typing after both stores refused reset");
});

test("a new page holding a stale bare marker and a newer cache keeps the newer database record as recovery and starts empty", async () => {
  const factory = new IDBFactory();
  const slot = "r6-boot-stale-bare-marker";
  const key = keyFor(slot);
  const record = { ...A, id: "new-generation", data: { ...A.data, note: "newer work from another tab" } };
  await seedIdb(factory, key, { record, meta: { gen: 9, reset: "9~other" } });
  localStorage.clear();
  localStorage.setItem(key, cacheOf(record, { rev: 1, reset: "9~other" }));
  localStorage.setItem(key + ":reset", "legacy-marker");
  useFactory(factory);
  const page = await bootPage({ slot, keep: true });
  const after = await readIdb(factory, key);
  expect(after.meta.gen).toBe(10);
  expect(after.record).toBe(null);
  expect(JSON.parse(after.all.get(key + ":recovery:" + record.id))).toEqual(record);
  expect(document.getElementById("note").value).toBe("owner note");
  expect(page.local(":reset")).toBe("legacy-marker");
});
