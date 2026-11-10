import { jest } from "@jest/globals";

/**
 * The notice is 6.8 KB Brotli and most edit boots have nothing for it to show, so a
 * shell stands in for it (core/conflict-notice.js) and fetches it on the first event
 * that can create something to show, handing that event over. These tests watch the
 * fetch itself: the notice is a stub here, counting the loads and recording the event
 * each one was handed.
 *
 * Every test gets a fresh module registry, and the one before it is left loaded, so a
 * shell from an earlier test cannot answer for the one under test.
 */

const loads = [];
const guards = [];
let fail = false;

await jest.unstable_mockModule("../../src/core/conflict-notice-ui.js", () => {
  if (fail) throw new Error("that did not download");
  const record = { starts: [] };
  loads.push(record);
  return { start: (trigger) => record.starts.push(trigger) };
});

await jest.unstable_mockModule("../../src/sync/data-guard-notice.js", () => {
  const record = { starts: [], stops: 0 };
  guards.push(record);
  return {
    start: (options) => record.starts.push(options),
    stop: () => { record.stops += 1; },
  };
});

const tick = () => new Promise((r) => setTimeout(r, 0));
const event = (type, detail) => new CustomEvent(type, { detail });
const answer = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

let conflicts;
let asks;
let metaAnswer;

// Imported, not awaited for anything else: on DOM ready the shell looks at the ledger
// and either loads at once or arms for an event.
async function boot() {
  jest.resetModules();
  const at = loads.length;
  const guardsAt = guards.length;
  const shell = await import("../../src/core/conflict-notice.js");
  await tick();
  await tick();
  return { loaded: () => loads.slice(at), guards: () => guards.slice(guardsAt), shell };
}

beforeAll(() => {
  window.clayEditMode = true;
  window.requestAnimationFrame = (cb) => setTimeout(cb, 0);
});

beforeEach(() => {
  conflicts = { size: 0, list: () => [], get: () => null };
  window.clay = { conflicts };
  asks = [];
  metaAnswer = () => Promise.resolve(answer({ spec: 1, extensions: [], document: null }));
  global.fetch = jest.fn((url) => {
    asks.push(String(url));
    return metaAnswer();
  });
});

afterEach(async () => {
  fail = false;
  window.clayEditMode = true;
  delete global.fetch;
  // Leave the shell of this test loaded, so nothing it was listening for reaches the
  // next one.
  document.dispatchEvent(event("clay:save-conflict", { changedBy: "another-tab" }));
  await tick();
  await tick();
  loads.length = 0;
});

test("a page with nothing to show downloads nothing, whatever else happens", async () => {
  const { loaded } = await boot();

  document.dispatchEvent(event("clay:save-saved"));
  document.dispatchEvent(event("clay:unsaved-state-changed"));
  document.dispatchEvent(event("clay:sync-applied"));
  document.dispatchEvent(event("clay:save-conflict-resolved"));
  // A ledger change with nothing in the ledger is not something to show.
  document.dispatchEvent(event("clay:sync-conflicts-changed", { open: [] }));
  await tick();

  expect(loaded()).toEqual([]);
});

test("the first refusal downloads it and hands it that refusal", async () => {
  const { loaded } = await boot();
  const refused = event("clay:save-conflict", { changedBy: "another-agent", etag: "E7" });

  document.dispatchEvent(refused);
  await tick();

  const [record] = loaded();
  expect(record.starts).toEqual([refused]);
  expect(record.starts[0].detail).toEqual({ changedBy: "another-agent", etag: "E7" });

  // From here the notice holds its own listeners; the shell asks for nothing more.
  document.dispatchEvent(event("clay:save-conflict", { changedBy: "another-tab" }));
  await tick();
  expect(loaded()).toHaveLength(1);
});

test("a ledger change with entries downloads it and hands it that change", async () => {
  const { loaded } = await boot();
  conflicts.size = 2;
  const changed = event("clay:sync-conflicts-changed", { added: [{ id: "a" }] });

  document.dispatchEvent(changed);
  await tick();

  const [record] = loaded();
  expect(record.starts).toEqual([changed]);
});

test("a page that boots holding edits downloads it at once, with no event to hand over", async () => {
  conflicts.size = 1;

  const { loaded } = await boot();

  expect(loaded()).toHaveLength(1);
  expect(loaded()[0].starts).toEqual([null]);
});

test("a download that fails says so once and the next refusal tries again", async () => {
  const { loaded } = await boot();
  const logged = jest.spyOn(console, "error").mockImplementation(() => {});
  conflicts.size = 3;

  fail = true;
  document.dispatchEvent(event("clay:sync-conflicts-changed", { added: [{ id: "a" }] }));
  await tick();
  await tick();

  expect(logged).toHaveBeenCalledTimes(1);
  expect(loaded()).toEqual([]);

  fail = false;
  const refused = event("clay:save-conflict", { changedBy: "another-tab" });
  document.dispatchEvent(refused);
  await tick();

  expect(loaded()[0].starts).toEqual([refused]);
  expect(logged).toHaveBeenCalledTimes(1);
  logged.mockRestore();
});

// The data-loss notice is a second chunk no page has to download. The shell asks the
// host what it supports, and only an edit boot on a host that announced the extension
// and named a resource fetches the module: the mock above counts its start and stop.
const announced = (document) => () => Promise.resolve(answer({ spec: 1, extensions: ["data-guard-v1"], document }));
const guard = { dataGuard: { href: "/_/guard" } };

test("a host that announces nothing never fetches the data-loss notice", async () => {
  metaAnswer = () => Promise.resolve(answer({ spec: 1, extensions: [], document: guard }));

  const { guards } = await boot();
  await tick();

  expect(asks.filter((url) => url.includes("/_/meta"))).toHaveLength(1);
  expect(guards()).toEqual([]);
});

test("an announced guard with no document block never fetches it", async () => {
  metaAnswer = announced(null);

  const { guards } = await boot();
  await tick();

  expect(guards()).toEqual([]);
});

test("an announced guard with an href fetches it and starts it once", async () => {
  metaAnswer = announced(guard);

  const { guards } = await boot();
  await tick();

  const [record] = guards();
  expect(record.starts).toEqual([{ href: "/_/guard" }]);
});

test("a view boot asks the host nothing and fetches nothing", async () => {
  window.clayEditMode = false;
  metaAnswer = announced(guard);

  const { guards } = await boot();
  await tick();

  expect(asks).toEqual([]);
  expect(guards()).toEqual([]);
});

test("a lease disposed after the notice started stops it", async () => {
  metaAnswer = announced(guard);

  const { guards, shell } = await boot();
  await tick();

  const [record] = guards();
  expect(record.starts).toHaveLength(1);
  shell.conflictNoticeParticipant().prepare({}).dispose();
  expect(record.stops).toBe(1);
});

test("a lease disposed while the meta answer is in flight never starts the notice", async () => {
  let release;
  metaAnswer = () => new Promise((resolve) => {
    release = () => resolve(answer({ spec: 1, extensions: ["data-guard-v1"], document: guard }));
  });

  const { guards, shell } = await boot();
  expect(release).toEqual(expect.any(Function));
  shell.conflictNoticeParticipant().prepare({}).dispose();
  release();
  await tick();
  await tick();

  expect(guards()).toEqual([]);
});
