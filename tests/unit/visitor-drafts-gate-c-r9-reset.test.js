import { beforeEach, expect, jest, test } from "@jest/globals";
import { openSession } from "../../src/plugins/visitor-drafts/session.js";
import { commit, LINEAGE, recoveryMark } from "../../src/plugins/visitor-drafts/commit.js";
import { merge3, unitMark } from "../../src/plugins/visitor-drafts/store.js";
import { SERVED, failing, oldTabSave, openTab, stored, transactOnce, world } from "./helpers/visitor-drafts-session.js";

const RESET_NOTICE = "This draft was started over in another tab. The earlier draft was kept aside in this browser.";
const notices = () => [...(document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')?.shadowRoot?.querySelectorAll("[data-clay-toast]") ?? [])].map((el) => el.textContent);
const clearNotices = () => document.querySelectorAll("clay-editor-ui").forEach((el) => el.remove());
const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
const recovery = (w, state) => [...state.all].filter(([name]) => name.startsWith(w.key + ":recovery:")).map(([, value]) => JSON.parse(value));

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); delete window.clay; clearNotices(); });

function refuseMarker(w) {
  const original = Storage.prototype.setItem;
  return jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (name, value) {
    if (name === w.key + ":reset") throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    return original.call(this, name, value);
  });
}

test.each([[true, false], [true, true], [false, false], [false, true]])("reset retains every captured operation (earlier operation %s, late capture %s)", async (initial, late) => {
  const w = world();
  const t = await openTab(w);
  if (initial) { t.title("first queued change"); t.capture(); }
  const newer = await transactOnce(w, {
    resets: [{ ends: 1, marker: "2~other" }],
    chains: [{ tab: "other", reset: "2~other", ops: [{ seq: 1, keys: { title: { m: "newer active draft" } } }] }],
  });
  localStorage.setItem(w.key + ":reset", "2~other");
  let captured;
  const capture = () => {
    expect(t.store.stopped()).toBe(false);
    t.note("typing before learning of reset");
    t.capture();
    captured = JSON.parse(localStorage.getItem(t.store.slotKey));
    expect(captured.ops).toHaveLength(initial ? 2 : 1);
  };
  const original = Storage.prototype.getItem;
  let injected = false;
  const reads = jest.spyOn(Storage.prototype, "getItem").mockImplementation(function (name) {
    if (late && !injected && name === w.key + ":reset") { injected = true; queueMicrotask(capture); }
    return original.call(this, name);
  });
  if (!late) capture();
  try { await t.sync(); } finally { reads.mockRestore(); }
  expect(captured).toBeDefined();
  expect(injected).toBe(late);
  expect(t.reloaded).toBe(1);
  expect((await stored(w)).record).toEqual(newer.record);
  const next = await openTab(w);
  const after = await stored(w);
  expect(after.record).toEqual(newer.record);
  const copies = recovery(w, after);
  for (const op of captured.ops) expect(copies.some((copy) => copy.ops?.some((held) => JSON.stringify(held) === JSON.stringify(op)))).toBe(true);
  await pause();
  expect(notices()).toEqual([RESET_NOTICE]);
  next.note("typing after learning of reset");
  await next.save();
  expect((await stored(w)).record.data.note).toBe("typing after learning of reset");
});

test.each([false, true])("late typing too large for the journal waits for durable recovery (row refused %s)", async (refuse) => {
  const w = world();
  const t = await openTab(w, { slotLimit: 1 });
  const newer = await transactOnce(w, { resets: [{ ends: 1, marker: "2~other" }] });
  localStorage.setItem(w.key + ":reset", "2~other");
  const state = failing(w);
  // Reopen this tab's database through the refusal fixture before injecting the capture.
  t.session = await openSession({ store: t.store, storage: localStorage, doc: t.doc, reload: () => { t.reloaded++; } });
  const original = Storage.prototype.getItem;
  let injected = false;
  const reads = jest.spyOn(Storage.prototype, "getItem").mockImplementation(function (name) {
    if (!injected && name === w.key + ":reset") {
      injected = true;
      queueMicrotask(() => { t.note("late large typing"); t.capture(); state.fail = refuse; });
    }
    return original.call(this, name);
  });
  try {
    if (refuse) await expect(t.session.first).rejects.toMatchObject({ code: "draft-storage" });
    else await t.session.first;
  } finally { reads.mockRestore(); }
  expect(injected).toBe(true);
  if (refuse) {
    expect(t.reloaded).toBe(0);
    expect(t.store.unsafe()).toBe(true);
    expect(t.store.pending()).toBe(1);
    state.fail = false;
    await t.sync();
  }
  expect(t.reloaded).toBe(1);
  expect(t.store.unsafe()).toBe(false);
  await openTab(w);
  const after = await stored(w);
  expect(after.record).toEqual(newer.record);
  expect(recovery(w, after).some((copy) => copy.ops?.some((op) => op.keys.note?.m === "late large typing"))).toBe(true);
});

