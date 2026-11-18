import { jest } from "@jest/globals";

class FakeEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
  }
  close() {}
}

let live;
let snapshot;
let regions;

const BODY = `<tbody>${'<tr><td n="">1</td><td>2</td></tr>'.repeat(120)}</tbody>`;
const PAGE = `<section item data-id="tab-1"><table grid>${BODY}</table></section><p id="note" class>note</p>`;

beforeAll(async () => {
  window.clayEditMode = true;
  global.EventSource = FakeEventSource;
  window.EventSource = FakeEventSource;
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 500, statusText: "mock", text: async () => "" }));
  live = await import("../../src/sync/live-sync.js");
  live.liveSync.stop();
  snapshot = await import("../../src/core/snapshot.js");
  regions = await import("../../src/lib/owned-regions.js");
});

let handle = null;
let sync = null;

beforeEach(() => {
  document.body.innerHTML = PAGE;
  handle = regions.own("section[item] > table[grid]", { serialize: () => BODY, revision: () => 1 });
  sync = new live.LiveSync();
  sync.lane = "live";
  sync.listenForSnapshots();
});

afterEach(() => {
  handle.dispose();
  sync.stop();
});

function parsedLengths(run) {
  const lengths = [];
  const original = DOMParser.prototype.parseFromString;
  const spy = jest.spyOn(DOMParser.prototype, "parseFromString").mockImplementation(function (source, type) {
    lengths.push(source.length);
    return original.call(this, source, type);
  });
  try { run(); } finally { spy.mockRestore(); }
  return lengths;
}

test("the sent bytes check of a landed save parses the page around the region and not the region's bytes", () => {
  const { forSave } = snapshot.captureForSaveAndComparison();
  const held = sync._savedSnapshot;
  expect(held.ownedBodies).toEqual([BODY]);
  expect(document.querySelectorAll("table[grid] *").length).toBe(361);
  expect(held.identityMap["~"].split(",").length).toBeLessThan(20);
  expect(held.html).toContain(BODY);
  const sent = held.html.replace('class=""', "class");
  expect(sent).not.toBe(held.html);
  expect(forSave).toContain(BODY);
  const lengths = parsedLengths(() => sync._relayCommit(held.captureId, sent));
  expect(sync.lastHtml).toBe(sent);
  expect(lengths.length).toBe(2);
  expect(Math.max(...lengths)).toBeLessThan(sent.length - BODY.length + 200);
});

test("bytes that differ outside or inside the region are told apart, and a page with no region is checked as before", () => {
  const html = `<html><head></head><body><table>${BODY}</table><p class="">note</p></body></html>`;
  const sent = html.replace('class=""', "class");
  expect(live.asSent(html, sent, [BODY])).toBe(sent);
  expect(live.asSent(html, sent.replace("note", "other"), [BODY])).toBe(html);
  expect(live.asSent(html, sent.replace("<td>2</td>", "<td>3</td>"), [BODY])).toBe(html);
  expect(live.asSent(html, sent)).toBe(sent);
  expect(parsedLengths(() => live.asSent(html, sent))).toEqual([html.length, sent.length]);
  expect(live.asSent(html, html, [BODY])).toBe(html);
});
