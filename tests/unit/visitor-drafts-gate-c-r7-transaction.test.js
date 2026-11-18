/** @jest-environment node */
import { expect, test } from "@jest/globals";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { openDrafts } from "../../src/plugins/visitor-drafts/idb.js";
import {
  RECOVERY_KEEP,
  transact,
} from "../../src/plugins/visitor-drafts/commit.js";
import { merge3, unitMark } from "../../src/plugins/visitor-drafts/store.js";

const key = "clay:visitor-drafts:r7@/";
const copy = (id) => ({ v: 1, id, savedAt: id, ancestry: [], data: { title: id }, live: { page: { id } }, blockeditor: { rev: id, html: `<p>${id}</p>` } });
const options = { seed: { title: "owner" }, now: 1, newId: () => "new", merge3, unitMark };

test.each(["bare", "99~unobserved"])("an unverified marker %s preserves both whole records and bounds recovery atomically", async (marker) => {
  const drafts = await openDrafts({ factory: new IDBFactory(), keyRange: IDBKeyRange });
  const record = copy("stored");
  const foreign = copy("foreign");
  const older = Array.from({ length: RECOVERY_KEEP }, (_, i) => "prior" + i);
  const meta = { gen: 9, rev: 4, reset: "9~current", tabs: {}, unit: unitMark(record), foreign: null, recovery: older };
  await drafts.change(key, () => ({ puts: [[key, JSON.stringify(record)], [key + ":meta", JSON.stringify(meta)], ...older.map((id) => [key + ":recovery:" + id, JSON.stringify(copy(id))])], deletes: [] }));
  const before = await drafts.readAll(key);
  let poisoned = false;
  const refusing = { change: (name, build) => drafts.change(name, (raw) => {
    const next = build(raw);
    const recovery = next.puts.find(([row]) => row === key + ":recovery:stored");
    expect(recovery).toBeDefined();
    recovery[1] = () => {};
    poisoned = true;
    return next;
  }) };
  const input = () => ({ ...options, marker, local: foreign });
  await expect(transact(refusing, key, input)).rejects.toMatchObject({ code: "uncloneable" });
  expect(poisoned).toBe(true);
  expect(await drafts.readAll(key)).toEqual(before);
  const result = await transact(drafts, key, input);
  const after = await drafts.readAll(key);
  const active = marker === "bare";
  expect(result.meta).toMatchObject({ gen: 10, reset: marker, recovery: active ? ["stored", ...older.slice(0, 7)] : ["foreign", "stored", ...older.slice(0, 6)] });
  expect(result.record).toEqual(active ? foreign : null);
  expect(JSON.parse(after.get(key + ":recovery:stored"))).toEqual(record);
  expect(JSON.parse(after.get(active ? key : key + ":recovery:foreign"))).toEqual(foreign);
  expect([...after.keys()].filter((row) => row.startsWith(key + ":recovery:"))).toHaveLength(8);
  expect(after.has(key)).toBe(active);
  await transact(drafts, key, input);
  expect(await drafts.readAll(key)).toEqual(after);
  drafts.close();
});
