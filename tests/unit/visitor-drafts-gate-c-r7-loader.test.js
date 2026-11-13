import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { A, bootPage, cacheOf, keyFor, noDatabase, pause, readIdb, seedIdb, slowFactory, type, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

test("a foreign record after a bare reset stays active while the earlier database record is recovered", async () => {
  const factory = new IDBFactory();
  const slot = "r7-foreign-boot";
  const key = keyFor(slot);
  const newer = { ...A, id: "newer", data: { ...A.data, note: "newer work" } };
  await seedIdb(factory, key, { record: newer, meta: { gen: 9, reset: "9~other" } });
  localStorage.clear();
  localStorage.setItem(key, JSON.stringify(A));
  localStorage.setItem(key + ":reset", "legacy-marker");
  useFactory(factory);
  const page = await bootPage({ slot, keep: true });
  expect(document.getElementById("title").textContent).toBe(A.data.title);
  expect(document.getElementById("note").value).toBe(A.data.note);
  const after = await readIdb(factory, key);
  expect(after.record).toEqual(A);
  expect(JSON.parse(after.all.get(key + ":recovery:" + newer.id))).toEqual(newer);
  expect(after.all.has(key + ":recovery:" + A.id)).toBe(false);
  type("new typing after the released save");
  expect((await page.clay.save()).ok).toBe(true);
  expect((await readIdb(factory, key)).record.data).toMatchObject({ title: A.data.title, note: "new typing after the released save" });
});

test.each([[1, ""], [4, "4~previous"]])("failed-open Start over numbers known generation %s and stays reset when the database opens", async (gen, marker) => {
  const factory = new IDBFactory();
  const slot = "r7-fallback-reopen-" + gen;
  const key = keyFor(slot);
  await seedIdb(factory, key, { record: A, meta: { gen, reset: marker } });
  localStorage.clear();
  localStorage.setItem(key, cacheOf(A, { rev: 1, reset: marker }));
  if (marker) localStorage.setItem(key + ":reset", marker);
  const broken = slowFactory(factory, 10, { fail: true });
  useFactory(broken.factory);
  const page = await bootPage({ slot, keep: true });
  await waitFor(() => broken.state.opened, "failed open");
  await pause();
  const location = window.location;
  let reloads = 0;
  Object.defineProperty(window, "location", { configurable: true, value: {
    href: location.href, pathname: location.pathname, search: location.search, hash: location.hash, origin: location.origin,
    reload() { reloads++; },
  } });
  try {
    page.clay.visitorDrafts.reset();
    await waitFor(() => reloads > 0, "fallback reset");
    expect(page.local(":reset")).toMatch(new RegExp(`^${gen + 1}~`));
    expect(page.local()).toBe(null);
  } finally { Object.defineProperty(window, "location", { configurable: true, value: location }); }
  useFactory(factory);
  await bootPage({ slot, keep: true });
  await waitFor(async () => (await readIdb(factory, key)).meta.gen === gen + 1, "reset commit");
  expect((await readIdb(factory, key)).record).toBe(null);
  expect(document.getElementById("note").value).toBe("owner note");
});
