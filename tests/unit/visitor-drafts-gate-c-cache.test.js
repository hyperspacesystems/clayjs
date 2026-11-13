import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { B, big, bootPage, noDatabase, readIdb, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

test.each([false, true])("Gate C round 1 compatibility control: migration and later saves keep data.look in the cache, large draft %s", async (large) => {
  const factory = new IDBFactory();
  useFactory(factory);
  const record = { ...B, data: { ...B.data, note: large ? big("n") : "a short note", look: { scheme: "dark", accent: "blue" } } };
  const { clay, key, local } = await bootPage({ slot: "gate-cache-look-" + large, localRaw: JSON.stringify(record) });
  await waitFor(() => Boolean(JSON.parse(local())?.w), "the marked migration cache");
  expect((await readIdb(factory, key)).record).toEqual(record);
  const cached = JSON.parse(local());
  expect(cached.data.look).toEqual(record.data.look);
  expect(cached.v).toBe(large ? 2 : 1);
  if (large) expect(cached.data.note).toBeUndefined();
  else expect(cached.data.note).toBe(record.data.note);
  expect(document.getElementById("note").value).toBe(record.data.note);

  document.getElementById("title").textContent = "a later title";
  expect((await clay.save()).ok).toBe(true);
  expect((await readIdb(factory, key)).record.data).toEqual({ ...record.data, title: "a later title" });
  expect(JSON.parse(local()).data.look).toEqual(record.data.look);
});
