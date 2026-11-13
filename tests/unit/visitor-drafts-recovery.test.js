import { beforeEach, afterEach, expect, jest, test } from "@jest/globals";
import { IDBKeyRange } from "fake-indexeddb";
import { openDrafts } from "../../src/plugins/visitor-drafts/idb.js";
import { recoveryKey, recoveryRecord, transact } from "../../src/plugins/visitor-drafts/commit.js";
import { merge3, same, unitMark } from "../../src/plugins/visitor-drafts/store.js";
import { createRecovery } from "../../src/plugins/visitor-drafts/recovery.js";
import { world, openTab, stored, SERVED, failing } from "./helpers/visitor-drafts-session.js";

beforeEach(() => { localStorage.clear(); sessionStorage.clear(); delete window.clay; });
afterEach(() => { delete window.clay; jest.restoreAllMocks(); });
const copy = (id = "earlier", data = { ...SERVED, title: "earlier title", note: "earlier note" }) => ({ v: 1, id, savedAt: "2026-11-11T12:00:00.000Z", data });

async function keep(w, copies) {
  const db = await openDrafts({ factory: w.factory, keyRange: IDBKeyRange });
  await db.change(w.key, (raw) => {
    const meta = JSON.parse(raw.meta);
    meta.recovery = copies.map(([mark]) => mark);
    return { puts: [[w.key + ":meta", JSON.stringify(meta)], ...copies.map(([mark, value]) => [recoveryKey(w.key, mark), JSON.stringify(value)])], deletes: [], result: null };
  });
  db.close();
}

function api(t) {
  window.clay = { getHTML: t.html };
  return createRecovery({ store: t.store, session: t.session, getHTML: t.html });
}
const keptRecords = (all, key) => [...all].filter(([name]) => name.startsWith(key + ":recovery:")).map(([, raw]) => JSON.parse(raw));

test("lists only this page's copies, newest first, and reads record and journal timestamps", async () => {
  const w = world();
  const t = await openTab(w);
  const old = copy();
  const chain = { tab: "closed", reset: "old", ops: [{ seq: 1, savedAt: "2026-11-12T10:00:00.000Z", keys: { note: { b: "before", m: "after" } } }] };
  await keep(w, [["earlier", old], ["op:closed:1", chain]]);
  const db = await openDrafts({ factory: w.factory, keyRange: IDBKeyRange });
  await db.change(w.key + "-other", () => ({ puts: [[w.key + "-other:recovery:secret", JSON.stringify(copy("secret"))]], deletes: [] }));
  db.close();
  const rows = await api(t).list();
  expect(rows.map(({ mark, fields }) => ({ mark, fields }))).toEqual([{ mark: "op:closed:1", fields: 1 }, { mark: "earlier", fields: 3 }]);
  expect(recoveryRecord(chain, SERVED).data).toEqual({ ...SERVED, note: "after" });
  expect(chain.ops[0].keys.note.b).toBe("before");
});

test("restore keeps the current draft first, including typing not yet autosaved, and reloads into the chosen draft", async () => {
  const w = world();
  const t = await openTab(w);
  await keep(w, [["earlier", copy()]]);
  t.title("current title");
  await t.save();
  t.note("typing before restore");
  await api(t).restore("earlier");
  const after = await stored(w);
  expect(after.record.data).toEqual(copy().data);
  expect(keptRecords(after.all, w.key)).toEqual(expect.arrayContaining([expect.objectContaining({ data: { ...SERVED, title: "current title", note: "typing before restore" } })]));
  expect(after.meta.gen).toBe(1);
  expect(after.meta.reset).toBe("");
  expect(t.reloaded).toBe(1);
  expect(t.store.stopped()).toBe(true);
  delete window.clay;
  const next = await openTab(w);
  expect(next.shows()).toEqual(copy().data);
});

test("restores an ended journal as an active draft and keeps the previous active record", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("current");
  await t.save();
  const chain = { tab: "old", reset: "ended", ops: [{ seq: 4, savedAt: "2026-11-12T01:00:00Z", keys: { note: { m: "recovered typing" } } }] };
  await keep(w, [["op:old:4", chain]]);
  await api(t).restore("op:old:4");
  const after = await stored(w);
  expect(after.record.data).toEqual({ ...SERVED, note: "recovered typing" });
  expect(keptRecords(after.all, w.key).some((value) => value.data?.title === "current")).toBe(true);
});

