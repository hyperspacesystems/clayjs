let regions;
let policy;
let derived;

beforeAll(async () => {
  window.clayEditMode = true;
  regions = await import("../../src/lib/owned-regions.js");
  policy = await import("../../src/lib/region-policy.js");
  derived = await import("../../src/lib/derived.js");
});

let handle = null;
beforeEach(() => { document.body.innerHTML = "<section item><table grid><tbody><tr><td>1</td></tr></tbody></table></section>"; });
afterEach(() => { handle?.dispose(); handle = null; });

const SELECTOR = "section[item] > table[grid]";
const spec = (extra = {}) => ({ serialize: () => "<tbody><tr><td>owner</td></tr></tbody>", revision: () => "r1", ...extra });
const marker = (mode) => `<!--${regions.pinOwnedRegions(mode).get(document.querySelector("table"))}-->`;

test("clay.region.own is the registry's function on the one region shape", () => {
  expect(policy.regionShape.own).toBe(regions.own);
  expect(policy.windowRegionShape.own).toBe(regions.own);
  expect(regions.OWNED_FROZEN_SELECTOR).toBe(policy.FREEZE_SELECTOR);
});

test("own checks its arguments and returns dispose and notify", () => {
  expect(() => regions.own("", spec())).toThrow(TypeError);
  expect(() => regions.own("table", { revision() {} })).toThrow(TypeError);
  expect(() => regions.own("table", { serialize() {} })).toThrow(TypeError);
  expect(() => regions.own("table", spec({ merge: "no" }))).toThrow(TypeError);
  expect(() => regions.own("table", spec({ conflict: 1 }))).toThrow(TypeError);
  expect(() => regions.own("table[", spec())).toThrow();
  expect(regions.hasOwnedRegions()).toBe(false);
  handle = regions.own(SELECTOR, spec());
  expect(Object.keys(handle).sort()).toEqual(["dispose", "notify"]);
  expect(regions.hasOwnedRegions()).toBe(true);
  expect(regions.isOwnedRoot(document.querySelector("table"))).toBe(true);
  expect(regions.ownedRootOf(document.querySelector("td"))).toBe(document.querySelector("table"));
  handle.dispose();
  expect(regions.hasOwnedRegions()).toBe(false);
  expect(regions.ownedRootOf(document.querySelector("td"))).toBe(null);
  expect(regions.pinOwnedRegions()).toBe(null);
});

test("a pinned marker resolves to the owner's bytes or to its revision, and other text is returned as it came", () => {
  handle = regions.own(SELECTOR, spec());
  const bytes = marker("bytes");
  const html = `<p>before</p><table grid="">${bytes}</table><p>after</p>`;
  expect(regions.ownedBytes(html)).toBe('<p>before</p><table grid=""><tbody><tr><td>owner</td></tr></tbody></table><p>after</p>');
  expect(regions.ownedRevisions(html)).toBe('<p>before</p><table grid=""><!--clay-owned-rev:r1--></table><p>after</p>');
  expect(regions.ownedBytes("<p>no marker</p>")).toBe("<p>no marker</p>");
  expect(regions.ownedRevisions(marker("revision"))).toBe("<!--clay-owned-rev:r1-->");
});

test("a marker with no bytes or with missing text refuses instead of writing an empty region", () => {
  handle = regions.own(SELECTOR, spec());
  const bytes = marker("bytes");
  expect(() => regions.ownedBytes(marker("revision"))).toThrow(expect.objectContaining({ code: "owned-region-unpinned" }));
  expect(() => regions.ownedBytes(`${bytes.slice(0, -8)}-->`)).toThrow(expect.objectContaining({ code: "owned-region-damaged" }));
});

test("only the revision of a region with a conflict function can be taken out of a comparison string", () => {
  let revision = "r1";
  const text = () => `<h1>title</h1><table>${regions.ownedRevisions(marker("revision"))}</table>`;
  handle = regions.own(SELECTOR, spec({ revision: () => revision, conflict() {} }));
  const first = text();
  revision = "r2 --> <!--clay-owned-rev:";
  const second = text();
  expect(second).not.toBe(first);
  expect(regions.withoutQuietRevisions(second)).toBe(regions.withoutQuietRevisions(first));
  expect(regions.withoutQuietRevisions(second.replace("title", "edited"))).not.toBe(regions.withoutQuietRevisions(first));
  handle.dispose();
  revision = "r1";
  handle = regions.own(SELECTOR, spec({ revision: () => revision }));
  const plain = text();
  revision = "r2";
  expect(regions.withoutQuietRevisions(text())).not.toBe(regions.withoutQuietRevisions(plain));
});

test("the painted values of a file leave the roots of a registered region out", () => {
  const file = `<!DOCTYPE html><html><head></head><body><main sap><p text="'hi'">hi</p><section item><table grid><tbody><tr><td text="'x'">stale</td></tr></tbody></table></section></main></body></html>`;
  const painted = () => derived.paintSignatureOfHtml(file).split("\u0001").join(" ");
  expect(painted()).toBe("p #hi td #stale");
  handle = regions.own(SELECTOR, spec());
  expect(painted()).toBe("p #hi");
});
