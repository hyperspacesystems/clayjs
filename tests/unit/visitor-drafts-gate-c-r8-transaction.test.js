/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { openDrafts } from "../../src/plugins/visitor-drafts/idb.js";
import { commit, recoveryMark, transact } from "../../src/plugins/visitor-drafts/commit.js";
import { merge3, unitMark } from "../../src/plugins/visitor-drafts/store.js";

const record = { v: 1, id: "old", savedAt: "before", ancestry: ["root:"], data: { title: "discarded" } };
const meta = { gen: 1, rev: 1, reset: "", tabs: {}, foreign: null, unit: null };
const options = { seed: { title: "owner" }, now: 1, newId: () => "new", merge3, unitMark };
const chain = (reset, title) => ({ tab: "writer", reset, acked: 0, at: 1, ops: [{ seq: 1, savedAt: "typed", keys: { title: { b: "owner", m: title } } }] });

test("a marker applies once, including after a later numbered reset", () => {
  const first = commit({ meta, record }, { ...options, marker: "bare" });
  expect(first.meta.ended).toEqual([""]);
  const second = commit(first, { ...options, marker: "3~later", chains: [chain("3~later", "newest typing")] });
  expect(second.meta.ended).toEqual(["", "bare"]);
  const repeated = commit(second, { ...options, marker: "bare" });
  expect(repeated.meta).toEqual(second.meta);
  expect(repeated.record).toEqual(second.record);
  expect(repeated.changed).toBe(false);
  const stale = chain("bare", "discarded journal");
  const delivered = commit(repeated, { ...options, marker: "bare", chains: [stale] });
  expect(delivered.record).toEqual(second.record);
  expect(delivered.recovered).toEqual([stale]);
  expect(delivered.stale).toEqual(["writer"]);
  const again = commit(delivered, { ...options, marker: "bare", chains: [stale] });
  expect(again.record).toEqual(second.record);
  expect(again.recovered).toEqual([]);
  expect(again.changed).toBe(false);
});

test("a matching journal joins the new generation while the earlier record stays in recovery", () => {
  const fresh = chain("bare", "fresh typing");
  const result = commit({ meta, record }, { ...options, marker: "bare", chains: [fresh] });
  expect(result.record.data.title).toBe("fresh typing");
  expect(result.meta.tabs.writer.seq).toBe(1);
  expect(result.recovered).toEqual([record]);
  expect(result.stale).toEqual([]);
  const again = commit(result, { ...options, marker: "bare", chains: [fresh] });
  expect(again.record).toEqual(result.record);
  expect(again.recovered).toEqual([]);
});

test("a foreign save rooted after the marker is active and retains its whole page", () => {
  const local = { v: 1, id: "fresh-foreign", savedAt: "after", ancestry: ["other-save", "root:bare"], data: { title: "fresh old-tab typing" }, live: { page: { text: "fresh page" } }, blockeditor: { rev: "fresh", html: "<p>fresh page</p>" } };
  const result = commit({ meta, record }, { ...options, marker: "bare", local });
  expect(result.record).toEqual(local);
  expect(result.recovered).toEqual([record]);
  expect(result.meta.foreign).toBe(local.id);
  expect(result.meta.unit).toBe(unitMark(local));
});

test("a foreign copy already taken in is not preserved a second time at reset", () => {
  const local = { ...record, id: "foreign", data: { title: "already taken in" } };
  const result = commit({ meta: { ...meta, foreign: local.id }, record }, { ...options, marker: "bare", local });
  expect(result.recovered).toEqual([record]);
  expect(result.meta.recovery).toEqual([record.id]);
  expect(result.record).toBe(null);
});

test("a refused recovery write keeps the ended journal and database unchanged until retry", async () => {
  const drafts = await openDrafts({ factory: new IDBFactory(), keyRange: IDBKeyRange });
  const key = "clay:visitor-drafts:r8@/";
  const journal = chain("", "typing before reset");
  journal.ops[0].unit = { seen: null, to: { live: { page: { text: "page typing" } }, blockeditor: { rev: "typed", html: "<p>page typing</p>" } } };
  const slot = key + ":op:" + journal.tab;
  await drafts.change(key, () => ({ puts: [[key, JSON.stringify(record)], [key + ":meta", JSON.stringify(meta)], [slot, JSON.stringify(journal)]], deletes: [] }));
  const before = await drafts.readAll(key);
  let poisoned = false;
  const refuse = { change: (name, build) => drafts.change(name, (raw) => {
    const next = build(raw);
    const copy = next.puts.find(([row]) => row === key + ":recovery:" + recoveryMark(journal));
    expect(copy).toBeDefined();
    copy[1] = () => {};
    poisoned = true;
    return next;
  }) };
  const input = () => ({ ...options, marker: "bare" });
  await expect(transact(refuse, key, input)).rejects.toMatchObject({ code: "uncloneable" });
  expect(poisoned).toBe(true);
  expect(await drafts.readAll(key)).toEqual(before);
  await transact(drafts, key, input);
  const after = await drafts.readAll(key);
  expect(after.has(slot)).toBe(false);
  expect(JSON.parse(after.get(key + ":recovery:" + recoveryMark(journal)))).toEqual(journal);
  expect(after.has(key)).toBe(false);
  drafts.close();
});
