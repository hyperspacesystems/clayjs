import { jest } from "@jest/globals";

let build;
let create;
let resetHostMeta;

const RULES = { title: "h1", rows: ["ul.rows > li", "."] };
const PAGE =
  `<script type="application/json" data-rules-name="api" data-rules-version="1">${JSON.stringify(RULES)}</script>`;
const BODY = '<h1>My notes</h1><ul class="rows"><li>one</li><li>two</li></ul><div clay="no-copy" id="secret">owner only</div>';

const parse = (html) => new DOMParser().parseFromString(html, "text/html");
const meta = (actions) => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/json" },
  json: async () => ({ spec: 2, extensions: [], document: { actions } }),
  text: async () => JSON.stringify({ spec: 2, extensions: [], document: { actions } }),
});

beforeAll(async () => {
  ({ build, create } = await import("../../src/core/new-document.js"));
  ({ resetHostMeta } = await import("../../src/core/host-meta.js"));
});

let listeners = [];
beforeEach(() => {
  resetHostMeta();
  document.head.innerHTML = PAGE;
  document.body.innerHTML = BODY;
  window.clay = { getHTML: () => "<!DOCTYPE html>\n" + document.documentElement.outerHTML };
});
afterEach(() => {
  for (const fn of listeners) document.removeEventListener("clay:newdocument", fn);
  listeners = [];
});
const onNew = (fn) => {
  listeners.push(fn);
  document.addEventListener("clay:newdocument", fn);
};

test("build empties the data, cuts copy content and leaves the live page alone", async () => {
  const doc = parse(await build());
  expect(doc.querySelector("h1").textContent).toBe("");
  expect(doc.querySelectorAll("ul.rows > li")).toHaveLength(0);
  expect(doc.getElementById("secret")).toBeNull();
  expect(document.querySelector("h1").textContent).toBe("My notes");
  expect(document.querySelectorAll("ul.rows > li")).toHaveLength(2);
});

test("the starting values tag wins over blank", async () => {
  document.head.insertAdjacentHTML("beforeend", '<script type="application/json" clay-new-document>{"title":"Journal"}</script>');
  const doc = parse(await build());
  expect(doc.querySelector("h1").textContent).toBe("Journal");
  expect(doc.querySelector("script[clay-new-document]")).not.toBeNull();
});

// A Block page's rules do not cover its article, so it blanks the rest itself.
test("clay:newdocument hands listeners the blank copy, and their changes are in the result", async () => {
  let seen = null;
  onNew((event) => {
    seen = event.detail.document;
    event.detail.document.body.setAttribute("data-fresh", "1");
  });
  const html = await build();
  expect(seen).not.toBe(document);
  expect(seen.querySelector("h1").textContent).toBe("");
  expect(parse(html).body.getAttribute("data-fresh")).toBe("1");
  expect(document.body.hasAttribute("data-fresh")).toBe(false);
});

test("create posts the new document to the host's action and returns its href", async () => {
  const posts = [];
  window.fetch = jest.fn(async (url, options = {}) => {
    const href = String(url);
    if (href.includes("/_/meta")) return meta({ newDocument: { post: "/_/new-document/notes.html" } });
    posts.push({ href, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, href: "/notes-2.html" }) };
  });
  await expect(create()).resolves.toEqual({ ok: true, href: new URL("/notes-2.html", location.href).href });
  expect(posts).toHaveLength(1);
  expect(posts[0].href).toBe(new URL("/_/new-document/notes.html", location.origin).href);
  expect(posts[0].options.method).toBe("POST");
  expect(posts[0].options.headers["Document-URL"]).toBe(location.href);
  expect(parse(posts[0].options.body).querySelector("h1").textContent).toBe("");
});

test("a host refusal passes its message on", async () => {
  window.fetch = jest.fn(async (url) => {
    if (String(url).includes("/_/meta")) return meta({ newDocument: { post: "/_/new-document/notes.html" } });
    return { ok: false, status: 403, json: async () => ({ msg: "You have used all 10 documents on the free plan.", msgType: "error", code: "forbidden" }) };
  });
  await expect(create()).resolves.toEqual({ ok: false, message: "You have used all 10 documents on the free plan." });
});

test("with no host action the new document downloads", async () => {
  window.fetch = jest.fn(async (url) => (String(url).includes("/_/meta") ? meta({}) : { ok: false, status: 404, json: async () => ({}) }));
  const blobs = [];
  const createObjectURL = URL.createObjectURL;
  const revokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => (blobs.push(blob), "blob:x");
  URL.revokeObjectURL = () => {};
  const names = [];
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    names.push(this.download);
  };
  try {
    await expect(create()).resolves.toEqual({ ok: true, downloaded: true });
  } finally {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    HTMLAnchorElement.prototype.click = click;
  }
  expect(names).toEqual([expect.stringMatching(/-new\.html$/)]);
  expect(blobs).toHaveLength(1);
});

