/**
 * @jest-environment jsdom
 */

import { jest } from "@jest/globals";

/**
 * A document that signs `clay-mode-switch="live"` enters edit without a reload, and the
 * tracker is imported at that entry instead of at boot. It needs its row in the live
 * switch's support table for that: without the row the entry falls back to a reload.
 * The real loader, the real controller and the real save code; only the host is a fixture.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const flush = async () => {
  for (let i = 0; i < 5; i++) await sleep(0);
};

const until = async (predicate) => {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return true;
    await sleep(5);
  }
  return false;
};

const posts = [];

const answer = (body) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});

async function route(url, options = {}) {
  if ((options.method || "GET") === "POST") {
    posts.push(options.headers["Site-Data"]);
    return answer({ msg: "Saved", etag: `"E${posts.length}"`, siteData: { written: ["brand"], refused: [] } });
  }
  const pathname = new URL(String(url), window.location.href).pathname;
  if (pathname.startsWith("/_/meta")) {
    return answer({ spec: 1, extensions: [], document: { path: window.location.pathname, writable: true, etag: '"E0"' } });
  }
  return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "" };
}

test("a live entry into edit loads the tracker, which declares the shared edit made after it", async () => {
  document.cookie = "isAdminOfCurrentResource=true; path=/";
  window.history.replaceState({}, "", "/notes.html");
  document.documentElement.setAttribute("clay-mode-switch", "live");
  document.head.innerHTML = '<script type="application/json" data-rules-name="api" data-rules-version="1">{"site":{"brand":".brand"}}</script>';
  document.body.innerHTML = '<p class="brand">Old name</p><div id="content">start</div>';
  window.clay = {};
  globalThis.fetch = window.fetch = jest.fn(route);
  const { boot } = await import("../../src/loader.js");
  await new Promise((resolve) => boot(null, new URLSearchParams("exclude=richclay,source"), resolve));
  const clay = window.clay;
  expect(clay.mode).toBe("view");

  const entered = await clay.setMode("edit");
  expect(entered).toMatchObject({ ok: true, mode: "edit" });
  expect(entered.reloading).toBeUndefined();

  const core = await import("../../src/core/save-core.js");
  const save = await import("../../src/core/save.js");
  if (!save.baselineSettled()) save.adoptEntryBaseline();
  // The tracker is never imported here: only the loader's own import can register the
  // header, and the header appears once the tracker has its baseline.
  const tracking = () => core.buildSaveRequest("<p></p>", false, undefined, "probe", null).options.headers["Site-Data"] !== undefined;
  expect(await until(tracking)).toBe(true);

  const told = [];
  document.addEventListener("clay:site-data", (event) => told.push(event.detail));
  document.querySelector(".brand").textContent = "New name";
  await flush();
  expect((await save.savePage()).ok).toBe(true);
  expect(posts).toEqual(["keys=brand"]);
  expect(told).toEqual([{ written: ["brand"], refused: [], applied: [] }]);

  document.getElementById("content").textContent = "more";
  await flush();
  expect((await save.savePage()).ok).toBe(true);
  expect(posts).toEqual(["keys=brand", "keys="]);
}, 60000);
