/**
 * save-wait-indicator: a save that waits before its capture says so.
 *
 * The source map's install runs before a session's first save takes its capture, and it
 * fetches the served document. On Hyperclay Local with six edit tabs open that fetch queued
 * behind six held connections, and the chip kept saying "Saved" for the whole wait, since it
 * moves only on save events. Past 500 ms of waiting the page now says 'saving'; a wait that
 * ends with nothing to send goes back to 'saved'.
 */

import { jest } from "@jest/globals";
import { deserialize, serialize } from "node:v8";

globalThis.structuredClone ??= (value) => deserialize(serialize(value));

jest.setTimeout(60000);

let save;
let posts = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const setText = (text) => { document.getElementById("c").textContent = text; };
const status = () => document.documentElement.getAttribute("savestatus");

function okJson(body) {
  return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, text: async () => JSON.stringify(body), json: async () => body };
}

const events = [];
for (const state of ["saving", "saved", "error"]) {
  document.addEventListener(`clay:save-${state}`, () => events.push(state));
}
document.addEventListener("clay:save-status", (event) => events.push(`status:${event.detail.state}`));

// The source map's install, held until the test lets it go, as a fetch stuck behind a full
// connection pool would hold it.
function holdSource() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let asked = 0;
  window.clay = window.clay || {};
  window.clay.source = { ensureForSave: () => { asked += 1; return asked === 1 ? gate : null; } };
  return { release: () => release(null), asked: () => asked };
}

beforeAll(async () => {
  window.clayEditMode = true;
  document.body.innerHTML = `<article id="c">initial</article>`;
  global.fetch = jest.fn(async (url, options = {}) => {
    if (String(url).includes("/_/save")) {
      posts.push(String(options.body ?? ""));
      return okJson({ msg: "Saved", etag: `etag-${posts.length}` });
    }
    return okJson({ spec: 1, document: { etag: "base-1" } });
  });
  save = await import("../../src/core/save.js");
  for (let i = 0; i < 100 && !save.baselineSettled(); i++) await sleep(50);
  expect(save.baselineSettled()).toBe(true);
});

afterEach(() => {
  delete window.clay.source;
});

test("a save held before its capture shows 'saving', then lands and says 'saved'", async () => {
  const held = holdSource();
  setText("held-edit");
  events.length = 0;
  const sentBefore = posts.length;

  const pending = save.savePage();
  await sleep(300);
  expect(held.asked()).toBe(1);
  expect(events).toEqual([]);

  await sleep(400);
  expect(status()).toBe("saving");
  expect(events).toEqual(["saving"]);
  expect(posts).toHaveLength(sentBefore);

  held.release();
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(posts).toHaveLength(sentBefore + 1);
  expect(posts[posts.length - 1]).toContain("held-edit");
  expect(status()).toBe("saved");
  expect(events[events.length - 1]).toBe("saved");
});

test("a short wait shows nothing extra", async () => {
  const held = holdSource();
  setText("quick-edit");
  events.length = 0;

  const pending = save.savePage();
  await sleep(100);
  held.release();
  expect((await pending).ok).toBe(true);
  await sleep(700);
  expect(events).not.toContain("saving");
  expect(status()).toBe("saved");
});

test("a wait that ends with nothing to send goes back to 'saved'", async () => {
  const held = holdSource();
  setText("covered-edit");
  events.length = 0;
  const sentBefore = posts.length;

  const pending = save.savePage();
  await sleep(700);
  expect(status()).toBe("saving");

  // The page is put back to what was last saved while the save waits: when it goes on
  // there is nothing left to send.
  setText("quick-edit");
  held.release();
  const result = await pending;
  expect(result.ok).toBe(false);
  expect(posts).toHaveLength(sentBefore);
  expect(status()).toBe("saved");
  // Nothing was saved, so nothing announces a save: [onaftersave] handlers and
  // [refetch-on-save] listen to clay:save-saved. The chip hears clay:save-status.
  expect(events).toEqual(["saving", "status:saved"]);
});

test("a forced save held before its capture shows 'saving' too", async () => {
  const held = holdSource();
  setText("forced-edit");
  events.length = 0;
  const sentBefore = posts.length;

  const pending = save.savePageForce();
  await sleep(700);
  expect(held.asked()).toBe(1);
  expect(status()).toBe("saving");
  expect(posts).toHaveLength(sentBefore);

  held.release();
  const result = await pending;
  expect(result.ok).toBe(true);
  expect(posts).toHaveLength(sentBefore + 1);
  expect(posts[posts.length - 1]).toContain("forced-edit");
  expect(status()).toBe("saved");
  expect(events[events.length - 1]).toBe("saved");
});
