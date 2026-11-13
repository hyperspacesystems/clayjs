import { beforeEach, afterEach, expect, jest, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { waitFor, useFactory, noDatabase } from "./helpers/visitor-drafts-idb.js";

const loaded = jest.fn();
const attach = jest.fn();
const recoveryDrafts = jest.fn();
jest.unstable_mockModule("../../src/plugins/visitor-drafts/recovery-menu.js", () => {
  loaded();
  return { attachRecoveryMenu: attach };
});
jest.unstable_mockModule("../../src/plugins/visitor-drafts.js", () => ({ recoveryDrafts }));

beforeEach(() => {
  jest.resetModules();
  loaded.mockClear();
  attach.mockReset();
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  window.clay = {};
  useFactory(new IDBFactory());
});
afterEach(() => { jest.restoreAllMocks(); noDatabase(); });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("startup and storage events leave recovery unloaded until Settings opens", async () => {
  const { start } = await import("../../src/plugins/menu/visitor.js");
  start();
  document.dispatchEvent(new CustomEvent("clay:drafts-saved"));
  window.dispatchEvent(new StorageEvent("storage", { key: "draft" }));
  await settle();
  expect(loaded).not.toHaveBeenCalled();
  expect(attach).not.toHaveBeenCalled();

  window.clay.menu.open();
  await waitFor(() => attach.mock.calls.length, "recovery menu attachment");
  expect(loaded).toHaveBeenCalledTimes(1);
  expect(attach).toHaveBeenCalledWith(expect.objectContaining({ beforeOpen: expect.any(Array) }), recoveryDrafts);
});

test("opening again during and after loading attaches recovery only once", async () => {
  const { start } = await import("../../src/plugins/menu/visitor.js");
  start();
  const menu = window.clay.menu;
  menu.open();
  menu.close();
  menu.open();
  await waitFor(() => attach.mock.calls.length, "recovery menu attachment");
  menu.close();
  menu.open();
  await settle();
  expect(loaded).toHaveBeenCalledTimes(1);
  expect(attach).toHaveBeenCalledTimes(1);
});

test("Settings leaves recovery unloaded when IndexedDB is unavailable", async () => {
  noDatabase();
  const { start } = await import("../../src/plugins/menu/visitor.js");
  start();
  window.clay.menu.open();
  await settle();
  expect(loaded).not.toHaveBeenCalled();
  expect(attach).not.toHaveBeenCalled();
});

test("a failed attachment can retry on the next Settings opening", async () => {
  const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
  attach.mockImplementationOnce(() => { throw new Error("load interrupted"); });
  const { start } = await import("../../src/plugins/menu/visitor.js");
  start();
  const menu = window.clay.menu;
  menu.open();
  await waitFor(() => warning.mock.calls.length, "recovery load failure");
  menu.close();
  menu.open();
  await waitFor(() => attach.mock.calls.length === 2, "recovery retry");
  expect(warning).toHaveBeenCalledTimes(1);
});
