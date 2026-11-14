import { jest } from "@jest/globals";

/**
 * clay.hasUnsavedChanges is the close warning's own predicate, reachable synchronously
 * by a host that has to decide whether asking for a save is worth it.
 *
 * The page boots through the real loader, because that is where the member is attached:
 * a hand-built window.clay would keep this green with the attachment gone.
 */

const captureFailure = { on: false };

beforeAll(async () => {
  window.clayEditMode = true;
  window.clay = {};
  window.fetch = async () => new Response("", { status: 404 });
  document.body.innerHTML = '<div id="content">start</div>';
  const realContentDom = await import("../../src/lib/content-dom.js");
  jest.unstable_mockModule("../../src/lib/content-dom.js", () => ({
    cleanContentClone: realContentDom.cleanContentClone,
    createContentView: (...args) => {
      if (captureFailure.on) throw new Error("fixture capture failure");
      return realContentDom.createContentView(...args);
    },
  }));
  // These tests fail saves on purpose; they are about the close warning, so the failures
  // are claimed the way a page's own indicator would, and core's fallback notice stays
  // undownloaded (its import would otherwise land after this file is torn down).
  const { claimFailure } = await import("../../src/core/save.js");
  for (const type of ["clay:save-error", "clay:save-offline"]) document.addEventListener(type, claimFailure);
  const { boot } = await import("../../src/loader.js");
  await new Promise((resolve) => boot(null, new URLSearchParams("exclude=richclay,source"), resolve));
});

function okFetch() {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "",
    text: async () => JSON.stringify({ msg: "Saved", etag: "E1" })
  }));
}

test("a page that matches the file has nothing unsaved", () => {
  expect(window.clay.hasUnsavedChanges()).toBe(false);
});

test("an edit is unsaved until a save writes it", async () => {
  document.getElementById("content").textContent = "an edit";

  expect(window.clay.hasUnsavedChanges()).toBe(true);

  global.fetch = okFetch();
  const result = await window.clay.save();
  expect(result.ok).toBe(true);

  expect(window.clay.hasUnsavedChanges()).toBe(false);
});

// The warning decides first and explains afterwards: a capture that throws is a broken
// page, and a broken page is exactly the one whose work must not be dropped on close.
test("a pending registered state still warns when a capture throws", async () => {
  const { registerUnsavedState } = await import("../../src/lib/unsaved-state.js");
  const handle = registerUnsavedState({ id: "editor-model", isPending: () => true });

  const listenerErrors = [];
  const onError = (event) => {
    listenerErrors.push(event.message || String(event.error));
    event.preventDefault?.();
  };
  window.addEventListener("error", onError);
  try {
    captureFailure.on = true;
    const beforeUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(beforeUnload);

    expect(beforeUnload.defaultPrevented).toBe(true);
    // Not even asked: the debug-only diff capture runs after the decision, and a throw
    // there must not cancel the warning.
    expect(listenerErrors).toEqual([]);
  } finally {
    window.removeEventListener("error", onError);
    handle.dispose();
    captureFailure.on = false;
  }
});

// A capture that throws means unknown, and unknown is not clean. The close warning says
// so, and a flush reports it as a save that did not happen rather than as an answer.
test("a capture that throws reads as unsaved, and flush reports 'failed'", async () => {
  try {
    captureFailure.on = true;
    expect(window.clay.hasUnsavedChanges()).toBe(true);
    await expect(window.clay.save.flush()).rejects.toMatchObject({ state: "failed" });
  } finally {
    captureFailure.on = false;
  }
}, 20000);

// A scroll lock or an extension that sets an inline style and then resets it leaves
// `style=""` on <html> and <body>. That renders exactly like no attribute, so it must not
// hold the close warning up on a page with nothing to lose.
test("empty style and class attributes left behind are not unsaved changes", async () => {
  global.fetch = okFetch();
  await window.clay.save();
  expect(window.clay.hasUnsavedChanges()).toBe(false);

  document.documentElement.style.overflow = "hidden";
  document.body.style.overflow = "hidden";
  expect(window.clay.hasUnsavedChanges()).toBe(true);

  document.documentElement.style.overflow = "";
  document.body.style.overflow = "";
  document.getElementById("content").className = "";
  expect(document.documentElement.getAttribute("style")).toBe("");
  expect(document.getElementById("content").getAttribute("class")).toBe("");
  expect(window.clay.hasUnsavedChanges()).toBe(false);

  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
  document.getElementById("content").removeAttribute("class");
});