test.each([31, 32, 33, 40])("a bare reset imports a released record after %s saves without needing its root", async (saves) => {
  const w = world();
  const t = await openTab(w);
  t.title("discarded draft");
  await t.save();
  const before = await stored(w);
  localStorage.removeItem(w.key);
  localStorage.setItem(w.key + ":reset", "released-reset");
  let local = { v: 1, id: "fresh0", savedAt: "after", ancestry: ["root:released-reset"], data: { ...SERVED, note: "fresh0" } };
  for (let i = 1; i <= saves; i++) local = { ...local, id: "fresh" + i, ancestry: [local.id, ...local.ancestry].slice(0, 32), data: { ...local.data, note: "fresh" + i } };
  localStorage.setItem(w.key, JSON.stringify(local));
  await openTab(w);
  const after = await stored(w);
  expect(after.record).toEqual(local);
  expect(recovery(w, after)).toEqual([before.record]);
  await pause();
  expect(notices()).toEqual([]);
});

test.each(["1~start", "legacy-marker"])("Start over still ends the shown generation after refused marker writes (%s)", async (marker) => {
  const w = world();
  localStorage.setItem(w.key + ":reset", marker);
  const t = await openTab(w);
  t.title("first draft");
  await t.save();
  const writes = refuseMarker(w);
  try {
    await t.session.startOver();
    const fresh = await openTab(w);
    fresh.title("second draft");
    await fresh.save();
    const before = await stored(w);
    expect(before.record.data.title).toBe("second draft");
    await fresh.session.startOver();
    const after = await stored(w);
    expect(after.record).toBe(null);
    expect(after.meta.gen).toBe(before.meta.gen + 1);
    expect((await openTab(w)).shows()).toEqual(SERVED);
  } finally { writes.mockRestore(); }
});

test.each([false, true])("own new-generation typing before the first transaction stays active (bare marker %s)", async (bare) => {
  const w = world();
  localStorage.setItem(w.key + ":reset", bare ? "legacy-marker" : "1~start");
  const t = await openTab(w);
  t.title("discarded");
  await t.save();
  const writes = refuseMarker(w);
  try {
    await t.session.startOver();
    const reset = await stored(w);
    const next = await openTab(w, { database: false });
    expect(next.shows()).toEqual(SERVED);
    next.note("fresh typing before the first transaction");
    next.capture();
    expect(next.store.chain().reset).toBe(reset.meta.reset);
    next.session = await openSession({ store: next.store, storage: localStorage, doc: next.doc, reload: () => { next.reloaded++; } });
    await next.session.first;
    const after = await stored(w);
    expect(after.record.data.note).toBe("fresh typing before the first transaction");
    expect(after.meta.gen).toBe(reset.meta.gen);
    expect(next.reloaded).toBe(0);
    expect(recovery(w, after)).toEqual([]);
  } finally { writes.mockRestore(); }
});

test.each([false, true])("the reset notice belongs to the affected tab, never the issuer (foreign save %s)", async (foreign) => {
  const w = world();
  const a = await openTab(w);
  a.title("saved draft");
  await a.save();
  const b = await openTab(w);
  b.note("other tab's unsent typing");
  b.capture();
  const chain = structuredClone(b.store.chain());
  if (foreign) oldTabSave(w, { note: "released save" }, { announce: false });
  await a.session.startOver();
  expect(JSON.parse((await stored(w)).all.get(w.key + ":recovery:" + recoveryMark(chain)))).toEqual(chain);
  expect(sessionStorage.getItem(w.key + ":recovery-notice")).toBe(null);
  await openTab(w);
  await pause();
  expect(notices()).toEqual([]);
  sessionStorage.clear();
  await b.sync();
  await openTab(w);
  await pause();
  expect(notices()).toEqual([RESET_NOTICE]);
  clearNotices();
  await openTab(w);
  await pause();
  expect(notices()).toEqual([]);
});

test("a reset marker arriving after the transaction read is not mistaken for a refused write", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("draft before reset");
  await t.save();
  const original = Storage.prototype.getItem;
  let injected = false;
  const reads = jest.spyOn(Storage.prototype, "getItem").mockImplementation(function (name) {
    if (!injected && name === w.key + ":reset") {
      injected = true;
      queueMicrotask(() => {
        localStorage.removeItem(w.key);
        localStorage.setItem(w.key + ":reset", "late-reset");
      });
    }
    return original.call(this, name);
  });
  try { await t.sync(); } finally { reads.mockRestore(); }
  expect(injected).toBe(true);
  const fresh = await openTab(w, { database: false });
  expect(fresh.store.generation()).toBe("late-reset");
  fresh.note("fresh typing under the late reset");
  fresh.capture();
  fresh.session = await openSession({ store: fresh.store, storage: localStorage, doc: fresh.doc, reload: () => { fresh.reloaded++; } });
  await fresh.session.first;
  expect((await stored(w)).record.data.note).toBe("fresh typing under the late reset");
  expect(fresh.reloaded).toBe(0);
});

test("ended-marker history keeps only the latest bounded entries", () => {
  const options = { seed: SERVED, newId: () => "id", now: 1, merge3, unitMark };
  let state = { meta: { gen: 1, rev: 0, reset: "", tabs: {}, unit: null, foreign: null }, record: null };
  for (let i = 1; i <= LINEAGE + 10; i++) state = commit(state, { ...options, marker: "bare" + i });
  expect(state.meta.ended).toHaveLength(LINEAGE);
  expect(state.meta.ended).toEqual(Array.from({ length: LINEAGE }, (_, i) => "bare" + (i + 10)));
  expect(commit(state, { ...options, marker: "bare39" }).meta).toEqual(state.meta);
});
