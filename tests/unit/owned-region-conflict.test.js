/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { jest } from "@jest/globals";

let save;
let regions;
let etag;
let saves;
let answer;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const accepted = (stamp) => ({ body: { msg: "Saved", etag: stamp } });
const refused = { status: 412, body: { msg: "This document changed since you last loaded it.", code: "conflict" } };
const SELECTOR = "section[item] > table[grid]";

function installRouter() {
  saves = 0;
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes("/_/meta")) {
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ spec: 1, extensions: ["conditional"], document: { etag: "seed-1" } }) };
    }
    saves++;
    const status = answer.status ?? 200;
    return { ok: status < 400, status, statusText: "", headers: { get: () => null }, text: async () => JSON.stringify(answer.body) };
  });
}

beforeAll(async () => {
  window.clayEditMode = true;
  document.body.innerHTML = '<p id="note">note</p><section item><table grid><tbody><tr><td>1</td></tr></tbody></table></section>';
  answer = accepted("stored-1");
  installRouter();
  save = await import("../../src/core/save.js");
  regions = await import("../../src/lib/owned-regions.js");
  etag = await import("../../src/core/etag.js");
  await flush();
});

let handle = null;
let owner;
let events;
const onConflict = (event) => { events.push(event.type); };

async function register(withConflict) {
  owner = { revision: 1, told: [] };
  const spec = { serialize: () => `<tbody><tr><td>${owner.revision}</td></tr></tbody>`, revision: () => owner.revision };
  if (withConflict) spec.conflict = (detail) => { owner.told.push(detail); };
  handle = regions.own(SELECTOR, spec);
  answer = accepted(`stored-${Math.random()}`);
  expect((await save.savePageForce()).ok).toBe(true);
  expect(save.isSaveConflicted()).toBe(false);
  events = [];
  document.addEventListener("clay:save-conflict", onConflict);
  answer = refused;
}

afterEach(async () => {
  document.removeEventListener("clay:save-conflict", onConflict);
  handle?.dispose();
  handle = null;
  answer = accepted(`stored-${Math.random()}`);
  await save.saveOverwritingConflict();
  document.getElementById("note").textContent = "note";
});

test("a refusal with every unsaved change inside regions that take conflicts tells the owner and shows no conflict", async () => {
  await register(true);
  owner.revision = 2;
  const result = await save.savePage();
  expect(result.msgType).toBe("conflict");
  expect(owner.told.length).toBe(1);
  expect(Object.keys(owner.told[0]).sort()).toEqual(["captureId", "changedBy", "etag"]);
  expect(events).toEqual([]);
  expect(save.isSaveConflicted()).toBe(false);
  expect(document.documentElement.getAttribute("savestatus")).not.toBe("conflict");
  const before = saves;
  const callback = jest.fn();
  const overwrite = await save.saveOverwritingConflict(callback);
  expect(overwrite).toEqual(expect.objectContaining({ ok: false, code: "owned-conflict" }));
  expect(callback).toHaveBeenCalledWith(overwrite);
  expect(saves).toBe(before);
});

test("a refusal with a change outside the region as well is the conflict it is today", async () => {
  await register(true);
  owner.revision = 2;
  document.getElementById("note").textContent = "edited outside";
  const result = await save.savePage();
  expect(result.msgType).toBe("conflict");
  expect(owner.told).toEqual([]);
  expect(events).toEqual(["clay:save-conflict"]);
  expect(save.isSaveConflicted()).toBe(true);
  expect(document.documentElement.getAttribute("savestatus")).toBe("conflict");
  answer = accepted("stored-kept");
  expect((await save.saveOverwritingConflict()).ok).toBe(true);
  expect(save.isSaveConflicted()).toBe(false);
});

test("a region with no conflict function leaves a refusal as it is today", async () => {
  await register(false);
  owner.revision = 2;
  const result = await save.savePage();
  expect(result.msgType).toBe("conflict");
  expect(events).toEqual(["clay:save-conflict"]);
  expect(save.isSaveConflicted()).toBe(true);
});
