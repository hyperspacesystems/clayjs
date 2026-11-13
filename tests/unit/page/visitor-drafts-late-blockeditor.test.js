/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/page.html"}
 */

import { scenario } from "../helpers/visitor-drafts-blockeditor-late.js";

test("a stamp handler page keeps late block editor typing when its generation ends", async () => {
  const { everything, left } = await scenario({ late: true });
  expect(everything).toContain("bravo");
  expect(left.some((op) => op.unit)).toBe(true);
  expect(left.every((op) => Object.keys(op.keys).length === 0)).toBe(true);
}, 60000);
