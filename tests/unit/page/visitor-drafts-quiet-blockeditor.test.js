/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/page.html"}
 */

import { scenario } from "../helpers/visitor-drafts-blockeditor-late.js";

test("a stamp handler page with no edit since its last save leaves no operation behind", async () => {
  const { left } = await scenario({ late: false });
  expect(left).toEqual([]);
}, 60000);
