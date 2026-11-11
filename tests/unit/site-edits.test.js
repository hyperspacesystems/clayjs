/**
 * site-edits: a page that declares `site` values tells the host which of them the person
 * changed, through the real save path, and settles on what the host answers.
 */
import { jest } from "@jest/globals";

const RULES = '<script type="application/json" data-rules-name="api" data-rules-version="1">{"site":{"strip":{"hidden":".strip@hidden","org":".org"},"name":".brand-name","nav":[".nav-list > li",{"label":"a","href":"a@href"}]},"own":".own"}</script>';
const BODY = [
  '<div class="strip"><span class="org">Uni</span></div>',
  '<span class="brand-name">Ines</span>',
  '<ul class="nav-list"><template><li><a href="#">Label</a></li></template><li><a href="index.html">Home</a></li><li><a href="cv.html">CV</a></li></ul>',
  '<p class="own">mine</p>',
].join("");

const okJson = (body) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: { get: () => null },
  text: async () => JSON.stringify(body)
});

let core;
let save;
let edits;
let etag = 0;

const answerSavesWith = (siteData) => {
  const sent = [];
  global.fetch = jest.fn(async (url, options = {}) => {
    if (String(url).includes("/_/save")) {
      sent.push(options.headers["Site-Data"]);
      return okJson({ msg: "Saved", etag: `e-${++etag}`, ...(siteData ? { siteData } : {}) });
    }
    return okJson({ spec: 1, document: { etag: "base-1" } });
  });
  return sent;
};

const declared = () => core.buildSaveRequest(save.getPageContents(), false, undefined, "probe", null).options.headers["Site-Data"];
const navRows = () => [...document.querySelectorAll(".nav-list > li > a")].map((a) => [a.textContent, a.getAttribute("href")]);

beforeAll(async () => {
  window.clayEditMode = true;
  document.head.innerHTML = RULES;
  document.body.innerHTML = BODY;
  core = await import("../../src/core/save-core.js");
  save = await import("../../src/core/save.js");
  edits = await import("../../src/core/site-edits.js");
  await edits.ready;
});

test("a tracked page that changed nothing shared declares an empty list", () => {
  expect(declared()).toBe("keys=");
  document.querySelector(".own").textContent = "page text";
  expect(declared()).toBe("keys=");
});

test("each changed top-level key is declared, in the rule's order", () => {
  document.querySelector(".brand-name").textContent = "Dr. Ines";
  expect(declared()).toBe("keys=name");
  document.querySelector(".strip").setAttribute("hidden", "");
  expect(declared()).toBe("keys=strip,name");
});

test("an accepted save carries the declaration and settles it", async () => {
  const sent = answerSavesWith({ written: ["strip", "name"], refused: [] });
  const events = [];
  const listen = (event) => events.push(event.detail);
  document.addEventListener("clay:site-data", listen);

  const result = await save.savePage();
  document.removeEventListener("clay:site-data", listen);

  expect(result.ok).toBe(true);
  expect(sent).toEqual(["keys=strip,name"]);
  expect(declared()).toBe("keys=");
  expect(events).toEqual([{ written: ["strip", "name"], refused: [], applied: [] }]);
});

test("a key the host refused stays declared on the next save", async () => {
  const row = document.createElement("li");
  row.innerHTML = '<a href="new.html">New</a>';
  document.querySelector(".nav-list").append(row);
  const sent = answerSavesWith({ written: [], refused: [{ key: "nav", code: "not-allowed" }] });

  await save.savePage();

  expect(sent).toEqual(["keys=nav"]);
  expect(declared()).toBe("keys=nav");
  row.remove();
  expect(declared()).toBe("keys=");
});

test("values the host reports as current replace untouched ones and are not declared back", async () => {
  document.querySelector(".own").textContent = "another page edit";
  const brandField = document.querySelector(".brand-name");
  brandField.setAttribute("editable", "single-line");
  const rewritten = [];
  brandField.addEventListener("clay:external-write", () => rewritten.push(brandField.textContent));
  const sent = answerSavesWith({ written: [], refused: [], current: { name: "Store name", nav: [{ label: "Start", href: "index.html" }, { label: "CV", href: "cv.html" }] } });
  const events = [];
  const listen = (event) => events.push(event.detail);
  document.addEventListener("clay:site-data", listen);

  await save.savePage();
  document.removeEventListener("clay:site-data", listen);

  // The save, then the automatic save that stores the refreshed page; neither declares a key.
  expect(sent).toEqual(["keys=", "keys="]);
  expect(document.querySelector(".brand-name").textContent).toBe("Store name");
  expect(navRows()).toEqual([["Start", "index.html"], ["CV", "cv.html"]]);
  expect(events.at(-1).applied).toEqual(["name", "nav"]);
  expect(rewritten).toEqual(["Store name"]);
  expect(declared()).toBe("keys=");
});

test("a live change that no save of this tab had accepted does not move the baseline", () => {
  document.querySelector(".brand-name").textContent = "arrived by a morph";
  document.dispatchEvent(new CustomEvent("clay:sync-applied"));
  expect(declared()).toBe("keys=name");
});

test("a value typed while the save was in flight is kept, and declared on the next save", async () => {
  document.querySelector(".own").textContent = "one more page edit";
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes("/_/save")) {
      document.querySelector(".brand-name").textContent = "typed late";
      return okJson({ msg: "Saved", etag: `e-${++etag}`, siteData: { written: [], refused: [], current: { name: "Newer store name" } } });
    }
    return okJson({ spec: 1, document: { etag: "base-1" } });
  });

  await save.savePage();

  expect(document.querySelector(".brand-name").textContent).toBe("typed late");
  expect(declared()).toBe("keys=name");
});