test("starting list rows clone the cms-template seed instead of reusing old rows, and form controls serialize blanked", async () => {
  document.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="1">${JSON.stringify({
    note: "input#note@value",
    thanks: ["a[clay-menu-item]", { id: "@data-id" }],
  })}</script><script type="application/json" clay-new-document>{"thanks":[{"id":"appreciation"}]}</script>`;
  document.body.innerHTML =
    '<input id="note" value="private">' +
    '<div class="links"><a cms-template data-id="" clay-menu-item href="mailto:creator@example.com">Appreciate</a>' +
    '<a data-id="custom" clay-menu-item href="https://acme.example/docs">Team docs</a></div>';
  const doc = parse(await build());
  expect(doc.getElementById("note").getAttribute("value")).toBe("");
  const links = doc.querySelectorAll("a[clay-menu-item]:not([cms-template])");
  expect(links).toHaveLength(1);
  expect(links[0].getAttribute("data-id")).toBe("appreciation");
  expect(links[0].getAttribute("href")).toBe("mailto:creator@example.com");
});

test("codec rules are skipped without throwing UnknownCodec so clay:newdocument can blank them", async () => {
  document.head.innerHTML =
    '<script type="application/json" data-rules-name="api" data-rules-version="2">{"title":"h1","grid":"#wb@codec(sheet)"}</script>';
  document.body.innerHTML = '<h1>Q4 Budget</h1><div id="wb">cells</div>';
  onNew(({ detail }) => {
    detail.document.getElementById("wb").textContent = "";
  });
  const doc = parse(await build());
  expect(doc.querySelector("h1").textContent).toBe("");
  expect(doc.getElementById("wb").textContent).toBe("");
});

test("view mode and draft mode strip host root attributes and editor UI and fetch Clay-Source", async () => {
  const sourceHtml =
    '<!DOCTYPE html><html documentid="doc-1" savetoken="tok-1" documentetag="e-1" route-tab="2">' +
    `<head>${PAGE}</head><body><h1>Saved</h1><ul class="rows"><li>row</li></ul><div clay="no-save" id="bar">setup</div></body></html>`;
  const headersSeen = [];
  window.clay = { isDraftMode: true, getHTML: () => '<!DOCTYPE html><html><head>' + PAGE + '</head><body><h1>Draft</h1><ul class="rows"></ul><aside id="draft-extra">visitor note</aside></body></html>' };
  window.fetch = jest.fn(async (_url, options = {}) => {
    headersSeen.push(options.headers);
    return { ok: true, status: 200, text: async () => sourceHtml };
  });
  const doc = parse(await build());
  expect(headersSeen).toEqual([{ "Clay-Source": "1" }]);
  expect(doc.documentElement.hasAttribute("documentid")).toBe(false);
  expect(doc.documentElement.hasAttribute("savetoken")).toBe(false);
  expect(doc.documentElement.hasAttribute("documentetag")).toBe(false);
  expect(doc.documentElement.hasAttribute("route-tab")).toBe(false);
  expect(doc.getElementById("bar")).toBeNull();
  expect(doc.getElementById("draft-extra")).toBeNull();
});

// Values the template names in `keep` (a look, an appreciation link) carry over as they are.
test("keys the starting values tag keeps are left as they are, and the shared site values too", async () => {
  document.head.innerHTML =
    `<script type="application/json" data-rules-name="api" data-rules-version="1">${JSON.stringify({ title: "h1", look: "#look", site: { brand: "#brand" }, rows: ["ul.rows > li", "."] })}</script>` +
    '<script type="application/json" clay-new-document keep="look">{"look":"ignored"}</script>';
  document.body.innerHTML = '<span id="brand">Acme</span><h1>My notes</h1><i id="look">dark</i><ul class="rows"><li>one</li></ul>';
  const doc = parse(await build());
  expect(doc.querySelector("h1").textContent).toBe("");
  expect(doc.getElementById("look").textContent).toBe("dark");
  expect(doc.getElementById("brand").textContent).toBe("Acme");
});

// The store holds the old writing, and the editor would restore it over a blanked article.
test("a Block page's store is left out of the new document", async () => {
  document.body.insertAdjacentHTML("beforeend",
    '<article data-blockeditor="1"><h1>Old writing</h1></article><script type="application/octet-stream" merge="blockeditor" clay="live">AAAA</script>');
  const html = await build();
  expect(html).not.toContain('merge="blockeditor"');
});

// The host's answer is opened as a page, so only a web address is.
test("create refuses an answer whose href is not a web address", async () => {
  window.fetch = jest.fn(async (url) => {
    if (String(url).includes("/_/meta")) return meta({ newDocument: { post: "/_/new-document/notes.html" } });
    return { ok: true, status: 200, json: async () => ({ ok: true, href: "javascript:alert(1)" }) };
  });
  await expect(create()).resolves.toEqual({ ok: false, message: "Couldn't make a new document. Try again." });
});

test("a paid-only region stays for the host to judge, and copy content still goes", async () => {
  document.body.insertAdjacentHTML("beforeend", '<form clay="no-copy-unless:paid-forms" id="contact"></form>');
  const doc = parse(await build());
  expect(doc.getElementById("contact")).not.toBeNull();
  expect(doc.getElementById("secret")).toBeNull();
});

// The theme's variant styles follow <html look>, so a blank copy keeps the chosen theme whole.
test("the chosen theme stays", async () => {
  document.documentElement.setAttribute("look", "dusk");
  document.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="1">${JSON.stringify({ title: "h1", look: "html@look" })}</script>`;
  try {
    const doc = parse(await build());
    expect(doc.documentElement.getAttribute("look")).toBe("dusk");
    expect(doc.querySelector("h1").textContent).toBe("");
  } finally {
    document.documentElement.removeAttribute("look");
  }
});
