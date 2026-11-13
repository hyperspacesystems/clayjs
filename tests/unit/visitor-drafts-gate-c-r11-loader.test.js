import { afterEach, beforeEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { createStore } from "../../src/plugins/visitor-drafts/store.js";
import { A, bootPage, cacheOf, keyFor, noDatabase, pause, readIdb, seedIdb, useFactory, RULES, SEED, row } from "./helpers/visitor-drafts-idb.js";

const KEPT_ASIDE = "A tab that was open before an update saved another copy of this draft. That copy was kept aside, and this draft was not changed. Reload that tab to go on from this draft.";
const notices = () => [...(document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')?.shadowRoot?.querySelectorAll("[data-clay-toast]") ?? [])].map((el) => el.textContent);

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); delete window.clay; });
afterEach(noDatabase);

test("the real loader preserves a fallback copy from an ended generation without displaying it", async () => {
  const factory = new IDBFactory();
  const slot = "r11-direct-old-token";
  const key = keyFor(slot);
  localStorage.setItem(key, cacheOf(A));
  noDatabase();
  const doc = document.implementation.createHTMLDocument("notes");
  doc.documentElement.setAttribute("visitor-drafts", slot);
  doc.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="1">${RULES}</script>`;
  doc.body.innerHTML = `<h1 id="title">owner title</h1><input id="note" persist value="owner note"><ul id="rows">${SEED}${row("r1", "First")}</ul>`;
  const offline = createStore({ doc, storage: localStorage, path: "/notes.html" });
  offline.restore();
  expect(doc.getElementById("title").textContent).toBe("title A");
  await seedIdb(factory, key, { meta: { gen: 2, rev: 3, reset: "2~started", ended: [""], tabs: {}, foreign: null, unit: null } });
  localStorage.removeItem(key);
  localStorage.setItem(key + ":reset", "2~started");
  doc.getElementById("note").value = "typed in D";
  doc.getElementById("note").setAttribute("value", "typed in D");
  offline.write(doc.documentElement.outerHTML);
  const local = JSON.parse(localStorage.getItem(key));
  expect(local.reset).toBe("");
  expect(local.data).toEqual({ ...A.data, note: "typed in D" });
  useFactory(factory);
  await bootPage({ slot, keep: true });
  await pause(60);
  const after = await readIdb(factory, key);
  expect(after.record).toBe(null);
  expect(after.v1base).toBe(null);
  expect(after.meta.foreign).toBe(local.id);
  expect(JSON.parse(after.all.get(key + ":recovery:" + local.id))).toEqual(local);
  expect(localStorage.getItem(key)).toBe(null);
  expect(document.getElementById("title").textContent).toBe("owner title");
  expect(document.getElementById("note").value).toBe("owner note");
  expect(notices()).toEqual([KEPT_ASIDE]);
});
