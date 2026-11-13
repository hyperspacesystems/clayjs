/** @jest-environment node */
// The one write path of a visitor draft (05b step 1): the pure `commit()` and the
// transaction that runs it. Each rule is held on its own here; the scenarios and the fuzz
// hold them together.
import { describe, expect, test } from "@jest/globals";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { openDrafts } from "../../src/plugins/visitor-drafts/idb.js";
import { LINEAGE, TAB_TTL_MS, commit as commitWith, conflictKey, markerFor, metaKey, rowKey, transact } from "../../src/plugins/visitor-drafts/commit.js";
import { unitMark } from "../../src/plugins/visitor-drafts/store.js";
import { TOOLS, delta } from "./helpers/visitor-drafts-tabs.js";

const commit = (stored, input) => commitWith(stored, { ...TOOLS, ...input });

const SEED = { title: "owner title", note: "owner note" };
const NOW = Date.parse("2026-11-12T12:00:00Z");
const ids = () => { let n = 0; return () => "id" + ++n; };
const op = (seq, change, base = SEED) => ({ seq, savedAt: "t" + seq, keys: delta(base, { ...base, ...change }) });
const run = (stored, input) => commit({ meta: null, record: null, v1base: null, ...stored }, { seed: SEED, now: NOW, newId: ids(), ...input });

