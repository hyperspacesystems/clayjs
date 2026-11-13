import { afterEach, beforeEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { createStore } from "../../src/plugins/visitor-drafts/store.js";
import { A, bootPage, cacheOf, keyFor, noDatabase, readIdb, seedIdb, useFactory, RULES, SEED, SERVED, row } from "./helpers/visitor-drafts-idb.js";

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); delete window.clay; });
afterEach(noDatabase);

function fallback(slot) {
  const doc = document.implementation.createHTMLDocument("notes");
  doc.documentElement.setAttribute("visitor-drafts", slot);
  doc.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="1">${RULES}</script>`;
  doc.body.innerHTML = `<h1 id="title">owner title</h1><input id="note" persist value="owner note"><ul id="rows">${SEED}${row("r1", "First")}</ul>`;
  const store = createStore({ doc, storage: localStorage, path: "/notes.html" });
  store.restore();
  return { doc, store };
}

test.each([31, 32, 33, 40])("the loader imports %s real fallback saves after a numbered Start over", async (saves) => {
  const factory = new IDBFactory();
  const slot = "r10-numbered-" + saves;
  const key = keyFor(slot);
  await seedIdb(factory, key, { record: A, meta: { gen: 1, reset: "", rev: 1 } });
  localStorage.setItem(key, cacheOf(A));
  noDatabase();
  const before = fallback(slot);
  expect(before.doc.getElementById("note").value).toBe(A.data.note);
  before.store.clear();
  const marker = localStorage.getItem(key + ":reset");
  expect(marker).toMatch(/^2~/);
  const fresh = fallback(slot);
  for (let i = 1; i <= saves; i++) {
    fresh.doc.getElementById("note").value = "fresh work " + i;
    fresh.doc.getElementById("note").setAttribute("value", "fresh work " + i);
    fresh.store.write(fresh.doc.documentElement.outerHTML);
  }
  const local = JSON.parse(localStorage.getItem(key));
  expect(local.reset).toBe(marker);
  expect(local.w).toBeUndefined();
  expect(local.ancestry.includes("root:" + marker)).toBe(saves <= 32);
  useFactory(factory);
  await bootPage({ slot, keep: true });
  const after = await readIdb(factory, key);
  expect(after.record).toEqual(local);
  expect(document.getElementById("note").value).toBe("fresh work " + saves);
  expect([...after.all.keys()].filter((name) => name.includes(":recovery:"))).toEqual([]);
});

test.each([32, 33])("the loader preserves an exact tokenless numbered record whose root expired after %s saves", async (saves) => {
  const factory = new IDBFactory();
  const slot = "r10-tokenless-" + saves;
  const key = keyFor(slot);
  await seedIdb(factory, key, { record: A, meta: { gen: 1, reset: "", rev: 1 } });
  localStorage.setItem(key + ":reset", "2~direct");
  let local = { v: 1, id: "fresh0", savedAt: "2026-11-12T10:00:00.000Z", ancestry: ["root:2~direct"], data: { ...SERVED, note: "fresh0" } };
  for (let i = 1; i <= saves; i++) local = { ...local, id: "fresh" + i, ancestry: [local.id, ...local.ancestry].slice(0, 32), data: { ...local.data, note: "fresh work " + i } };
  localStorage.setItem(key, JSON.stringify(local));
  useFactory(factory);
  await bootPage({ slot, keep: true });
  const after = await readIdb(factory, key);
  expect(after.record).toBe(null);
  expect(JSON.parse(after.all.get(key + ":recovery:" + local.id))).toEqual(local);
  expect(document.getElementById("note").value).toBe(SERVED.note);
});
