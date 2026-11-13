import { afterEach, expect, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { bootPage, keyFor, seedIdb, useFactory, noDatabase, waitFor, SERVED } from "./helpers/visitor-drafts-idb.js";
import { $ } from "./helpers/editor-ui.js";

const params = "plugins=visitor-drafts,visitor-menu&exclude=richclay,source";
afterEach(() => noDatabase());

test("the real visitor menu opens this page's kept copies through the drafts plugin", async () => {
  const factory = new IDBFactory();
  useFactory(factory);
  const slot = "recovery-loader-present";
  const key = keyFor(slot);
  const copy = { v: 1, id: "earlier", savedAt: "2026-11-12T00:00:00Z", data: { ...SERVED, title: "earlier" } };
  await seedIdb(factory, key, { meta: { recovery: ["earlier"] }, rows: [[key + ":recovery:earlier", JSON.stringify(copy)]] });
  const tab = await bootPage({ slot, params });
  await waitFor(() => tab.clay.menu, "visitor menu");
  expect($('[data-menu-id="clay.earlier-drafts"]', "menu")).toBeNull();
  tab.clay.menu.open();
  await waitFor(() => $('[data-menu-id="clay.earlier-drafts"]', "menu"), "earlier drafts menu item");
  $('[data-menu-id="clay.earlier-drafts"]', "menu").click();
  await waitFor(() => document.querySelector("[data-draft-copies]"), "copy list");
  expect(document.querySelector('[data-draft-mark="earlier"]')).not.toBeNull();
  expect(tab.clay.visitorDrafts.active).toBe(true);
  expect(document.querySelector("#title").textContent).toBe("owner title");
});

test("the real menu with an empty database has no earlier drafts entry", async () => {
  useFactory(new IDBFactory());
  const tab = await bootPage({ slot: "recovery-loader-empty", params });
  await waitFor(() => tab.clay.menu, "visitor menu");
  const { recoveryDrafts } = await import("../../src/plugins/visitor-drafts.js");
  expect(await (await recoveryDrafts()).list()).toEqual([]);
  tab.clay.menu.open();
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect($('[data-menu-id="clay.earlier-drafts"]', "menu")).toBeNull();
});
