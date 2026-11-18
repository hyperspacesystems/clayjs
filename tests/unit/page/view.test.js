import { RECORD } from "./fixtures/all-kinds.js";
import { blocksOfValues, project, renderModel, revOf } from "../../../src/page/projection.js";
import { serializeLive, stampOf, parseStamp, textHash } from "../../../src/live/ops.js";
import { formatBy } from "../../../src/live/provenance.js";

const fileOf = (blocks) => {
  const model = project(blocks);
  return `<!DOCTYPE html><html><body><main><article class="blockeditor" clay="freeze" data-blockeditor="1" data-rev="${revOf(model)}">\n${renderModel(model)}\n</article></main></body></html>`;
};

let view;
let stopView;
beforeAll(async () => {
  view = await import("../../../src/page/view.js");
});
afterAll(() => {
  stopView?.();
});

test("a newer file morphs into the frozen article; untouched blocks keep their nodes", () => {
  const base = blocksOfValues([RECORD]);
  document.documentElement.innerHTML = new DOMParser().parseFromString(fileOf(base), "text/html").documentElement.innerHTML;
  const before = {
    h: document.querySelector('[data-id="h"]'),
    tbl: document.querySelector('[data-id="tbl"]'),
    p1: document.querySelector('[data-id="p1"]'),
  };
  const next = { ...base, p1: { ...base.p1, c: "Changed by the writer", m: undefined }, n: { t: "paragraph", pos: "1V", c: "Inserted" } };
  delete next.after;
  stopView = view.startPageView(document);
  document.dispatchEvent(new CustomEvent("clay:sync-applied", { detail: { html: fileOf(next), source: "disk" } }));
  const art = document.querySelector("article");
  expect(art.querySelector('[data-id="p1"]').textContent).toBe("Changed by the writer");
  expect(art.querySelector('[data-id="n"]').textContent).toBe("Inserted");
  expect(art.querySelector('[data-id="after"]')).toBeNull();
  expect(art.querySelector('[data-id="h"]')).toBe(before.h);
  expect(art.querySelector('[data-id="tbl"]')).toBe(before.tbl);
  expect(art.getAttribute("data-rev")).toBe(revOf(project(next)));
  // Whitespace between blocks may differ (the morph keeps a text node); the blocks may not.
  const squeeze = (s) => s.replace(/\n\s*/g, "\n").trim();
  expect(squeeze(art.innerHTML)).toBe(squeeze(new DOMParser().parseFromString(fileOf(next), "text/html").querySelector("article").innerHTML));
});

test("a file with the same rev changes nothing", () => {
  const art = document.querySelector("article");
  const html = "<!DOCTYPE html><html><body>" + art.outerHTML + "</body></html>";
  expect(view.applySavedArticle(html, document)).toBe(false);
});

test("a toggle the reader opened stays open across an update", async () => {
  const record = {
    blocks: {
      t: { t: "toggle", pos: "1", c: "Notes", open: false },
      x: { t: "paragraph", pos: "2", parent: "t", c: "Inside" },
      y: { t: "paragraph", pos: "3", c: "After" },
    },
    deleted: {},
  };
  const base = blocksOfValues([record]);
  document.documentElement.innerHTML = new DOMParser().parseFromString(fileOf(base), "text/html").documentElement.innerHTML;
  const stop = view.startPageView(document);
  const opened = document.querySelector('details[data-id="t"]');
  opened.querySelector("summary").click();
  // jsdom may not flip open on a summary click; a browser does.
  opened.open = true;
  await new Promise((resolve) => setTimeout(resolve, 0));
  const next = { ...base, y: { ...base.y, c: "After, edited" } };
  document.dispatchEvent(new CustomEvent("clay:sync-applied", { detail: { html: fileOf(next), source: "disk" } }));
  const details = document.querySelector('details[data-id="t"]');
  expect(details.open).toBe(true);
  expect(document.querySelector('[data-id="y"]').textContent).toBe("After, edited");
  stop();
});

test("a saved file's page tag replaces the live tag, and a file without one removes it", () => {
  const base = blocksOfValues([RECORD]);
  const tagged = (tag) => fileOf(base).replace("<body>", `<body><script type="application/json" merge="blockeditor" clay="live">${tag}</script>`);
  document.documentElement.innerHTML = new DOMParser().parseFromString(fileOf(base), "text/html").documentElement.innerHTML;
  const first = JSON.stringify({ v: 1, y: { seed: "one" } });
  const second = JSON.stringify({ v: 1, y: { seed: "two" } });
  document.head.insertAdjacentHTML("beforeend", `<script type="application/json" merge="blockeditor" clay="live">${first}</script>`);

  expect(view.applySavedArticle(tagged(second), document)).toBe(true);
  expect(document.querySelector('script[type="application/json"][merge="blockeditor"]').textContent).toBe(second);

  expect(view.applySavedArticle(fileOf(base), document)).toBe(true);
  expect(document.querySelector('script[type="application/json"][merge="blockeditor"]')).toBe(null);
});

test("a saved tag keeps the room lineage it carries", () => {
  const base = blocksOfValues([RECORD]);
  const tagged = (tag, { at = null, by = null } = {}) =>
    fileOf(base).replace(
      "<body>",
      `<body><script type="application/json" merge="blockeditor" clay="live"${at ? ` live-at="${at}"` : ""}${by ? ` live-by="${by}"` : ""}>${tag}</script>`
    );
  const first = JSON.stringify({ v: 1, y: { seed: "one" } });
  const second = JSON.stringify({ v: 1, y: { seed: "two" } });
  const firstAt = stampOf("ep1", 1, serializeLive(JSON.parse(first)));
  const secondAt = stampOf("ep1", 2, serializeLive(JSON.parse(second)));
  const secondBy = formatBy({ v: 2, frames: [["tab-1", [[1, 2]]]], ancestors: [], capture: ["tab-1", 3] });
  expect(secondBy).toBeTruthy();

  document.documentElement.innerHTML = new DOMParser().parseFromString(fileOf(base), "text/html").documentElement.innerHTML;
  document.head.insertAdjacentHTML("beforeend", `<script type="application/json" merge="blockeditor" clay="live" live-at="${firstAt}">${first}</script>`);

  // The file a peer saved: newer text, and the room position it was saved at.
  expect(view.applySavedArticle(tagged(second, { at: secondAt, by: secondBy }), document)).toBe(true);
  const liveTag = document.querySelector('script[type="application/json"][merge="blockeditor"]');
  expect(liveTag.textContent).toBe(second);
  // The tag states the saved lineage, so the next live entry reads the room it carries
  // instead of finding a stamp that does not match its text and dropping it.
  expect(liveTag.getAttribute("live-at")).toBe(secondAt);
  expect(liveTag.getAttribute("live-by")).toBe(secondBy);
  expect(parseStamp(liveTag.getAttribute("live-at")).hash).toBe(textHash(serializeLive(JSON.parse(liveTag.textContent))));

  // A saved file whose tag carries no lineage leaves none behind.
  expect(view.applySavedArticle(tagged(first), document)).toBe(true);
  expect(liveTag.textContent).toBe(first);
  expect(liveTag.getAttribute("live-at")).toBe(null);
  expect(liveTag.getAttribute("live-by")).toBe(null);
});
