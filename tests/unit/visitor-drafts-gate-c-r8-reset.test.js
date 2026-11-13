import { beforeEach, expect, jest, test } from "@jest/globals";
import { openSession } from "../../src/plugins/visitor-drafts/session.js";
import { recoveryMark } from "../../src/plugins/visitor-drafts/commit.js";
import { SERVED, failing, openTab, stored, transactOnce, world } from "./helpers/visitor-drafts-session.js";
import { seedIdb, slowFactory } from "./helpers/visitor-drafts-idb.js";

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); delete window.clay; document.querySelectorAll("clay-editor-ui").forEach((el) => el.remove()); });

test.each([0, 100])("typing captured before opening the database survives an old reset (open delay %s)", async (delay) => {
  const w = world();
  const old = await openTab(w);
  old.title("discarded draft");
  await old.save();
  const before = await stored(w);
  localStorage.removeItem(w.key);
  localStorage.setItem(w.key + ":reset", "legacy-marker");
  const fresh = await openTab(w, { database: false });
  fresh.note("fresh typing before open");
  fresh.capture();
  expect(JSON.parse(localStorage.getItem(fresh.store.slotKey)).reset).toBe("legacy-marker");
  if (delay) globalThis.indexedDB = slowFactory(w.factory, delay).factory;
  fresh.session = await openSession({ store: fresh.store, storage: localStorage, doc: fresh.doc, reload: () => { fresh.reloaded++; } });
  await fresh.session.first;
  const after = await stored(w);
  expect(after.record.data.note).toBe("fresh typing before open");
  expect(JSON.parse(after.all.get(w.key + ":recovery:" + before.record.id))).toEqual(before.record);
  expect(fresh.reloaded).toBe(0);
  expect(fresh.store.pending()).toBe(0);
});

test.each(["local journal", "blind database row"])("a closed tab's %s stays in recovery after a refused numbered reset", async (carrier) => {
  const w = world();
  localStorage.setItem(w.key + ":reset", "legacy-marker");
  const current = await openTab(w);
  current.title("discarded saved draft");
  await current.save();
  const closed = await openTab(w);
  closed.note("discarded unsaved typing from the closed tab");
  closed.capture();
  const chain = structuredClone(closed.store.chain());
  const slot = closed.store.slotKey;
  if (carrier === "blind database row") {
    await seedIdb(w.factory, w.key, { rows: [[slot, JSON.stringify(chain)]] });
    localStorage.removeItem(slot);
  }
  const original = Storage.prototype.setItem;
  const writes = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (name, value) {
    if (name === w.key + ":reset") throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    return original.call(this, name, value);
  });
  try { await current.session.startOver(); } finally { writes.mockRestore(); }
  const reset = await stored(w);
  expect(reset.record).toBe(null);
  expect(reset.meta.ended).toContain("legacy-marker");
  expect(JSON.parse(reset.all.get(w.key + ":recovery:" + recoveryMark(chain)))).toEqual(chain);
  const next = await openTab(w);
  await next.sync();
  const after = await stored(w);
  expect(after.record).toBe(null);
  expect(after.meta.gen).toBe(reset.meta.gen);
  expect(w.local(":reset")).toBe(reset.meta.reset);
  expect(next.shows()).toEqual(SERVED);
  expect(JSON.parse(after.all.get(w.key + ":recovery:" + recoveryMark(chain)))).toEqual(chain);
});

test("Start over after an old reset and a refused first transaction does not restore the discarded draft", async () => {
  const w = world();
  const first = await openTab(w);
  first.title("draft discarded in the old tab");
  await first.save();
  localStorage.removeItem(w.key);
  localStorage.setItem(w.key + ":reset", "legacy-marker");
  const state = failing(w);
  state.fail = true;
  const next = await openTab(w);
  expect(next.shows()).toEqual(SERVED);
  state.fail = false;
  await next.session.startOver();
  const reloaded = await openTab(w);
  expect(reloaded.shows()).toEqual(SERVED);
  expect((await stored(w)).record).toBe(null);
});

test("a stale page's typing is recovered, and typing after it learns the current generation is active", async () => {
  const w = world();
  localStorage.setItem(w.key + ":reset", "legacy-marker");
  const first = await openTab(w);
  first.title("earlier draft");
  await first.save();
  const state = failing(w);
  state.fail = true;
  const stale = await openTab(w);
  const newer = await transactOnce(w, {
    resets: [{ ends: 1, marker: "2~other" }],
    chains: [{ tab: "other", reset: "2~other", ops: [{ seq: 1, keys: { title: { b: SERVED.title, m: "newer draft" } } }] }],
  });
  stale.note("typing before learning the generation ended");
  stale.capture();
  const chain = structuredClone(stale.store.chain());
  state.fail = false;
  await stale.sync();
  const after = await stored(w);
  expect(after.record).toEqual(newer.record);
  expect(JSON.parse(after.all.get(w.key + ":recovery:" + recoveryMark(chain)))).toEqual(chain);
  expect(stale.reloaded).toBe(1);
  const current = await openTab(w);
  expect(current.shows()).toEqual(newer.record.data);
  current.note("typing after learning the current generation");
  await current.save();
  const saved = await stored(w);
  expect(saved.record.data).toMatchObject({ title: "newer draft", note: "typing after learning the current generation" });
  expect(saved.meta.gen).toBe(2);
  expect(current.reloaded).toBe(0);
});

test("reset recovery is described once after reload and is not an unchanged-draft notice", async () => {
  const w = world();
  const current = await openTab(w);
  current.title("earlier draft");
  await current.save();
  localStorage.removeItem(w.key);
  localStorage.setItem(w.key + ":reset", "legacy-marker");
  await current.sync();
  expect(current.reloaded).toBe(1);
  expect(JSON.parse(sessionStorage.getItem(w.key + ":recovery-notice")).reset).toBe(true);
  const next = await openTab(w);
  await new Promise((resolve) => setTimeout(resolve, 40));
  const notices = () => [...(document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')?.shadowRoot.querySelectorAll("[data-clay-toast]") ?? [])].map((el) => el.textContent);
  expect(notices()).toEqual(["This draft was started over in another tab. The earlier draft was kept aside in this browser."]);
  await next.sync();
  expect(notices()).toHaveLength(1);
  document.querySelectorAll("clay-editor-ui").forEach((el) => el.remove());
  await openTab(w);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(notices()).toEqual([]);
});
