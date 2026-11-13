import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { A, bootPage, cacheOf, noDatabase, pause, slowFactory, type, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

for (const early of [false, true]) {
  test(`Start over clears the localStorage fallback after an open failure (pressed during open: ${early})`, async () => {
    const { factory, state } = slowFactory(new IDBFactory(), early ? 100 : 10, { fail: true });
    useFactory(factory);
    const page = await bootPage({ slot: "r6-reset-no-open-" + early, localRaw: cacheOf(A) });
    if (!early) {
      await waitFor(() => state.opened, "failed open");
      await pause();
      type("saved in the localStorage fallback");
      expect((await page.clay.save()).ok).toBe(true);
      expect(JSON.parse(page.local()).data.note).toBe("saved in the localStorage fallback");
    }
    const real = window.location;
    let reloads = 0;
    Object.defineProperty(window, "location", { configurable: true, value: {
      href: real.href, pathname: real.pathname, search: real.search, hash: real.hash, origin: real.origin,
      reload() { reloads++; },
    } });
    try {
      expect(page.clay.visitorDrafts.reset()).toBe(true);
      await waitFor(() => reloads > 0 || page.count("clay:drafts-store-failed") > 0, "fallback reset");
      expect(state.opened).toBe(true);
      expect(reloads).toBe(1);
      expect(page.local()).toBe(null);
      expect(page.count("clay:drafts-store-failed")).toBe(0);
      expect(page.clay.hasUnsavedChanges()).toBe(false);
    } finally { Object.defineProperty(window, "location", { value: real, configurable: true }); }
  });
}
