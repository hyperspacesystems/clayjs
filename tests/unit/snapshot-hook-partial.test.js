/**
 * @jest-environment jsdom
 */

import { jest, test, expect, beforeAll } from "@jest/globals";

// A snapshot callback that throws is skipped so one broken hook cannot stop every save.
// That is only safe when it left the clone as it found it: one that removed rows and then
// threw must not have its half-done clone saved.

let save;
let broken = null;
const sent = [];

beforeAll(async () => {
  window.clayEditMode = true;
  global.fetch = jest.fn(async (url, options) => {
    if (String(url).includes("/_/save")) {
      sent.push(options.body);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ msg: "Saved" }) };
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ spec: 1, extensions: [] }) };
  });
  save = await import("../../src/core/save.js");
  const snapshot = await import("../../src/core/snapshot.js");
  for (const kind of ["onSnapshot", "addDocumentTransform"]) {
    snapshot[kind]((clone) => {
      if (broken?.kind !== kind) return;
      if (broken.mutates) {
        const list = clone.querySelector("#notes");
        const rows = Array.from(list.querySelectorAll("p"));
        list.replaceChildren();
        for (const row of rows) {
          const author = row.querySelector(".author").textContent;
          list.append(Object.assign(clone.ownerDocument.createElement("p"), { textContent: `${author}: ${row.textContent}` }));
        }
      } else {
        clone.querySelector(".missing").textContent;
      }
    });
  }
});

async function saveWith(kind, mutates) {
  document.body.innerHTML = '<div id="notes"><p>My typed answer</p></div>';
  sent.length = 0;
  broken = { kind, mutates };
  const errors = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    return await save.savePageForce();
  } finally {
    broken = null;
    errors.mockRestore();
  }
}

test.each(["onSnapshot", "addDocumentTransform"])("a %s callback that changed the clone and then threw saves nothing", async (kind) => {
  const result = await saveWith(kind, true);
  expect(sent.some((html) => !html.includes("My typed answer"))).toBe(false);
  expect(result.ok === false || sent.length === 0).toBe(true);
});

test.each(["onSnapshot", "addDocumentTransform"])("a %s callback that threw before changing anything is skipped and the save goes on", async (kind) => {
  const result = await saveWith(kind, false);
  expect(result.ok).toBe(true);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain("My typed answer");
});
