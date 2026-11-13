import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { A, big, bootPage, headFor, keyFor, noDatabase, readIdb, seedIdb, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

test("a blocked first transaction ends the large restore wait and preserves the unread draft", async () => {
  const factory = new IDBFactory();
  const slot = "r5-first-transaction-deadline";
  const key = keyFor(slot);
  const record = { ...A, data: { ...A.data, note: big("R") } };
  await seedIdb(factory, key, { record });
  const raw = headFor(record);
  const db = await new Promise((resolve, reject) => {
    const req = factory.open("clay-visitor-drafts", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  let release = false;
  const tx = db.transaction("records", "readwrite");
  const store = tx.objectStore("records");
  function hold() { store.get(key).onsuccess = () => { if (!release) hold(); }; }
  hold();
  const completed = new Promise((resolve) => { tx.oncomplete = resolve; });
  useFactory(factory);
  let loaded;
  const started = Date.now();
  const booting = bootPage({ slot, localRaw: raw }).then((result) => { loaded = result; });
  try {
    await waitFor(() => loaded, "loader to continue after the transaction deadline", 3500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(loaded.clay.visitorDrafts.restored()).toMatchObject({ restored: false, hadDraft: true, blocked: true });
    expect(loaded.local()).toBe(raw);
    expect(loaded.count("clay:drafts-store-failed")).toBeGreaterThan(0);
    expect(loaded.clay.visitorDrafts.saveNow()).toBe(false);
    expect((await loaded.clay.save()).ok).toBe(false);
    expect(loaded.local()).toBe(raw);
  } finally {
    release = true;
    await completed;
    db.close();
    await booting;
  }
  expect((await readIdb(factory, key)).record).toEqual(record);
  expect(document.getElementById("note").value).toBe("owner note");
});
