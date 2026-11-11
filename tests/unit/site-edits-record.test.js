/**
 * site-edits follows the save pipeline's own record of what the file holds: an edit typed
 * while the editor was still booting is declared, and a value a clean live-sync frame
 * brought in is not, while a change back from it is.
 */
import { jest } from "@jest/globals";

const RULES = '<script type="application/json" data-rules-name="api" data-rules-version="1">{"site":{"name":".brand-name"},"own":".own"}</script>';

let core;
let save;
let edits;

const declared = () => core.buildSaveRequest(save.getPageContents(), false, undefined, "probe", null).options.headers["Site-Data"];
const brand = () => document.querySelector(".brand-name");

beforeAll(async () => {
  window.clayEditMode = true;
  document.head.innerHTML = RULES;
  document.body.innerHTML = '<span class="brand-name">Original</span><p class="own">mine</p>';
  core = await import("../../src/core/save-core.js");
  save = await import("../../src/core/save.js");
  // The boot record is taken before anything is editable; the person types before the
  // tracker has loaded.
  save.setLastSavedContents(save.getPageContents());
  brand().textContent = "Typed during boot";
  edits = await import("../../src/core/site-edits.js");
  await edits.ready;
});

test("an edit typed while the editor was booting is declared", () => {
  expect(declared()).toBe("keys=name");
});

test("a clean live-sync frame moves the baseline, and a change back from it is declared", () => {
  brand().textContent = "Remote saved name";
  // What live sync does after it applies a frame it verified clean.
  save.setLastSavedContents(save.getPageContents());
  expect(declared()).toBe("keys=");

  brand().textContent = "Original";
  expect(declared()).toBe("keys=name");
});

test("the save pipeline's record changing because of this tab's own save does not rebase a refused key", async () => {
  global.fetch = jest.fn(async (url, options = {}) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => JSON.stringify(String(url).includes("/_/save")
      ? { msg: "Saved", etag: "e-1", siteData: { written: [], refused: [{ key: "name", code: "not-allowed" }] } }
      : { spec: 1, document: { etag: "base-1" } }),
  }));
  await save.savePage();
  expect(declared()).toBe("keys=name");
});

test("a frame that arrives after this tab's own save still moves the baseline", async () => {
  brand().textContent = "Saved here";
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => JSON.stringify(String(url).includes("/_/save")
      ? { msg: "Saved", etag: "e-2", siteData: { written: ["name"], refused: [] } }
      : { spec: 1, document: { etag: "base-1" } }),
  }));
  await save.savePage();

  brand().textContent = "Saved by another tab";
  save.setLastSavedContents(save.getPageContents());
  expect(declared()).toBe("keys=");

  brand().textContent = "Saved here";
  expect(declared()).toBe("keys=name");
});

test("typing back the value a host refresh replaced is saved and declared", async () => {
  const sent = [];
  let answer = { written: [], refused: [], current: { name: "Host name" } };
  global.fetch = jest.fn(async (url, options = {}) => {
    const saving = String(url).includes("/_/save");
    if (saving) sent.push(options.headers["Site-Data"]);
    const body = saving ? { msg: "Saved", etag: `e-r${sent.length}`, siteData: answer } : { spec: 1, document: { etag: "base-1" } };
    answer = { written: ["name"], refused: [] };
    return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, text: async () => JSON.stringify(body) };
  });
  document.querySelector(".own").textContent = "a page edit";
  const before = brand().textContent;
  await save.savePage();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(brand().textContent).toBe("Host name");

  brand().textContent = before;
  sent.length = 0;
  await save.savePage();
  expect(sent).toEqual(["keys=name"]);
});

test("a key refused as stale takes the store's newer value and is not declared again", async () => {
  global.fetch = jest.fn(async (url) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => JSON.stringify(String(url).includes("/_/save")
      ? { msg: "Saved", etag: "e-s", siteData: { written: [], refused: [{ key: "name", code: "stale" }], current: { name: "Newer from another page" } } }
      : { spec: 1, document: { etag: "base-1" } }),
  }));
  brand().textContent = "Edited on an older page";
  await save.savePage();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(brand().textContent).toBe("Newer from another page");
  expect(declared()).toBe("keys=");
});
