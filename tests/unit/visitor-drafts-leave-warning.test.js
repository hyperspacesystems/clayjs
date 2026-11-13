/**
 * The leave warning of a page on the draft database (05b, David's choice 4): an operation
 * its tab's journal slot holds in full counts as saved, so closing after ordinary typing
 * does not ask; the browser asks only while an operation too large for the slot is not yet
 * in the database. One boot in this file: every boot's listeners stay on the window.
 */
import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { big, bootPage, noDatabase, pause, readIdb, type, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

afterEach(noDatabase);

function leave() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

test("closing after small typing does not ask; closing while a large field is uncommitted asks, until the database has it", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const { clay, key, slots } = await bootPage({ slot: "leave-1" });
  const { flushDraft } = await import("../../src/core/draft-mode.js");
  await pause();

  type("a short note");
  expect(leave()).toBe(false);
  expect(slots().length).toBe(1);
  expect(clay.hasUnsavedChanges()).toBe(false);
  await waitFor(async () => (await readIdb(factory, key)).record?.data.note === "a short note", "the short note in the database");
  await waitFor(() => slots().length === 0, "the journal slot to go");

  type(big("x", 600 * 1024));
  expect(flushDraft()).toBe(false);
  expect(leave()).toBe(true);
  expect(slots()).toEqual([]);
  expect(clay.hasUnsavedChanges()).toBe(true);
  await waitFor(async () => (await readIdb(factory, key)).record?.data.note.length === 600 * 1024, "the large note in the database");
  await waitFor(() => !clay.hasUnsavedChanges(), "the operation to be confirmed");
  expect(flushDraft()).toBe(true);
  expect(leave()).toBe(false);
}, 15000);
