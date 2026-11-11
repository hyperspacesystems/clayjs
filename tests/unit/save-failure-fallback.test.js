/**
 * @jest-environment jsdom
 */

import { jest } from "@jest/globals";
import { $$ } from "./helpers/editor-ui.js";

/**
 * A failed save is never silent. A page that loads neither the indicator plugin nor
 * clay-ui used to get nothing on screen when a save failed: the events fired and nobody
 * drew them. core/save.js now hands a failure no listener claimed to
 * core/save-failure-notice.js, fetched the first time a save fails, which shows the toast
 * clay-ui would have shown and takes it down when a later save lands. These saves go
 * through the real save lane, with the host answering 500 or the browser offline.
 *
 * clay-ui is never loaded here, so core keeps handling every failure: the cases that must
 * stay silent (the page's own feedback, the indicator chip, a failure the block editor
 * claimed) hold before and after the first toast. clay-ui already on the page is in
 * save-failure-fallback-ui.test.js.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const flush = async () => {
  for (let i = 0; i < 5; i++) await sleep(0);
};

let save, feedback;
let claiming = false;
let status = 500;

const toasts = (type) => $$(type ? `[data-clay-toast="${type}"]` : "[data-clay-toast]", "toasts");
const texts = () => toasts().map((el) => el.textContent);

function response(body, code) {
  return {
    ok: code < 400,
    status: code,
    statusText: String(code),
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

async function route(url, options = {}) {
  if ((options.method || "GET") === "POST") {
    return status < 400 ? response({ msg: "Saved" }, status) : response({ msg: "Server error" }, status);
  }
  return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "" };
}

let online = true;
Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });

beforeAll(async () => {
  window.clayEditMode = true;
  window.clay = {};
  document.body.innerHTML = '<div id="content">start</div>';
  globalThis.fetch = window.fetch = jest.fn(route);
  save = await import("../../src/core/save.js");
  feedback = await import("../../src/core/save-feedback.js");
  // Stands in for the block editor, which claims the failures it puts its own notice up for.
  document.addEventListener("clay:save-error", (event) => { if (claiming) save.claimFailure(event); });
  save.setSaveGeneration(1);
  for (let i = 0; i < 80 && !save.baselineSettled(); i++) await sleep(50);
  await sleep(50);
}, 20000);

let n = 0;
async function failSave() {
  document.getElementById("content").textContent = `edit ${++n}`;
  await flush();
  const result = await save.savePageForce();
  // Long enough for clay-ui to arrive, so a fetch that should not happen would show.
  await sleep(300);
  return result;
}

test("the page's own feedback opts out: no toast", async () => {
  window.clay.saveFeedback = "own";
  const result = await failSave();
  expect(result.ok).toBe(false);
  expect(document.documentElement.getAttribute("savestatus")).toBe("error");
  expect(texts()).toEqual([]);
  delete window.clay.saveFeedback;
});

test("with the indicator chip on the page, nothing extra", async () => {
  feedback.saveFeedback.chip = true;
  await failSave();
  expect(texts()).toEqual([]);
  feedback.saveFeedback.chip = false;
});

test("a failure the block editor claimed adds no generic toast", async () => {
  claiming = true;
  await failSave();
  claiming = false;
  expect(texts()).toEqual([]);
});

test("a failure with nothing listening shows one Couldn't save toast", async () => {
  await failSave();
  expect(toasts("error")).toHaveLength(1);
  expect(texts()).toEqual([expect.stringContaining("Couldn't save")]);
  expect(feedback.saveFeedback.toasts).toBe(false); // clay-ui itself never loaded
});

test("a second failure does not stack a second toast", async () => {
  await failSave();
  await sleep(500); // the replaced toast fades out first
  expect(toasts("error")).toHaveLength(1);
});

test("offline reads Offline, will retry, replaces Couldn't save, and the next save takes it down", async () => {
  expect(toasts("error")).toHaveLength(1);
  online = false;
  await failSave();
  online = true;
  await sleep(500); // the replaced toast fades out first
  expect(toasts("warning")).toHaveLength(1);
  expect(toasts("warning")[0].textContent).toContain("Offline, will retry");
  expect(toasts("error")).toHaveLength(0);

  status = 200;
  const result = await failSave();
  expect(result.ok).toBe(true);
  await sleep(400);
  expect(texts()).toEqual([]);
  status = 500;
});

test("after the fallback has shown a toast, a failure the block editor claims still shows none", async () => {
  claiming = true;
  await failSave();
  claiming = false;
  await sleep(400);
  expect(texts()).toEqual([]);
});

test("the page's own feedback still opts out after the fallback has shown a toast", async () => {
  window.clay.saveFeedback = "own";
  await failSave();
  delete window.clay.saveFeedback;
  expect(texts()).toEqual([]);
});
