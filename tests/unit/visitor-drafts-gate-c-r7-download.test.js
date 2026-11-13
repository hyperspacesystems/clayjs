import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { A, bootPage, cacheOf, failingFactory, noDatabase, pause, readIdb, type } from "./helpers/visitor-drafts-idb.js";
import { useFactory } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

test("new edits after an incompatible draft was parked still get a current-page recovery download", async () => {
  const real = new IDBFactory();
  const { factory, state } = failingFactory(real);
  useFactory(factory);
  const incompatible = { ...A, data: { oldFieldName: "old draft, retained aside" } };
  const page = await bootPage({ slot: "r6-parked-download", localRaw: cacheOf(incompatible) });
  const { ready } = await import("../../src/plugins/visitor-drafts.js");
  const prompt = await ready;
  expect(page.clay.visitorDrafts.restored()).toMatchObject({ restored: false, hadDraft: true, parked: true });
  type("new work saved successfully");
  expect((await page.clay.save()).ok).toBe(true);
  expect((await readIdb(real, page.key)).record.data.note).toBe("new work saved successfully");
  state.fail = true;
  type("new work since storage failed " + "Z".repeat(600 * 1024));
  expect((await page.clay.save()).ok).toBe(false);
  expect(page.slots()).toEqual([]);
  expect(page.clay.hasUnsavedChanges()).toBe(true);
  const link = prompt.root.querySelector("[data-hcp-link]");
  const clicks = [], blobs = [], downloads = [];
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { blobs.push(blob); return "blob:r6-parked"; };
  URL.revokeObjectURL = () => {};
  const watch = (event) => {
    if (event.composedPath().includes(link)) clicks.push(event.defaultPrevented);
    else if (event.target.matches?.("a[download]")) downloads.push(event.target.download);
    event.preventDefault();
  };
  document.addEventListener("click", watch);
  try {
    link.click();
    await page.clay.visitorDrafts.download();
    await pause();
    expect(blobs.length).toBe(2);
    expect(clicks).toEqual([true, true]);
    expect(downloads).toHaveLength(2);
    for (const blob of blobs) {
      const html = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsText(blob); });
      expect(html).toContain("Z".repeat(600 * 1024));
    }
  } finally {
    document.removeEventListener("click", watch);
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});
