/**
 * @jest-environment jsdom
 */

/**
 * A shared value the host reports as current lands outside undo history: Cmd+Z after the
 * refresh undoes the person's own edit, never brings the older shared value back, and so
 * never declares it to the host.
 */
import { jest } from "@jest/globals";
import Mutation from "../../src/lib/mutation.js";

const RULES = '<script type="application/json" data-rules-name="api" data-rules-version="1">{"site":{"name":".brand-name"},"own":".own"}</script>';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let undo;
let core;
let save;
let edits;

beforeAll(async () => {
  window.clayEditMode = true;
  window.clay = { Mutation };
  undo = (await import("../../src/plugins/undo.js")).undo;
  window.clay.undo = undo;
  undo.start({ bindKeys: false });
  document.head.innerHTML = RULES;
  document.body.innerHTML = '<span class="brand-name">Old brand</span><p class="own">mine</p>';
  core = await import("../../src/core/save-core.js");
  save = await import("../../src/core/save.js");
  edits = await import("../../src/core/site-edits.js");
  await edits.ready;
  await settle();
  undo.clear();
});

afterAll(() => {
  undo.stop();
});

test("undo after a host refresh restores the person's edit, not the older shared value", async () => {
  document.querySelector(".own").textContent = "a page edit";
  await settle();
  undo.flush();

  global.fetch = jest.fn(async (url) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => JSON.stringify(String(url).includes("/_/save")
      ? { msg: "Saved", etag: "e-1", siteData: { written: [], refused: [], current: { name: "Store brand" } } }
      : { spec: 1, document: { etag: "base-1" } }),
  }));
  await save.savePage();
  await settle();
  undo.flush();
  expect(document.querySelector(".brand-name").textContent).toBe("Store brand");

  undo.undo();
  await settle();
  expect(document.querySelector(".brand-name").textContent).toBe("Store brand");
  expect(document.querySelector(".own").textContent).toBe("mine");
  const declared = core.buildSaveRequest(save.getPageContents(), false, undefined, "probe", null).options.headers["Site-Data"];
  expect(declared).toBe("keys=");
});
