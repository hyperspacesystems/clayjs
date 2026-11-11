/**
 * The vendored RichClay carries the link popover, and ClayJS skins its chrome.
 * What the popover does is proved in richclay's own suite; this proves it shipped.
 */
import { readFileSync } from "node:fs";
import { CSS } from "../../src/ui/skins/richclay.js";

const vendor = readFileSync(new URL("../../src/vendor/richclay.vendor.js", import.meta.url), "utf8");

test("the vendored bundle has the popover and removes it from snapshots", () => {
  expect(vendor).toContain("data-richclay-link-popover");
  expect(vendor).toMatch(/\[data-richclay-dialog\], \[data-richclay-link-popover\]/);
  expect(vendor).toContain("link-label");
});

test("the vendored bundle keeps a site's file names relative", () => {
  expect(vendor).toMatch(/html\?\|pdf\|txt/);
});

test("the skin armours the popover's three rules", () => {
  expect(CSS).toContain(".richclay-link-popover");
  expect(CSS).toContain(".richclay-link-address");
});
