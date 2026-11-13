/**
 * The Gate C findings of rounds 1 to 4 that are about the loader's own API (the save
 * transport, `saveNow()`, `download()`, the close warning, the prompt's rescue download),
 * as their stories, through the real loader on the rebuilt drafts. The others are in
 * `visitor-drafts-gate-c.test.js`.
 *
 * The first test counts `clay:drafts-saved` events, so it boots first: every boot's store
 * stays on the shared document and would answer a later test's page-hide with its own save.
 */
import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { B, big, bootPage, failingFactory, headFor, keyFor, noDatabase, otherTab, pause, readIdb, type, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

const promptRoot = () => document.querySelector('clay-editor-ui[data-clay-ui="download-prompt"]')?.shadowRoot?.getElementById("hcp") ?? null;

function watchDownload() {
  const clicks = [];
  const onClick = (event) => {
    if (!event.composedPath().some((node) => typeof node.hasAttribute === "function" && node.hasAttribute("data-hcp-link"))) return;
    clicks.push({ held: event.defaultPrevented });
    event.preventDefault();
  };
  document.addEventListener("click", onClick);
  return { clicks, stop: () => document.removeEventListener("click", onClick) };
}

test("round 1 finding 1, round 2 finding 4, round 3 finding 5: while the database refuses, nothing says saved, Download free stays the rescue download, and a save with no new typing sends the work once it can", async () => {
  const base = new IDBFactory();
  const { factory, state } = failingFactory(base);
  useFactory(factory);
  const { clay, key, count } = await bootPage({ slot: "gate-retry-1" });
  await waitFor(() => promptRoot() !== null, "the download prompt");
  await pause();
  const watch = watchDownload();
  try {
    state.fail = true;
    type(big("x", 600 * 1024));
    expect((await clay.save()).ok).toBe(false);
    expect(clay.hasUnsavedChanges()).toBe(true);
    await waitFor(() => promptRoot().getAttribute("data-hcp-reason") === "error", "the prompt's error");

    // An app control retries through saveNow(): a note this large is not in the journal either.
    expect(clay.visitorDrafts.saveNow()).toBe(false);
    await pause();
    expect(count("clay:drafts-saved")).toBe(0);
    expect(promptRoot().getAttribute("data-hcp-reason")).toBe("error");
    promptRoot().querySelector("[data-hcp-link]").click();
    await pause();
    expect(watch.clicks).toEqual([{ held: true }]);

    // Saving again with nothing new typed: still refused, still not saved.
    expect((await clay.save()).ok).toBe(false);
    expect(clay.hasUnsavedChanges()).toBe(true);
    expect(count("clay:drafts-saved")).toBe(0);
    expect((await readIdb(base, key)).record).toBe(null);

    state.fail = false;
    expect((await clay.save()).ok).toBe(true);
    expect((await readIdb(base, key)).record.data.note.length).toBe(600 * 1024);
    expect(clay.hasUnsavedChanges()).toBe(false);
    expect(count("clay:drafts-saved")).toBe(1);
    expect(promptRoot().getAttribute("data-hcp-reason")).not.toBe("error");
  } finally {
    watch.stop();
    state.fail = false;
  }
}, 20000);

test("round 1 finding 4: with a head and no database, saveNow(), download() and the page-hide flush write nothing over the unread draft", async () => {
  useFactory({ open: () => { throw new Error("no database"); } });
  const raw = headFor(B);
  const { clay, local } = await bootPage({ slot: "gate-refused-1", localRaw: raw });
  const watch = watchDownload();
  try {
    expect(clay.visitorDrafts.restored()).toMatchObject({ restored: false, hadDraft: true, blocked: true });
    type("typed over a draft this page cannot read");
    expect(clay.visitorDrafts.saveNow()).toBe(false);
    await clay.visitorDrafts.download();
    window.dispatchEvent(new Event("pagehide"));
  } finally {
    watch.stop();
  }
  expect(local()).toBe(raw);
  expect(Object.keys(localStorage).filter((name) => name.startsWith(keyFor("gate-refused-1")) && !name.endsWith(":ui"))).toEqual([keyFor("gate-refused-1")]);
});

test("round 4 Astra 4: Download copy reaches its flush and its link without an error", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const { clay, key } = await bootPage({ slot: "gate-download-1" });
  await pause();
  const watch = watchDownload();
  let problem = null;
  try {
    type("a note to keep in the download");
    try { await clay.visitorDrafts.download(); } catch (error) { problem = `${error.name}: ${error.message}`; }
  } finally {
    watch.stop();
  }
  expect(problem).toBe(null);
  expect(watch.clicks).toEqual([{ held: false }]);
  expect((await readIdb(factory, key)).record.data.note).toBe("a note to keep in the download");
});