describe("commit(): operations", () => {
  test("a chain applies each operation once and in order, from any carrier, any number of times", () => {
    const chain = { tab: "t", reset: "", ops: [op(1, { title: "one" }), op(2, { title: "two" }, { ...SEED, title: "one" })] };
    const first = run({}, { chains: [chain, chain, { ...chain, ops: [chain.ops[1], chain.ops[0]] }] });
    expect(first.record.data.title).toBe("two");
    expect(first.meta.rev).toBe(2);
    expect(first.meta.tabs.t.seq).toBe(2);
    const again = commit({ meta: first.meta, record: first.record }, { seed: SEED, now: NOW, newId: ids(), chains: [chain] });
    expect(again.meta.rev).toBe(2);
    expect(again.record).toEqual(first.record);
  });

  test("an operation after a gap waits; the one that fills the gap lets both apply", () => {
    const later = { tab: "t", reset: "", ops: [op(2, { note: "second" })] };
    const waiting = run({}, { chains: [later] });
    expect(waiting.record).toBe(null);
    expect(waiting.applied.t).toBe(0);
    const filled = run({}, { chains: [{ tab: "t", reset: "", ops: [op(1, { title: "first" })] }, later] });
    expect(filled.record.data).toEqual({ title: "first", note: "second" });
  });

  test("an operation of another generation is never applied, and its tab is told", () => {
    const result = run({}, { chains: [{ tab: "old", reset: "0~gone", ops: [op(1, { title: "discarded" })] }] });
    expect(result.record).toBe(null);
    expect(result.stale).toEqual(["old"]);
  });

  test("every change gets a new id, descending from the record it replaced; a generation's first names its root", () => {
    let stored = {};
    const seen = [];
    for (let seq = 1; seq <= LINEAGE + 3; seq++) {
      const result = commit({ meta: null, record: null, ...stored }, { seed: SEED, now: NOW, newId: () => "id" + seq, chains: [{ tab: "t", reset: "", ops: [op(seq, { title: "save " + seq }, seq === 1 ? SEED : { ...SEED, title: "save " + (seq - 1) })] }] });
      seen.push(result.record.id);
      stored = { meta: result.meta, record: result.record };
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(stored.record.ancestry[0]).toBe(seen[seen.length - 2]);
    expect(stored.record.ancestry.length).toBe(LINEAGE);
    expect(run({}, { marker: markerFor(4, "abc"), chains: [{ tab: "t", reset: "4~abc", ops: [op(1, { title: "x" })] }] }).record.ancestry).toEqual(["root:4~abc"]);
  });

  test("a true conflict: the operation wins and the record it replaced is returned as a copy", () => {
    const stored = run({}, { chains: [{ tab: "a", reset: "", ops: [op(1, { title: "from a" })] }] });
    const result = commit({ meta: stored.meta, record: stored.record }, { seed: SEED, now: NOW, newId: () => "b1", chains: [{ tab: "b", reset: "", ops: [op(1, { title: "from b" })] }] });
    expect(result.record.data.title).toBe("from b");
    expect(result.conflicts).toEqual([stored.record]);
    const apart = commit({ meta: stored.meta, record: stored.record }, { seed: SEED, now: NOW, newId: () => "b1", chains: [{ tab: "b", reset: "", ops: [op(1, { note: "from b" })] }] });
    expect(apart.record.data).toEqual({ title: "from a", note: "from b" });
    expect(apart.conflicts).toEqual([]);
  });

  test("the Block editor page: kept when an operation has none, a copy kept when one replaces a page it never saw", () => {
    const page = (rev) => ({ live: { "#a": rev }, blockeditor: { rev, html: "<p>" + rev + "</p>" } });
    const first = run({}, { chains: [{ tab: "a", reset: "", ops: [{ ...op(1, { title: "a" }), unit: { seen: null, to: page("1") } }] }] });
    expect(first.record.blockeditor.rev).toBe("1");
    expect(first.meta.unit).toBe(unitMark(page("1")));
    const plain = commit({ meta: first.meta, record: first.record }, { seed: SEED, now: NOW, newId: () => "p2", chains: [{ tab: "b", reset: "", ops: [op(1, { note: "b" })] }] });
    expect(plain.record.blockeditor.rev).toBe("1");
    expect(plain.conflicts).toEqual([]);
    const blind = commit({ meta: plain.meta, record: plain.record }, { seed: SEED, now: NOW, newId: () => "p3", chains: [{ tab: "c", reset: "", ops: [{ ...op(1, {}), unit: { seen: "something older", to: page("3") } }] }] });
    expect(blind.record.blockeditor.rev).toBe("3");
    expect(blind.conflicts.map((copy) => copy.blockeditor.rev)).toEqual(["1"]);
    const known = commit({ meta: first.meta, record: first.record }, { seed: SEED, now: NOW, newId: () => "p4", chains: [{ tab: "c", reset: "", ops: [{ ...op(1, {}), unit: { seen: unitMark(page("1")), to: page("4") } }] }] });
    expect(known.conflicts).toEqual([]);
  });
});

describe("commit(): Start over", () => {
  const withRecord = () => run({}, { chains: [{ tab: "t", reset: "", ops: [op(1, { title: "draft" })] }] });

  test("ending the shown generation clears the record and every tab's count", () => {
    const stored = withRecord();
    const result = commit({ meta: stored.meta, record: stored.record }, { seed: SEED, now: NOW, newId: ids(), resets: [{ ends: 1, marker: "2~x" }] });
    expect(result.record).toBe(null);
    expect(result.meta).toMatchObject({ gen: 2, reset: "2~x", tabs: {} });
  });

  test("ending a generation that already ended changes nothing", () => {
    const stored = withRecord();
    const ended = commit({ meta: stored.meta, record: stored.record }, { seed: SEED, now: NOW, newId: ids(), resets: [{ ends: 1, marker: "2~x" }] });
    const fresh = commit({ meta: ended.meta, record: null }, { seed: SEED, now: NOW, newId: () => "new", chains: [{ tab: "u", reset: "2~x", ops: [op(1, { note: "new work" })] }] });
    const late = commit({ meta: fresh.meta, record: fresh.record }, { seed: SEED, now: NOW, newId: ids(), resets: [{ ends: 1, marker: "2~y" }] });
    expect(late.record).toEqual(fresh.record);
    expect(late.changed).toBe(false);
  });

  test("a numbered marker ends n-1; a bare marker starts empty and preserves the stored generation", () => {
    const stored = withRecord();
    const numbered = commit({ meta: stored.meta, record: stored.record }, { seed: SEED, now: NOW, newId: ids(), marker: "2~m" });
    expect([numbered.meta.gen, numbered.record]).toEqual([2, null]);
    const bare = commit({ meta: stored.meta, record: stored.record }, { seed: SEED, now: NOW, newId: ids(), marker: "abcdef123456" });
    expect(bare.meta).toMatchObject({ gen: 2, reset: "abcdef123456", recovery: [stored.record.id] });
    expect(bare.record).toBe(null);
    expect(bare.recovered).toEqual([stored.record]);
    expect(bare.changed).toBe(true);
    const again = commit({ meta: bare.meta, record: bare.record }, { seed: SEED, now: NOW, newId: ids(), marker: "abcdef123456" });
    expect(again.meta).toEqual(bare.meta);
    expect(again.record).toBe(null);
    expect(again.recovered).toEqual([]);
    expect(again.changed).toBe(false);
  });
});

describe("commit(): the move, and tabs forgotten", () => {
  const local = { v: 1, savedAt: "s", id: "old1", ancestry: ["root:"], data: { title: "from 1.23.0" } };

  test("nothing stored: a 1.23.0 record becomes the first record under its own id, kept as v1base", () => {
    const result = run({}, { local });
    expect(result.record).toEqual(local);
    expect(result.v1base).toEqual(local);
    expect(result.meta.foreign).toBe("old1");
  });

  test("nothing stored: this ClayJS's own cache (a cleared database) is the first record, not another writer's, and the count goes on from it", () => {
    const result = run({}, { local: { ...local, w: { rev: 7, reset: "" } } });
    expect(result.record).toEqual(local);
    expect(result.v1base).toBe(null);
    expect(result.meta.foreign).toBe(null);
    expect(result.meta.rev).toBe(7);
  });

  test("nothing stored: a cache from before the last Start over is not taken in", () => {
    const result = run({}, { marker: "2~new", local: { ...local, w: { rev: 7, reset: "" } } });
    expect(result.record).toBe(null);
    expect(result.meta.reset).toBe("2~new");
  });

  test("a tab names its generation by the Start over marker it booted on, which it knows before its first transaction", () => {
    const bare = run({}, { marker: "abcdef123456", chains: [{ tab: "t", reset: "abcdef123456", ops: [op(1, { title: "typed" })] }] });
    expect(bare.record.data.title).toBe("typed");
    const other = run({}, { marker: "abcdef123456", chains: [{ tab: "t", reset: "", ops: [op(1, { title: "typed before it" })] }] });
    expect([other.record, other.stale]).toEqual([null, ["t"]]);
  });

  test("something stored: the move is not taken again here (later records from old tabs are step 4)", () => {
    const stored = run({}, { local });
    const again = commit({ meta: stored.meta, record: stored.record, v1base: stored.v1base }, { seed: SEED, now: NOW, newId: ids(), local: { ...local, id: "old2", data: { title: "later" } } });
    expect(again.record).toEqual(stored.record);
  });

  test("a tab not heard from for TAB_TTL_MS is forgotten, and its chain's `acked` still lets it go on", () => {
    const stored = run({}, { chains: [{ tab: "t", reset: "", ops: [op(1, { title: "one" })] }] });
    const later = NOW + TAB_TTL_MS + 1;
    const forgot = commit({ meta: stored.meta, record: stored.record }, { seed: SEED, now: later, newId: ids() });
    expect(forgot.meta.tabs).toEqual({});
    const next = commit({ meta: forgot.meta, record: forgot.record }, { seed: SEED, now: later, newId: () => "two", chains: [{ tab: "t", reset: "", acked: 1, ops: [op(2, { title: "two" }, { ...SEED, title: "one" })] }] });
    expect(next.record.data.title).toBe("two");
    expect(next.meta.tabs.t.seq).toBe(2);
  });
});

describe("transact(): one transaction", () => {
  const KEY = "clay:visitor-drafts:s@/";
  const open = (factory) => openDrafts({ factory, keyRange: IDBKeyRange });
  const input = (extra) => () => ({ ...TOOLS, seed: SEED, now: NOW, newId: ids(), ...extra });
  const chain = (tab, ...ops) => ({ tab, reset: "", ops });

  test("a transaction that fails after its writes are queued leaves nothing behind", async () => {
    const factory = new IDBFactory();
    const drafts = await open(factory);
    await transact(drafts, KEY, input({ chains: [chain("t", op(1, { title: "kept" }))] }));
    await drafts.putRow(rowKey(KEY, "u"), JSON.stringify(chain("u", op(1, { note: "row" }))));
    const before = await drafts.readAll(KEY);
    const poisoned = { change: (key, build) => drafts.change(key, (raw) => { const planned = build(raw); planned.puts.push([key + ":poison", () => {}]); return planned; }) };
    await expect(transact(poisoned, KEY, input({ chains: [chain("t", op(2, { title: "lost" }, { ...SEED, title: "kept" }))] }))).rejects.toMatchObject({ code: "uncloneable" });
    expect(await drafts.readAll(KEY)).toEqual(before);
    drafts.close();
  });

  test("a build that throws aborts the transaction and rejects with a code", async () => {
    const drafts = await open(new IDBFactory());
    await expect(transact(drafts, KEY, () => { throw new Error("no"); })).rejects.toMatchObject({ code: "error" });
    expect((await drafts.readAll(KEY)).size).toBe(0);
    drafts.close();
  });

  test("rows are deleted once settled and kept while an operation in them still waits", async () => {
    const drafts = await open(new IDBFactory());
    await drafts.putRow(rowKey(KEY, "done"), JSON.stringify(chain("done", op(1, { title: "applied" }))));
    await drafts.putRow(rowKey(KEY, "gap"), JSON.stringify(chain("gap", op(2, { note: "waits for 1" }))));
    await drafts.putRow(rowKey(KEY, "old"), JSON.stringify({ tab: "old", reset: "0~gone", ops: [op(1, { note: "ended" })] }));
    await transact(drafts, KEY, input());
    const all = await drafts.readAll(KEY);
    expect([...all.keys()].sort()).toEqual([KEY, rowKey(KEY, "gap"), metaKey(KEY), KEY + ":recovery:op:old:1"].sort());
    expect(JSON.parse(all.get(KEY + ":recovery:op:old:1")).ops[0].keys.note.m).toBe("ended");
    expect(JSON.parse(all.get(KEY)).data.title).toBe("applied");
    drafts.close();
  });

  test("each conflict copy is kept under its own id, and :conflict names the latest", async () => {
    const drafts = await open(new IDBFactory());
    await transact(drafts, KEY, input({ newId: () => "first", chains: [chain("a", op(1, { title: "a" }))] }));
    await transact(drafts, KEY, input({ newId: () => "second", chains: [chain("b", op(1, { title: "b" }))] }));
    await transact(drafts, KEY, input({ newId: () => "third", chains: [chain("c", op(1, { title: "c" }))] }));
    const all = await drafts.readAll(KEY);
    expect(JSON.parse(all.get(conflictKey(KEY, "first"))).data.title).toBe("a");
    expect(JSON.parse(all.get(conflictKey(KEY, "second"))).data.title).toBe("b");
    expect(JSON.parse(all.get(conflictKey(KEY))).id).toBe("second");
    expect(JSON.parse(all.get(KEY)).data.title).toBe("c");
    drafts.close();
  });

  test("putRow writes only a tab's own row", async () => {
    const drafts = await open(new IDBFactory());
    await expect(drafts.putRow(KEY, "{}")).rejects.toMatchObject({ code: "bad-op" });
    await expect(drafts.putRow(metaKey(KEY), "{}")).rejects.toMatchObject({ code: "bad-op" });
    await drafts.putRow(rowKey(KEY, "t"), "{}");
    expect([...(await drafts.readAll(KEY)).keys()]).toEqual([rowKey(KEY, "t")]);
    drafts.close();
  });
});