test("an aborted restore leaves every database byte and the live typing intact", async () => {
  const w = world();
  const state = failing(w);
  const t = await openTab(w);
  await keep(w, [["earlier", copy()]]);
  t.title("current");
  await t.save();
  const before = await stored(w);
  t.note("unsaved typing");
  state.fail = true;
  await expect(api(t).restore("earlier")).rejects.toThrow();
  state.fail = false;
  expect((await stored(w)).all).toEqual(before.all);
  expect(t.shows().note).toBe("unsaved typing");
  expect(t.reloaded).toBe(0);
  expect(t.store.stopped()).toBe(false);
  await t.sync();
  expect((await stored(w)).record.data.note).toBe("unsaved typing");
});

test("the preserve and replacement writes abort together even after writes have been queued", async () => {
  const w = world();
  const t = await openTab(w);
  await keep(w, [["earlier", copy()]]);
  t.title("current");
  await t.save();
  const before = await stored(w);
  const db = await openDrafts({ factory: w.factory, keyRange: IDBKeyRange });
  const broken = { change: (key, build, options) => db.change(key, (raw) => {
    const planned = build(raw);
    expect(planned.puts.some(([name]) => name.startsWith(key + ":recovery:") && name !== key + ":recovery:earlier")).toBe(true);
    planned.puts.push([key + ":poison", () => {}]);
    return planned;
  }, options) };
  await expect(transact(broken, w.key, () => ({ seed: SERVED, newId: () => "restored", now: Date.now(), merge3, same, unitMark, recovery: { type: "restore", mark: "earlier", reset: "" } }), { recovery: true })).rejects.toThrow();
  expect((await stored(w)).all).toEqual(before.all);
  db.close();
});

test("restore keeps at most eight copies and retains the selected copy even when it was oldest", async () => {
  const w = world();
  const t = await openTab(w);
  await keep(w, Array.from({ length: 8 }, (_, i) => ["r" + i, copy("r" + i)]));
  t.note("current typing");
  await api(t).restore("r7");
  const after = await stored(w);
  expect(after.meta.recovery).toHaveLength(8);
  expect(keptRecords(after.all, w.key)).toHaveLength(8);
  expect(after.all.has(recoveryKey(w.key, "r7"))).toBe(true);
  expect(keptRecords(after.all, w.key).some((value) => value.data?.note === "current typing")).toBe(true);
});

test("remove deletes only the selected copy and its meta entry", async () => {
  const w = world();
  const t = await openTab(w);
  await keep(w, [["earlier", copy()], ["other", copy("other")]]);
  t.title("current");
  await t.save();
  const before = await stored(w);
  await api(t).remove("earlier");
  const after = await stored(w);
  expect(after.record).toEqual(before.record);
  expect(after.meta.recovery).toEqual(["other"]);
  expect(after.all.has(recoveryKey(w.key, "earlier"))).toBe(false);
  expect(after.all.get(recoveryKey(w.key, "other"))).toBe(before.all.get(recoveryKey(w.key, "other")));
});

test("a stale restore never changes the newer generation and keeps old typing as recovery", async () => {
  const w = world();
  const t = await openTab(w);
  await keep(w, [["earlier", copy()]]);
  t.note("stale typing");
  localStorage.setItem(w.key + ":reset", "9~newer");
  await expect(api(t).restore("earlier")).rejects.toThrow("started over");
  const after = await stored(w);
  expect(after.record).toBeNull();
  expect(after.meta.reset).toBe("9~newer");
  expect(keptRecords(after.all, w.key).some((value) => value.ops?.some((op) => op.keys.note?.m === "stale typing"))).toBe(true);
});

test("download builds the chosen copy through the HTML download path without changing the active draft", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("current title");
  await t.save();
  const before = await stored(w);
  const download = jest.fn(async () => true);
  const recovery = createRecovery({ store: t.store, session: t.session, getHTML: t.html, download });
  await recovery.download(copy());
  const { html, name } = download.mock.calls[0][0];
  expect(name).toMatch(/\.htmlclay$/);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  expect(parsed.querySelector("#title").textContent).toBe("earlier title");
  expect(parsed.querySelector("#note").value).toBe("earlier note");
  expect(t.shows().title).toBe("current title");
  expect((await stored(w)).all).toEqual(before.all);
});

