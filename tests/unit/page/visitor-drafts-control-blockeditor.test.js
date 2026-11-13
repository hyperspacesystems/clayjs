/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/page.html"}
 */

import { scenario } from "../helpers/visitor-drafts-blockeditor-late.js";

test("control: without the gate the same page leaves a stamp-only operation behind", async () => {
  const { left } = await scenario({ late: false, gate: false });
  expect(left.length).toBe(1);
  expect(Object.keys(left[0].keys)).toEqual(["stamp"]);
}, 60000);
