import { beforeEach, expect, jest, test } from "@jest/globals";
import { commit, recoveryMark, settled } from "../../src/plugins/visitor-drafts/commit.js";
import { openSession } from "../../src/plugins/visitor-drafts/session.js";
import { merge3, unitMark } from "../../src/plugins/visitor-drafts/store.js";
import { SERVED, oldTabPage, openTab, stored, transactOnce, world } from "./helpers/visitor-drafts-session.js";

const KEPT_ASIDE = "A tab that was open before an update saved another copy of this draft. That copy was kept aside, and this draft was not changed. Reload that tab to go on from this draft.";
const notices = () => [...(document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')?.shadowRoot?.querySelectorAll("[data-clay-toast]") ?? [])].map((el) => el.textContent);
const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
const recovery = (w, state) => [...state.all].filter(([name]) => name.startsWith(w.key + ":recovery:")).map(([, value]) => JSON.parse(value));
const memory = () => Object.fromEntries(Object.keys(sessionStorage).map((key) => [key, sessionStorage.getItem(key)]));
const restoreMemory = (values) => { sessionStorage.clear(); for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value); };

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); delete window.clay; document.querySelectorAll("clay-editor-ui").forEach((el) => el.remove()); });

test.each([[0, false], [11000, false], [11000, true]])("cleanup retains unread late operations (delay %s, extended recovered slot %s)", async (delay, extended) => {
  const w = world();
  const old = await openTab(w);
  if (extended) { old.title("earlier pending work"); old.capture(); }
  const newer = await transactOnce(w, { resets: [{ ends: 1, marker: "2~other" }] });
  localStorage.setItem(w.key + ":reset", "2~other");
  const observer = await openTab(w);
  if (extended) expect(recovery(w, await stored(w))[0].ops[0].keys.title.m).toBe("earlier pending work");
  const original = Storage.prototype.getItem;
  let captured;
  let injected = false;
  const reads = jest.spyOn(Storage.prototype, "getItem").mockImplementation(function (name) {
    if (!injected && name === w.key + ":reset") {
      injected = true;
      queueMicrotask(() => {
        old.note("late typing before closing the old tab");
        old.capture();
        captured = JSON.parse(localStorage.getItem(old.store.slotKey));
        expect(old.store.unsafe()).toBe(false);
        w.clock += delay;
      });
    }
    return original.call(this, name);
  });
  try { await observer.sync(); } finally { reads.mockRestore(); }
  expect(injected).toBe(true);
  expect(captured.ops.at(-1).keys.note.m).toBe("late typing before closing the old tab");
  expect((await stored(w)).record).toEqual(newer.record);
  expect(JSON.parse(localStorage.getItem(old.store.slotKey))).toEqual(captured);
  await observer.sync();
  expect(recovery(w, await stored(w))).toContainEqual(captured);
  w.clock += 11000;
  await observer.sync();
  expect(localStorage.getItem(old.store.slotKey)).toBe(null);
});

test("settled requires an acknowledgement or the exact recovery mark", () => {
  const chain = { tab: "old", reset: "1~old", acked: 0, ops: [{ seq: 1 }, { seq: 2 }] };
  const meta = { reset: "2~new", tabs: { old: { seq: 9 } }, recovery: ["op:old:1"] };
  expect(settled(chain, meta)).toBe(false);
  expect(settled(null, meta)).toBe(false);
  expect(settled(chain, { ...meta, recovery: [recoveryMark(chain)] })).toBe(true);
  expect(settled(chain, { ...meta, reset: chain.reset })).toBe(true);
  expect(settled({ ...chain, acked: 2 }, meta)).toBe(true);
});