test("download carries the selected page editor stores and article, with script-closing text escaped", async () => {
  const w = world();
  const t = await openTab(w, { article: true });
  const c = { ...copy(), live: { blockeditor: { text: "</script><img src=x>" } }, blockeditor: { rev: "old", html: "<p>Earlier article</p>" } };
  const html = api(t).html(c);
  const parsed = new DOMParser().parseFromString(html, "text/html");
  expect(parsed.querySelector("article").innerHTML).toBe("<p>Earlier article</p>");
  expect(JSON.parse(parsed.querySelector('script[merge="blockeditor"]').textContent)).toEqual(c.live.blockeditor);
  expect(parsed.querySelector("img")).toBeNull();
});

test("typing captured while a restore transaction completes is kept before the page reloads", async () => {
  const w = world();
  const t = await openTab(w);
  await keep(w, Array.from({ length: 8 }, (_, i) => ["r" + i, copy("r" + i)]));
  t.note("first typing");
  const acknowledge = t.store.acknowledge;
  let injected = false;
  t.store.acknowledge = (seq) => {
    const saved = acknowledge(seq);
    if (!injected) {
      injected = true;
      t.note("typing during restore");
      t.capture();
    }
    return saved;
  };
  await api(t).restore("r7");
  expect(injected).toBe(true);
  const after = await stored(w);
  expect(after.record.data).toEqual(copy().data);
  expect(keptRecords(after.all, w.key).some((value) => value.data?.note === "typing during restore")).toBe(true);
  expect(keptRecords(after.all, w.key).some((value) => value.data?.note === "first typing")).toBe(true);
  expect(keptRecords(after.all, w.key)).toHaveLength(8);
  expect(t.reloaded).toBe(1);
});

test("a missing copy refuses restore without touching the active record", async () => {
  const w = world();
  const t = await openTab(w);
  t.title("current");
  await t.save();
  const before = await stored(w);
  await expect(api(t).restore("gone")).rejects.toThrow("no longer available");
  expect((await stored(w)).all).toEqual(before.all);
  expect(t.store.stopped()).toBe(false);
});

test("a copy that no longer fits refuses restore and remains available in storage", async () => {
  const w = world();
  const t = await openTab(w);
  await keep(w, [["earlier", copy("earlier", { unknown: "keep me" })]]);
  const before = await stored(w);
  await expect(api(t).restore("earlier")).rejects.toThrow();
  expect((await stored(w)).all).toEqual(before.all);
  expect(t.reloaded).toBe(0);
});

test("removing an ended journal also clears its proven slots so the copy does not return", async () => {
  const w = world();
  const t = await openTab(w);
  const chain = { tab: "closed", reset: "ended", acked: 0, at: w.clock, ops: [{ seq: 1, savedAt: new Date(w.clock).toISOString(), keys: { note: { m: "old typing" } } }] };
  await keep(w, [["op:closed:1", chain]]);
  localStorage.setItem(w.key + ":op:closed", JSON.stringify(chain));
  const db = await openDrafts({ factory: w.factory, keyRange: IDBKeyRange });
  await db.putRow(w.key + ":op:closed", JSON.stringify(chain));
  db.close();
  await api(t).remove("op:closed:1");
  expect(localStorage.getItem(w.key + ":op:closed")).toBeNull();
  await t.sync();
  const after = await stored(w);
  expect(after.meta.recovery).toEqual([]);
  expect(after.all.has(w.key + ":op:closed")).toBe(false);
  expect(after.all.has(recoveryKey(w.key, "op:closed:1"))).toBe(false);
});

test("copies remain readable after the opening transaction failed", async () => {
  const w = world();
  await openTab(w);
  await keep(w, [["earlier", copy()]]);
  const state = failing(w);
  state.fail = true;
  const t = await openTab(w);
  state.fail = false;
  await t.sync();
  await expect(api(t).list()).resolves.toEqual([expect.objectContaining({ mark: "earlier" })]);
});

for (const operation of ["restore", "save", "save before getHTML"]) {
  test(`late unjournaled typing survives another tab's Start over during ${operation}`, async () => {
    const w = world();
    const t = await openTab(w);
    await keep(w, [["earlier", copy()]]);
    const recovery = api(t);
    t.title("current saved title");
    await t.save();
    t.note("typing before reset");
    t.capture();
    localStorage.setItem(w.key + ":reset", "2~another-tab");
    const chain = t.store.chain;
    let injected = false;
    t.store.chain = () => {
      if (!injected) {
        injected = true;
        queueMicrotask(() => { t.doc.getElementById("note").value = "late unjournaled visitor typing"; });
      }
      return chain();
    };
    if (operation === "restore") await expect(recovery.restore("earlier")).rejects.toThrow("started over");
    else {
      if (operation === "save before getHTML") delete window.clay;
      await t.sync();
    }
    expect(injected).toBe(true);
    expect(t.reloaded).toBe(1);
    expect(JSON.stringify(Object.entries(localStorage))).toContain("late unjournaled visitor typing");
    expect(JSON.parse(sessionStorage.getItem(w.key + ":recovery-notice"))).toEqual(expect.objectContaining({ reset: true }));
    delete window.clay;
    const next = await openTab(w);
    const after = await stored(w);
    expect(next.shows().note).toBe(SERVED.note);
    expect(keptRecords(after.all, w.key).some((value) => value.ops?.some((op) => op.keys.note?.m === "late unjournaled visitor typing"))).toBe(true);
    expect(after.meta.reset).toBe("2~another-tab");
  });
}

