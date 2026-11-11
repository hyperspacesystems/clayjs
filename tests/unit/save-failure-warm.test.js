/**
 * @jest-environment jsdom
 */

import { jest } from "@jest/globals";

// A save fails offline most of all, when nothing more can be downloaded. So core fetches
// the failure notice and its toast stack at the person's first input, never at boot, and
// only on a page where nothing else reports failures.

const preload = jest.fn();
jest.unstable_mockModule("../../src/ui/toast-lazy.js", () => ({
  default: jest.fn(),
  toastPersistent: jest.fn(),
  dismissPersistent: jest.fn(),
  preload,
}));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  window.clayEditMode = true;
  window.clay = {};
  document.body.innerHTML = '<div id="content">start</div>';
  globalThis.fetch = window.fetch = jest.fn(async () => ({
    ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "",
  }));
  await import("../../src/core/save.js");
  await sleep(50);
}, 20000);

test("nothing is fetched before the first input, and the toast stack is after it", async () => {
  expect(preload).not.toHaveBeenCalled();

  document.getElementById("content").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
  await sleep(100);
  expect(preload).toHaveBeenCalledTimes(1);

  document.getElementById("content").dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "b" }));
  await sleep(100);
  expect(preload).toHaveBeenCalledTimes(1);
});

test("a page with its own feedback never fetches the toast stack", async () => {
  const { warm } = await import("../../src/core/save-failure-notice.js");
  preload.mockClear();
  window.clay.saveFeedback = "own";
  warm();
  expect(preload).not.toHaveBeenCalled();
  delete window.clay.saveFeedback;
  warm();
  expect(preload).toHaveBeenCalledTimes(1);
});
