test("a reader's page has clay.region.own too, and registering there writes nothing to the page", async () => {
  window.fetch = async () => ({ ok: false, status: 404, statusText: "", headers: { get: () => null }, text: async () => "" });
  window.scrollTo = () => {};
  document.body.innerHTML = "<section item><table grid><tbody><tr><td>1</td></tr></tbody></table></section>";
  window.clay = {};
  const { boot } = await import("../../src/loader.js");
  await new Promise((resolve) => boot(null, new URLSearchParams(""), resolve));
  const regions = await import("../../src/lib/owned-regions.js");
  const { isEditMode } = await import("../../src/core/is-edit-mode.js");
  expect(isEditMode).toBe(false);
  expect(window.clay.region.own).toBe(regions.own);
  const before = document.documentElement.outerHTML;
  const handle = window.clay.region.own("section[item] > table[grid]", { serialize: () => "", revision: () => 1 });
  expect(regions.hasOwnedRegions()).toBe(true);
  expect(document.documentElement.outerHTML).toBe(before);
  handle.dispose();
  expect(regions.hasOwnedRegions()).toBe(false);
});