test.each([false, true])("automatic reload remembers the found generation with refused marker writes (early typing %s)", async (early) => {
  const w = world();
  localStorage.setItem(w.key + ":reset", "1~start");
  const affected = await openTab(w);
  affected.title("prior draft");
  await affected.save();
  const affectedMemory = memory();
  sessionStorage.clear();
  const issuer = await openTab(w);
  const original = Storage.prototype.setItem;
  const writes = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (name, value) {
    if (name === w.key + ":reset") throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    return original.call(this, name, value);
  });
  try {
    await issuer.session.startOver();
    const reset = await stored(w);
    restoreMemory(affectedMemory);
    await affected.sync();
    expect(affected.reloaded).toBe(1);
    expect(JSON.parse(sessionStorage.getItem(w.key + ":generation"))).toEqual({ marker: "1~start", reset: reset.meta.reset });
    const fresh = await openTab(w, { database: false });
    if (early) { fresh.note("fresh typing after automatic reload"); fresh.capture(); }
    fresh.session = await openSession({ store: fresh.store, storage: localStorage, doc: fresh.doc, reload: () => { fresh.reloaded++; } });
    await fresh.session.first;
    if (!early) { fresh.note("fresh typing after automatic reload"); await fresh.save(); }
    const after = await stored(w);
    expect(after.record.data.note).toBe("fresh typing after automatic reload");
    expect(recovery(w, after)).toEqual([]);
    expect(fresh.reloaded).toBe(0);
  } finally { writes.mockRestore(); }
});

test("automatic reload does not associate a late marker with the completed generation", async () => {
  const w = world();
  const old = await openTab(w);
  old.title("prior draft");
  await old.save();
  await transactOnce(w, { resets: [{ ends: 1, marker: "2~other" }] });
  localStorage.setItem(w.key + ":reset", "2~other");
  const original = Storage.prototype.getItem;
  let injected = false;
  const reads = jest.spyOn(Storage.prototype, "getItem").mockImplementation(function (name) {
    if (!injected && name === w.key + ":reset") {
      injected = true;
      queueMicrotask(() => { localStorage.removeItem(w.key); localStorage.setItem(w.key + ":reset", "late-reset"); });
    }
    return original.call(this, name);
  });
  try { await old.sync(); } finally { reads.mockRestore(); }
  expect(injected).toBe(true);
  expect(old.reloaded).toBe(1);
  expect(JSON.parse(sessionStorage.getItem(w.key + ":generation"))).toEqual({ marker: "2~other", reset: "2~other" });
  const fresh = await openTab(w, { database: false });
  expect(fresh.store.generation()).toBe("late-reset");
  fresh.note("typing under the newer marker");
  fresh.capture();
  fresh.session = await openSession({ store: fresh.store, storage: localStorage, doc: fresh.doc, reload: () => { fresh.reloaded++; } });
  await fresh.session.first;
  expect((await stored(w)).record.data.note).toBe("typing under the newer marker");
  expect(fresh.reloaded).toBe(0);
});

test.each([false, true])("a released recovery has its own notice even with a lingering stale slot (%s)", async (ghost) => {
  const w = world();
  const tab = await openTab(w);
  tab.title("active draft");
  await tab.save();
  const before = await stored(w);
  if (ghost) {
    const chain = { tab: "ghost", reset: "ended", acked: 0, at: w.clock, ops: [{ seq: 1, keys: { note: { m: "old typing" } } }] };
    localStorage.setItem(w.key + ":op:ghost", JSON.stringify(chain));
    await tab.sync();
    expect(recovery(w, await stored(w))).toEqual([chain]);
    expect(localStorage.getItem(w.key + ":op:ghost")).not.toBe(null);
  }
  const { next } = oldTabPage(w, { ...SERVED, note: "released whole page" }, { announce: false });
  const result = await tab.sync();
  await pause();
  const after = await stored(w);
  expect(after.record).toEqual(before.record);
  expect(recovery(w, after)).toContainEqual(next);
  expect(result.released).toEqual([next]);
  expect(notices()).toEqual([KEPT_ASIDE]);
  expect((await tab.sync()).released).toEqual([]);
});

test.each([31, 32, 33, 40])("a current fallback record names its reset after %s saves", async (saves) => {
  const w = world();
  const tab = await openTab(w);
  tab.title("discarded draft");
  await tab.save();
  const offline = await openTab(w, { database: false });
  offline.store.clear();
  const marker = w.local(":reset");
  expect(marker).toMatch(/^2~/);
  expect(w.local()).toBe(null);
  const again = await openTab(w, { database: false });
  for (let n = 1; n <= saves; n++) { again.note("new generation save " + n); again.store.write(again.html()); }
  const local = w.parsed();
  expect(local.reset).toBe(marker);
  expect(local.ancestry.includes("root:" + marker)).toBe(saves <= 32);
  const fresh = await openTab(w);
  const after = await stored(w);
  expect(after.record).toEqual(local);
  expect(after.meta.reset).toBe(marker);
  expect(recovery(w, after)).toEqual([]);
  expect(fresh.shows()).toEqual(local.data);
  await pause();
  expect(notices()).toEqual([]);
});

