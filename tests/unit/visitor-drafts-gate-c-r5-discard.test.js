import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { bootPage, failingFactory, noDatabase, type, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

function leave() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

test("Start over after a failed save clears the failure and reloads without a leave warning", async () => {
  const { factory, state } = failingFactory(new IDBFactory());
  useFactory(factory);
  const { clay, slots } = await bootPage({ slot: "r5-discard-failed-save" });
  type("saved before");
  expect((await clay.save()).ok).toBe(true);
  state.fail = true;
  type("failed edit");
  expect((await clay.save()).ok).toBe(false);
  expect(clay.hasUnsavedChanges()).toBe(true);
  expect(leave()).toBe(true);
  expect(slots()).toHaveLength(1);
  state.fail = false;
  const real = window.location;
  const asked = [];
  Object.defineProperty(window, "location", { configurable: true, value: {
    href: real.href, pathname: real.pathname, search: real.search, hash: real.hash, origin: real.origin,
    reload() { asked.push(leave()); window.dispatchEvent(new Event("pagehide")); },
  } });
  try {
    expect(clay.visitorDrafts.reset()).toBe(true);
    await waitFor(() => asked.length > 0, "reload");
    expect(asked).toEqual([false]);
    expect(clay.hasUnsavedChanges()).toBe(false);
    expect(slots()).toEqual([]);
  } finally { Object.defineProperty(window, "location", { value: real, configurable: true }); }
});
