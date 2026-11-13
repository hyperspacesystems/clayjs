import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { A, bootPage, cacheOf, keyFor, noDatabase, otherTab, pause, readIdb, seedIdb, slowFactory, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

function reloads() {
  const real = window.location;
  const calls = [];
  Object.defineProperty(window, "location", { configurable: true, value: {
    href: real.href, pathname: real.pathname, search: real.search, hash: real.hash, origin: real.origin,
    reload() { calls.push(true); },
  } });
  return { calls, restore: () => Object.defineProperty(window, "location", { value: real, configurable: true }) };
}

test("stale Start over before the database opens keeps the newer generation and cache", async () => {
  const real = new IDBFactory();
  const slot = "r5-stale-early-reset";
  const key = keyFor(slot);
  await seedIdb(real, key, { record: A, meta: { rev: 3 } });
  const { factory, state } = slowFactory(real, 400);
  useFactory(factory);
  const { clay } = await bootPage({ slot, localRaw: cacheOf(A, { rev: 3, reset: "" }) });
  expect(state.opened).toBe(false);
  localStorage.setItem(key + ":reset", "2~other");
  await otherTab(real, key, {
    tab: "new-tab", reset: "2~other", announce: false,
    resets: [{ ends: 1, marker: "2~other" }],
    ops: [{ seq: 1, keys: { note: { b: "owner note", m: "new work after reset" } } }],
  });
  expect(document.getElementById("note").value).toBe("note A");
  expect(state.opened).toBe(false);
  const page = reloads();
  try {
    expect(clay.visitorDrafts.reset()).toBe(true);
    await waitFor(() => page.calls.length > 0, "reset reload");
    await waitFor(() => state.opened, "database open");
    await pause();
    const after = await readIdb(real, key);
    expect(after.meta.gen).toBe(2);
    expect(after.record?.data.note).toBe("new work after reset");
    expect(JSON.parse(localStorage.getItem(key))?.data.note).toBe("new work after reset");
    expect(localStorage.getItem(key + ":reset")).toBe("2~other");
    expect(page.calls).toHaveLength(1);
  } finally { page.restore(); }
});

test("early Start over on a legacy marker learns the generation before publishing its numbered reset", async () => {
  const real = new IDBFactory();
  const slot = "r5-legacy-early-reset";
  const key = keyFor(slot);
  await seedIdb(real, key, { record: A, meta: { gen: 8, reset: "legacy-marker" } });
  localStorage.clear();
  localStorage.setItem(key, cacheOf(A, { rev: 1, reset: "legacy-marker" }));
  localStorage.setItem(key + ":reset", "legacy-marker");
  const { factory, state } = slowFactory(real, 200);
  useFactory(factory);
  const { clay } = await bootPage({ slot, keep: true });
  expect(state.opened).toBe(false);
  const page = reloads();
  try {
    clay.visitorDrafts.reset();
    await waitFor(() => page.calls.length === 1, "reset reload");
    const after = await readIdb(real, key);
    expect(after.meta.gen).toBe(9);
    expect(after.meta.reset).toMatch(/^9~/);
    expect(after.record).toBe(null);
    expect(localStorage.getItem(key + ":reset")).toBe(after.meta.reset);
  } finally { page.restore(); }
});