test("a reset notice does not suppress a later released-copy notice on that page", async () => {
  const w = world();
  const issuer = await openTab(w);
  issuer.title("prior draft");
  await issuer.save();
  const affected = await openTab(w);
  await issuer.session.startOver();
  const original = Storage.prototype.getItem;
  let injected = false;
  const reads = jest.spyOn(Storage.prototype, "getItem").mockImplementation(function (name) {
    if (!injected && name === w.key + ":reset") {
      injected = true;
      queueMicrotask(() => { affected.note("late typing"); affected.capture(); });
    }
    return original.call(this, name);
  });
  try { await affected.sync(); } finally { reads.mockRestore(); }
  expect(injected).toBe(true);
  expect(affected.reloaded).toBe(1);
  const fresh = await openTab(w);
  fresh.title("new active draft");
  await fresh.save();
  await pause();
  const resetNotice = "This draft was started over in another tab. The earlier draft was kept aside in this browser.";
  expect(notices()).toEqual([resetNotice]);
  const before = await stored(w);
  for (const note of ["released whole page", "another released whole page"]) {
    const { next } = oldTabPage(w, { ...SERVED, note }, { announce: false });
    await fresh.sync();
    expect(recovery(w, await stored(w))).toContainEqual(next);
  }
  await pause();
  expect((await stored(w)).record).toEqual(before.record);
  expect(notices()).toEqual([resetNotice, KEPT_ASIDE]);
});

test.each(["bare-reset", "2~numbered"])("explicit reset tokens override ancestry; tokenless records keep the old rules (%s)", (marker) => {
  const record = { v: 1, id: "old", data: SERVED };
  const meta = { gen: 1, rev: 1, reset: "", tabs: {}, unit: null, foreign: null };
  const local = { v: 1, id: "foreign", ancestry: ["unrelated"], data: { ...SERVED, note: "foreign typing" } };
  const run = (copy) => commit({ meta, record }, { seed: SERVED, newId: () => "id", now: 1, merge3, unitMark, marker, local: copy });
  const matching = { ...local, reset: marker };
  expect(run(matching).record).toEqual(matching);
  const mismatched = { ...local, reset: "older", ancestry: ["root:" + marker] };
  expect(run(mismatched).record).toBe(null);
  expect(run(mismatched).recovered).toContainEqual(mismatched);
  const legacy = run(local);
  expect(legacy.record).toEqual(marker === "bare-reset" ? local : null);
  if (marker !== "bare-reset") expect(legacy.recovered).toContainEqual(local);
});

test("a reset token is metadata, so a head can still hold all record data", async () => {
  const w = world();
  localStorage.setItem(w.key + ":reset", "2~current");
  const offline = await openTab(w, { database: false });
  offline.note("fallback typing");
  offline.store.write(offline.html());
  const local = w.parsed();
  const original = Storage.prototype.setItem;
  const writes = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (name, value) {
    if (name === w.key && JSON.parse(value)?.v === 1) throw Object.assign(new Error("full cache refused"), { name: "QuotaExceededError" });
    return original.call(this, name, value);
  });
  try { await openTab(w); } finally { writes.mockRestore(); }
  expect((await stored(w)).record).toEqual(local);
  expect(w.parsed()).toMatchObject({ v: 2, full: true, data: local.data, w: { reset: "2~current" } });
});

test("a stopped store never sends its pending ending request", async () => {
  const w = world();
  const tab = await openTab(w);
  tab.title("the draft must survive a stopped page");
  await tab.save();
  const before = await stored(w);
  const original = Storage.prototype.setItem;
  let stopped = false;
  const writes = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (name, value) {
    if (name === w.key + ":reset") {
      stopped = true;
      tab.store.stop();
      throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    }
    return original.call(this, name, value);
  });
  try { await tab.session.startOver(); } finally { writes.mockRestore(); }
  expect(stopped).toBe(true);
  expect(tab.store.stopped()).toBe(true);
  await tab.sync();
  const after = await stored(w);
  expect(after.meta).toEqual(before.meta);
  expect(after.record).toEqual(before.record);
});
