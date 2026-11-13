import { afterEach, beforeEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { A, bootPage, keyFor, noDatabase, pause, readIdb, seedIdb, slowFactory, type, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });
afterEach(noDatabase);

test.each(["legacy-marker", "2~current"])("typing before the database opens survives a reset (%s)", async (marker) => {
  const real = new IDBFactory();
  const slot = "r8-first-" + (marker.includes("~") ? "numbered" : "bare");
  const key = keyFor(slot);
  await seedIdb(real, key, { record: A });
  localStorage.setItem(key + ":reset", marker);
  const slow = slowFactory(real, 700);
  useFactory(slow.factory);
  const page = await bootPage({ slot, keep: true });
  expect(slow.state.opened).toBe(false);
  expect(document.getElementById("note").value).toBe("owner note");
  type("fresh typing after Start over");
  const location = window.location;
  let reloads = 0;
  Object.defineProperty(window, "location", { configurable: true, value: {
    href: location.href, pathname: location.pathname, search: location.search, hash: location.hash, origin: location.origin,
    reload() { reloads++; },
  } });
  try {
    const saving = page.clay.save();
    await pause(25);
    expect(page.slots()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(page.slots()[0])).reset).toBe(marker);
    expect(slow.state.opened).toBe(false);
    expect((await saving).ok).toBe(true);
    const after = await readIdb(real, key);
    expect(after.record.data.note).toBe("fresh typing after Start over");
    expect(after.meta.reset).toBe(marker);
    expect(page.slots()).toEqual([]);
    expect(reloads).toBe(0);
    expect(page.clay.hasUnsavedChanges()).toBe(false);
    if (marker === "legacy-marker") expect(JSON.parse(after.all.get(key + ":recovery:" + A.id))).toEqual(A);
  } finally { Object.defineProperty(window, "location", { configurable: true, value: location }); }
});

test("typing after an old reset and a failed database open is imported on the next visit", async () => {
  const real = new IDBFactory();
  const slot = "r8-failed-open-new-typing";
  const key = keyFor(slot);
  await seedIdb(real, key, { record: A });
  localStorage.setItem(key + ":reset", "legacy-marker");
  const broken = slowFactory(real, 10, { fail: true });
  useFactory(broken.factory);
  const page = await bootPage({ slot, keep: true });
  await waitFor(() => broken.state.opened, "failed open");
  await pause();
  type("new draft typed while the database was down");
  expect((await page.clay.save()).ok).toBe(true);
  const written = JSON.parse(page.local());
  expect(written.ancestry).toContain("root:legacy-marker");
  useFactory(real);
  await bootPage({ slot, keep: true });
  const after = await readIdb(real, key);
  expect(after.record).toEqual(written);
  expect(document.getElementById("note").value).toBe(written.data.note);
  expect(JSON.parse(after.all.get(key + ":recovery:" + A.id))).toEqual(A);
  expect(after.all.has(key + ":recovery:" + written.id)).toBe(false);
});