test.each(["saveNow", "save and pagehide"])("round 4 Astra 1 through the loader: an intentional revert survives the in-flight save, %s", async (mode) => {
  const factory = new IDBFactory();
  useFactory(factory);
  const { clay, key, slots } = await bootPage({ slot: "gate-inflight-" + mode.replaceAll(" ", "-") });
  await pause();
  const getItem = Storage.prototype.getItem;
  let reverted = false;
  let secondSaved;
  Storage.prototype.getItem = function (name) {
    const value = getItem.call(this, name);
    if (name === key + ":reset" && !reverted) {
      reverted = true;
      queueMicrotask(() => {
        type("owner note");
        if (mode === "saveNow") secondSaved = clay.visitorDrafts.saveNow();
        else window.dispatchEvent(new Event("pagehide"));
      });
    }
    return value;
  };
  try {
    type("temporary text I then undo");
    if (mode === "saveNow") expect(clay.visitorDrafts.saveNow()).toBe(true);
    else expect((await clay.save()).ok).toBe(true);
    await waitFor(async () => (await readIdb(factory, key)).meta.rev === 2, "both sequential operations");
    expect(reverted).toBe(true);
    if (mode === "saveNow") expect(secondSaved).toBe(true);
    await waitFor(() => slots().length === 0, "the second acknowledgement");
    expect((await readIdb(factory, key)).record.data.note).toBe("owner note");
    expect(document.getElementById("note").value).toBe("owner note");
    expect(clay.hasUnsavedChanges()).toBe(false);
  } finally {
    Storage.prototype.getItem = getItem;
  }
});

test("round 4 Astra 2 and Opus N1/N2 through the loader: catching up merges a committed title and another tab's journal", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const { clay, key } = await bootPage({ slot: "gate-catchup-loader" });
  await pause();
  localStorage.setItem(key + ":op:third", JSON.stringify({
    tab: "third", reset: "", acked: 0, at: Date.now(),
    ops: [{ seq: 1, keys: { note: { b: "owner note", m: "third tab note" } } }],
  }));
  await otherTab(factory, key, {
    tab: "second", announce: false,
    ops: [{ seq: 1, keys: { title: { b: "owner title", m: "second tab title" } } }],
  });
  expect(document.getElementById("title").textContent).toBe("owner title");
  window.dispatchEvent(new StorageEvent("storage", { key }));
  await waitFor(() => document.getElementById("note").value === "third tab note", "catch-up of the journal");
  const saved = await readIdb(factory, key);
  expect(saved.record.data).toMatchObject({ title: "second tab title", note: "third tab note" });
  expect(saved.meta.rev).toBe(2);
  expect(saved.meta.tabs.third.seq).toBe(1);
  expect(saved.conflict).toBe(null);
  expect(document.getElementById("title").textContent).toBe("second tab title");
  type("a later local note");
  expect((await clay.save()).ok).toBe(true);
  expect((await readIdb(factory, key)).record.data).toMatchObject({ title: "second tab title", note: "a later local note" });
});


test("round 2 Astra 1 through the loader: pagehide saves newer typing after the in-flight transaction aborts", async () => {
  const real = new IDBFactory();
  const state = { armed: false, aborted: false };
  useFactory({
    open(name, version) {
      const req = real.open(name, version);
      const fake = {};
      req.onupgradeneeded = (event) => { fake.result = req.result; fake.onupgradeneeded?.(event); };
      req.onsuccess = (event) => {
        const db = req.result;
        const transaction = db.transaction.bind(db);
        db.transaction = (stores, mode) => {
          const tx = transaction(stores, mode);
          if (state.armed && mode === "readwrite") {
            const objectStore = tx.objectStore.bind(tx);
            tx.objectStore = (name) => {
              const store = objectStore(name);
              const put = store.put.bind(store);
              store.put = (...args) => {
                const request = put(...args);
                if (state.armed) {
                  state.armed = false;
                  queueMicrotask(() => {
                    tx.abort();
                    state.aborted = true;
                    type(big("b", 600 * 1024));
                    window.dispatchEvent(new Event("pagehide"));
                  });
                }
                return request;
              };
              return store;
            };
          }
          return tx;
        };
        fake.result = db;
        fake.onsuccess?.(event);
      };
      req.onerror = (event) => { fake.error = req.error; fake.onerror?.(event); };
      return fake;
    },
  });
  const { clay, key } = await bootPage({ slot: "gate-abort-pagehide" });
  await pause();
  state.armed = true;
  type(big("a", 600 * 1024));
  expect((await clay.save()).ok).toBe(false);
  expect(state.aborted).toBe(true);
  await waitFor(async () => (await readIdb(real, key)).record?.data.note === big("b", 600 * 1024), "the newer pagehide operation");
  const beforeRetry = await readIdb(real, key);
  expect(beforeRetry.meta.rev).toBe(2);
  expect((await clay.save()).ok).toBe(true);
  const afterRetry = await readIdb(real, key);
  expect(afterRetry.record.data.note).toBe(big("b", 600 * 1024));
  expect(afterRetry.meta.rev).toBe(beforeRetry.meta.rev);
  expect(document.getElementById("note").value).toBe(big("b", 600 * 1024));
  expect(clay.hasUnsavedChanges()).toBe(false);
});
