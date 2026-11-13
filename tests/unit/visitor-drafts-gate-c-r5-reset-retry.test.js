import { afterEach, expect, jest, test } from "@jest/globals";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { openDrafts } from "../../src/plugins/visitor-drafts/idb.js";
import { transact } from "../../src/plugins/visitor-drafts/commit.js";
import { merge3, unitMark } from "../../src/plugins/visitor-drafts/store.js";
import { A, SERVED, bootPage, cacheOf, failingFactory, keyFor, noDatabase, otherTab, readIdb, seedIdb, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

const OLD_MARKER = "legacy-marker";

async function failedBoot(slot) {
  const real = new IDBFactory();
  const key = keyFor(slot);
  await seedIdb(real, key, { record: A, meta: { gen: 8, reset: OLD_MARKER } });
  const raw = cacheOf(A, { rev: 1, reset: OLD_MARKER });
  localStorage.clear();
  localStorage.setItem(key, raw);
  localStorage.setItem(key + ":reset", OLD_MARKER);
  const { factory, state } = failingFactory(real);
  const control = { attempts: 0, recovered: false, beforeRetry: null };
  Object.defineProperty(state, "fail", { get() {
    control.attempts++;
    if (control.attempts === 2) control.beforeRetry?.();
    return !control.recovered;
  } });
  useFactory(factory);
  const page = await bootPage({ slot, keep: true });
  const { ready } = await import("../../src/plugins/visitor-drafts.js");
  const prompt = await ready;
  await waitFor(() => control.attempts === 1, "failed first transaction");
  expect(document.getElementById("title").textContent).toBe(A.data.title);
  expect(page.count("clay:drafts-store-failed")).toBe(0);
  return { ...page, real, raw, control, prompt };
}

function reloads() {
  const real = window.location;
  const calls = [];
  Object.defineProperty(window, "location", { configurable: true, value: {
    href: real.href, pathname: real.pathname, search: real.search, hash: real.hash, origin: real.origin,
    reload() { calls.push(true); },
  } });
  return { calls, restore: () => Object.defineProperty(window, "location", { value: real, configurable: true }) };
}

function expectFailure(page, code) {
  expect(page.events.filter((event) => event.name === "clay:drafts-store-failed")).toHaveLength(1);
  expect(page.events.find((event) => event.name === "clay:drafts-store-failed").detail.error.code).toBe(code);
  expect(page.prompt.root.hidden).toBe(false);
  expect(page.prompt.root.getAttribute("data-hcp-state")).toBe("card");
  expect(page.prompt.root.getAttribute("data-hcp-reason")).toBe("error");
  expect(page.prompt.root.querySelector(".hcp-body [data-hcp-for='error']").textContent).toBe("Storage is full or turned off here. Download the file to keep what you've done.");
}

test("an unreadable retry refuses Start over once, preserves the record and cache, and shows the existing failure message", async () => {
  const page = await failedBoot("r5-reset-retry-refused");
  const before = await readIdb(page.real, page.key);
  const reload = reloads();
  try {
    expect(page.clay.visitorDrafts.reset()).toBe(true);
    await waitFor(() => page.count("clay:drafts-store-failed") > 0, "reset refusal");
    expect(page.control.attempts).toBe(2);
    expectFailure(page, "quota");
    expect(reload.calls).toHaveLength(0);
    expect(page.local()).toBe(page.raw);
    expect(page.local(":reset")).toBe(OLD_MARKER);
    expect(await readIdb(page.real, page.key)).toEqual(before);
  } finally { reload.restore(); }
});

test("storage that recovers after boot lets Start over read its generation and publish a numbered marker without an intervening reload", async () => {
  const page = await failedBoot("r5-reset-retry-recovered");
  page.control.recovered = true;
  const reload = reloads();
  try {
    page.clay.visitorDrafts.reset();
    await waitFor(() => reload.calls.length === 1, "successful reset reload");
    const after = await readIdb(page.real, page.key);
    expect(page.control.attempts).toBe(3);
    expect(page.count("clay:drafts-store-failed")).toBe(0);
    expect(after.record).toBe(null);
    expect(after.meta.gen).toBe(9);
    expect(after.meta.reset).toMatch(/^9~/);
    expect(page.local(":reset")).toBe(after.meta.reset);
    expect(page.local()).toBe(null);
  } finally { reload.restore(); }
});

test.each([false, true])("newer work committed by another tab during the retry keeps its record and cache when the local marker is stale (marker write refused: %s)", async (refuseRepair) => {
  const page = await failedBoot("r5-reset-retry-newer-" + refuseRepair);
  const writer = await openDrafts({ factory: page.real, keyRange: IDBKeyRange });
  let newer;
  page.control.recovered = true;
  page.control.beforeRetry = () => {
    newer = transact(writer, page.key, () => ({
      seed: SERVED, merge3, unitMark, now: Date.now(), newId: () => "newer-copy",
      resets: [{ ends: 8, marker: "9~other" }],
      chains: [{ tab: "other", reset: "9~other", ops: [{ seq: 1, keys: { note: { b: SERVED.note, m: "new work during retry" } } }] }],
    })).then((result) => {
      localStorage.setItem(page.key, cacheOf(result.record, { rev: result.meta.rev, reset: result.meta.reset }));
      return result;
    });
  };
  const setItem = Storage.prototype.setItem;
  const writes = jest.spyOn(Storage.prototype, "setItem").mockImplementation(function (name, value) {
    if (refuseRepair && name === page.key + ":reset") throw Object.assign(new Error("full"), { name: "QuotaExceededError" });
    return setItem.call(this, name, value);
  });
  const reload = reloads();
  try {
    page.clay.visitorDrafts.reset();
    await waitFor(() => reload.calls.length === 1 || page.count("clay:drafts-store-failed") > 0, "stale reset settlement");
    expect(newer).toBeDefined();
    const committed = await newer;
    expect(committed.record.data.note).toBe("new work during retry");
    const after = await readIdb(page.real, page.key);
    expect(after.meta).toEqual(committed.meta);
    expect(after.record).toEqual(committed.record);
    expect(page.local()).toBe(cacheOf(committed.record, { rev: committed.meta.rev, reset: "9~other" }));
    expect(page.control.attempts).toBe(3);
    if (refuseRepair) {
      expect(page.count("clay:drafts-store-failed")).toBe(0);
      expect(reload.calls).toHaveLength(1);
      expect(page.local(":reset")).toBe(OLD_MARKER);
    } else {
      const reopened = await otherTab(page.real, page.key, { reset: "9~other", announce: false });
      expect(reopened.record).toEqual(committed.record);
      expect(reopened.meta).toEqual(committed.meta);
      expect(page.local(":reset")).toBe("9~other");
      expect(page.count("clay:drafts-store-failed")).toBe(0);
      expect(reload.calls).toHaveLength(1);
    }
  } finally { writes.mockRestore(); writer.close(); reload.restore(); }
});

test("a queued retry reaches its two-second deadline and cannot reset the draft after the blocker releases", async () => {
  const page = await failedBoot("r5-reset-retry-deadline");
  const before = await readIdb(page.real, page.key);
  page.control.recovered = true;
  const db = await new Promise((resolve, reject) => {
    const req = page.real.open("clay-visitor-drafts", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  let release = false;
  const blocker = db.transaction("records", "readwrite");
  const store = blocker.objectStore("records");
  function hold() { store.get(page.key).onsuccess = () => { if (!release) hold(); }; }
  hold();
  const completed = new Promise((resolve) => { blocker.oncomplete = resolve; });
  const reload = reloads();
  try {
    const started = Date.now();
    page.clay.visitorDrafts.reset();
    await waitFor(() => page.count("clay:drafts-store-failed") > 0, "retry deadline", 3500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    expect(page.control.attempts).toBe(2);
    expectFailure(page, "blocked");
    expect(reload.calls).toHaveLength(0);
    expect(page.local()).toBe(page.raw);
    expect(page.local(":reset")).toBe(OLD_MARKER);
  } finally {
    release = true;
    await completed;
    db.close();
    reload.restore();
  }
  expect(await readIdb(page.real, page.key)).toEqual(before);
  expect(page.local()).toBe(page.raw);
  expect(page.local(":reset")).toBe(OLD_MARKER);
  expect(reload.calls).toHaveLength(0);
});
