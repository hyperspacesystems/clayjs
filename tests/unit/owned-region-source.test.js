/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { jest } from "@jest/globals";

let snapshot;
let regions;
let accepted;
let plugin;

const SRC = [
  "<!DOCTYPE html>",
  "<html>",
  "  <head><title>Sheet</title></head>",
  "  <body class='page'>",
  "    <h1 id=title>Budget</h1>",
  "    <section item><table grid><tbody><tr><td>1</td></tr></tbody></table></section>",
  "  </body>",
  "</html>",
].join("\n");

const SELECTOR = "section[item] > table[grid]";
const spec = () => ({ serialize: () => "<tbody><tr><td>owner</td></tr></tbody>", revision: () => 1 });
const saved = () => snapshot.captureForSaveAndComparison({ emitForSync: false }).forSave;

beforeAll(async () => {
  window.clayEditMode = true;
  const parsed = new DOMParser().parseFromString(SRC, "text/html");
  document.replaceChild(document.importNode(parsed.documentElement, true), document.documentElement);
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    redirected: false,
    type: "basic",
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null) },
    text: async () => SRC,
  }));
  snapshot = await import("../../src/core/snapshot.js");
  regions = await import("../../src/lib/owned-regions.js");
  accepted = await import("../../src/core/save-accepted.js");
  plugin = await import("../../src/plugins/source.js");
});

test("a save on a page with a region asks for no source session, and one without a region does", async () => {
  const handle = regions.own(SELECTOR, spec());
  expect(plugin.source.ensureForSave()).toBe(null);
  expect(global.fetch).not.toHaveBeenCalled();
  expect(plugin.source.stats().installed).toBe(false);
  handle.dispose();
  const install = plugin.source.ensureForSave();
  expect(typeof install?.then).toBe("function");
  await install;
  expect(plugin.source.stats().installed).toBe(true);
});

test("an installed session stands aside while a region is registered and comes back after", async () => {
  await plugin.source.ready;
  snapshot.setSaveRenderer(plugin.renderSave);
  try {
    expect(saved()).toContain("<body class='page'>");
    const handle = regions.own(SELECTOR, spec());
    const generation = plugin.source.repairGeneration;
    const withRegion = saved();
    expect(withRegion).toContain('<body class="page">');
    expect(withRegion).toContain("<td>owner</td>");
    expect(withRegion).not.toContain("clay-owned");
    accepted.notifySaveAccepted(withRegion, 1);
    document.dispatchEvent(new CustomEvent("clay:sync-applied", { detail: { source: "peer" } }));
    plugin.source.stats();
    expect(plugin.source.repairGeneration).toBe(generation);
    handle.dispose();
    document.dispatchEvent(new CustomEvent("clay:sync-applied", { detail: { source: "peer" } }));
    plugin.source.stats();
    expect(plugin.source.repairGeneration).toBeGreaterThan(generation);
    expect(saved()).toContain("<body class='page'>");
  } finally {
    snapshot.setSaveRenderer(null);
  }
});