test("restoring the same draft twice and returning to the previous draft keeps no duplicate", async () => {
  const w = world();
  let t = await openTab(w);
  await keep(w, Array.from({ length: 8 }, (_, i) => ["r" + i, copy("r" + i, { ...SERVED, note: "kept " + i })]));
  t.note("current typing");
  await api(t).restore("r2");
  const first = await stored(w);
  const currentMark = keptRecords(first.all, w.key).find((record) => record.data?.note === "current typing").id;
  delete window.clay;
  t = await openTab(w);
  await api(t).restore("r2");
  expect(keptRecords((await stored(w)).all, w.key)).toEqual(keptRecords(first.all, w.key));
  delete window.clay;
  t = await openTab(w);
  await api(t).restore(currentMark);
  const after = await stored(w);
  expect(after.record.data.note).toBe("current typing");
  expect(keptRecords(after.all, w.key)).toEqual(keptRecords(first.all, w.key));
  expect(keptRecords(after.all, w.key).filter((record) => record.data?.note === "kept 2")).toHaveLength(1);
});

for (const slotLimit of [50000, 1]) {
  test(`typing after Restore's second transaction reaches recovery with slot limit ${slotLimit}`, async () => {
    const w = world();
    const t = await openTab(w, { slotLimit });
    await keep(w, [["earlier", copy()]]);
    t.note("typing before restore");
    const acknowledge = t.store.acknowledge;
    let passes = 0;
    t.store.acknowledge = (seq) => {
      const saved = acknowledge(seq);
      if (++passes <= 2) {
        t.doc.getElementById("note").value = "late typing " + passes;
        if (passes === 1) t.capture();
      }
      return saved;
    };
    await api(t).restore("earlier");
    expect(passes).toBeGreaterThanOrEqual(2);
    expect(t.reloaded).toBe(1);
    const durable = JSON.stringify([...(await stored(w)).all]) + JSON.stringify(Object.entries(localStorage));
    expect(durable).toContain("late typing 2");
    delete window.clay;
    const next = await openTab(w);
    expect(next.shows()).toEqual(copy().data);
    const after = await stored(w);
    expect(after.record.data).toEqual(copy().data);
    expect(keptRecords(after.all, w.key).some((value) => recoveryRecord(value, SERVED)?.data.note === "late typing 2")).toBe(true);
  });
}

test("duplicate detection compares data independent of key order and includes the whole page", async () => {
  const w = world();
  const t = await openTab(w, { article: true });
  t.note("current typing");
  t.writePage("same-rev", { title: "page content" });
  await t.save();
  const current = (await stored(w)).record;
  const reordered = { ...current, id: "equal", data: Object.fromEntries(Object.entries(current.data).reverse()) };
  const differentPage = { ...current, id: "different-page", blockeditor: { ...current.blockeditor, html: "<p>A different projection</p>" } };
  await keep(w, [["equal", reordered], ["different-page", differentPage]]);
  await api(t).restore("different-page");
  let after = await stored(w);
  expect(keptRecords(after.all, w.key)).toHaveLength(2);
  expect(after.record.blockeditor.html).toBe(differentPage.blockeditor.html);
  await t.session.removeRecovery("different-page");
  const db = await openDrafts({ factory: w.factory, keyRange: IDBKeyRange });
  await transact(db, w.key, () => ({ seed: SERVED, newId: () => "back-to-equal", now: w.clock, merge3, same, unitMark, recovery: { type: "restore", mark: "equal", reset: "" } }), { recovery: true });
  db.close();
  after = await stored(w);
  expect(keptRecords(after.all, w.key)).toHaveLength(2);
  expect(keptRecords(after.all, w.key).some((record) => record.blockeditor?.html === differentPage.blockeditor.html)).toBe(true);
});
