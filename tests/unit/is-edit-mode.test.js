
test("clayEditMode global wins; decoded-truthy cookie => not owner", async () => {
  window.clayEditMode = true;
  document.cookie = "isAdminOfCurrentResource=false";
  const mod = await import("../../src/core/is-edit-mode.js");
  expect(mod.isEditMode).toBe(true);   // global forces edit mode
  expect(mod.isOwner).toBe(false);     // cookie "false" decodes to false
});
