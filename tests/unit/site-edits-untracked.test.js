/**
 * A page whose rules declare no `site` key sends no Site-Data header and loads no engine.
 */
let core;
let save;
let edits;

beforeAll(async () => {
  window.clayEditMode = true;
  document.head.innerHTML = '<script type="application/json" data-rules-name="api" data-rules-version="1">{"title":"h1","website":".site","first":".site:first-child"}</script>';
  document.body.innerHTML = '<h1>Title</h1><p class="site">not the site key</p>';
  core = await import("../../src/core/save-core.js");
  save = await import("../../src/core/save.js");
  edits = await import("../../src/core/site-edits.js");
  await edits.ready;
});

test("no header on a page without a site rule", () => {
  const { options } = core.buildSaveRequest(save.getPageContents(), false, undefined, "probe", null);
  expect("Site-Data" in options.headers).toBe(false);
});
