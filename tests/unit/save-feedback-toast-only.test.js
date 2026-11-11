// clay-ui on a page with no indicator plugin: Saved stays silent unless the page asks for
// it with clay.saveToast. The page carrying both is covered in save-feedback.test.js.

import { $$ } from "./helpers/editor-ui.js";

const toasts = (type) => $$(type ? `[data-clay-toast="${type}"]` : "[data-clay-toast]", "toasts");
const fire = (state, detail) => document.dispatchEvent(new CustomEvent("clay:save-" + state, { detail }));

beforeAll(async () => {
  window.clayEditMode = true;
  await import("../../src/ui/index.js");
});

test("saved: without clay.saveToast there is no toast, chip or not", () => {
  fire("saved", { msg: "Saved" });

  expect(toasts("success")).toHaveLength(0);
});

test("saved: with clay.saveToast the Saved toast is the feedback", () => {
  window.clay.saveToast = true;
  try {
    fire("saved", { msg: "Saved" });

    const success = toasts("success");
    expect(success).toHaveLength(1);
    expect(success[0].textContent).toContain("Saved");
  } finally {
    window.clay.saveToast = false;
  }
});

test("a warning on a successful save is a toast here too", () => {
  fire("saved", { msg: "Saved, but one image was too large", msgType: "warning" });

  const warning = toasts("warning");
  expect(warning).toHaveLength(1);
  expect(warning[0].textContent).toContain("Saved, but one image was too large");
});
