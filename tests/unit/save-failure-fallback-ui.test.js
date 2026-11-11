/**
 * @jest-environment jsdom
 */

import { jest } from "@jest/globals";
import { $$ } from "./helpers/editor-ui.js";

// clay-ui already on the page reports a failed save itself, so the fallback in
// core/save-failure-notice.js stands aside: exactly one toast, never two.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const toasts = (type) => $$(type ? `[data-clay-toast="${type}"]` : "[data-clay-toast]", "toasts");

beforeAll(async () => {
  window.clayEditMode = true;
  window.clay = {};
  await import("../../src/ui/index.js");
});

test("with clay-ui loaded, a failed save shows exactly one toast", async () => {
  const { reportFailure } = await import("../../src/core/save-failure-notice.js");
  document.documentElement.setAttribute("savestatus", "error");
  const detail = {};
  document.dispatchEvent(new CustomEvent("clay:save-error", { detail }));
  reportFailure("error");
  await sleep(400);
  expect(toasts("error")).toHaveLength(1);
});
