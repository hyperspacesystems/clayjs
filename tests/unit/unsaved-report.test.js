import { jest } from "@jest/globals";

// Scenario: a tab tells a host that announces unsaved-report-v1 when it holds edits not
// saved yet, so the host's Quit can ask, and says so again when they are saved or the
// tab goes away. A host without the extension, or one that refuses, hears nothing more.

let extensions = ["unsaved-report-v1"];
let token = "tok123";
let metaCalls = 0;
let metaOutcome = "ok";
let metaOptions = [];

await jest.unstable_mockModule("../../src/core/host-meta.js", () => ({
  hostMeta: async (options) => {
    metaCalls += 1;
    metaOptions.push(options);
    return { spec: 1, extensions, document: null };
  },
  hostMetaOutcome: () => metaOutcome,
}));
await jest.unstable_mockModule("../../src/core/host-attrs.js", () => ({
  saveToken: () => token,
}));

let currentBytes = "saved";
let parked = false;
let gateDirty = false;
await jest.unstable_mockModule("../../src/lib/dirty-gate.js", () => ({ pageMaybeDirty: () => gateDirty }));
await jest.unstable_mockModule("../../src/core/is-edit-mode.js", () => ({ isEditMode: true, isDraftMode: false }));
await jest.unstable_mockModule("../../src/core/draft-mode.js", () => ({
  draftStoreFailed: () => false,
  draftUnconfirmed: () => false,
  flushDraft: () => true,
}));
let captureOptions = [];
await jest.unstable_mockModule("../../src/core/snapshot.js", () => ({
  captureForDirtyCheck: (options) => {
    captureOptions.push(options);
    return currentBytes;
  },
}));
await jest.unstable_mockModule("../../src/core/save.js", () => ({
  getLastSavedDirty: () => "saved",
  sessionParked: () => parked,
  styleAdoptionPending: () => false,
}));
await jest.unstable_mockModule("../../src/lib/autosave-debug-gate.js", () => ({
  logUnloadDiffSync: () => {},
  preloadIfEnabled: () => {},
}));

const { startUnsavedReports } = await import("../../src/core/unsaved-report.js");
const host = { ...(await import("../../src/core/host-meta.js")), ...(await import("../../src/core/host-attrs.js")) };
const { unsavedForHost } = await import("../../src/core/unsaved-warning.js");
const { registerUnsavedState, setLiveState } = await import("../../src/lib/unsaved-state.js");

let unsaved;
let calls;
let answer;
let reporter;

function bodies() {
  return calls.map(([, options]) => JSON.parse(options.body));
}

beforeEach(() => {
  jest.useFakeTimers();
  extensions = ["unsaved-report-v1"];
  token = "tok123";
  metaCalls = 0;
  metaOutcome = "ok";
  metaOptions = [];
  unsaved = false;
  calls = [];
  answer = () => Promise.resolve({ ok: true, status: 204 });
  global.fetch = (url, options) => {
    calls.push([url, options]);
    return answer();
  };
  reporter = startUnsavedReports(() => unsaved, host.hostMeta, host.hostMetaOutcome, host.saveToken);
});

afterEach(() => {
  reporter.stop();
  jest.useRealTimers();
});

const edit = () => {
  unsaved = true;
  document.dispatchEvent(new Event("input"));
};

test("a page nobody edits asks the host nothing", async () => {
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  expect(calls).toEqual([]);
  expect(metaCalls).toBe(0);
});

test("an edit is reported once it settles, and the save reports it clean", async () => {
  edit();
  edit();
  await jest.advanceTimersByTimeAsync(999);
  expect(calls).toEqual([]);
  await jest.advanceTimersByTimeAsync(1);
  expect(calls).toHaveLength(1);
  const [url, options] = calls[0];
  expect(url).toBe(new URL("/_/unsaved/tok123", window.location.origin).href);
  expect(options.method).toBe("POST");
  expect(options.credentials).toBe("omit");
  expect(options.headers["Document-URL"]).toBe(window.location.href);
  const first = bodies()[0];
  expect(first.unsaved).toBe(true);
  expect(first.seq).toBe(1);
  expect(first.tab).toMatch(/^[0-9a-f]{32}$/);

  unsaved = false;
  document.dispatchEvent(new CustomEvent("clay:save-saved"));
  await jest.advanceTimersByTimeAsync(1000);
  expect(bodies().map((b) => [b.unsaved, b.seq, b.tab])).toEqual([[true, 1, first.tab], [false, 2, first.tab]]);
});

test("a tab that stays unsaved repeats its report every minute, and stops once saved", async () => {
  edit();
  await jest.advanceTimersByTimeAsync(1000);
  await jest.advanceTimersByTimeAsync(3 * 60_000);
  expect(bodies().map((b) => b.unsaved)).toEqual([true, true, true, true]);
  unsaved = false;
  await jest.advanceTimersByTimeAsync(60_000);
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  expect(bodies().map((b) => b.unsaved)).toEqual([true, true, true, true, false]);
});

test("a host without the extension is never sent a report", async () => {
  extensions = ["sync"];
  edit();
  await jest.advanceTimersByTimeAsync(1000);
  expect(metaCalls).toBe(1);
  edit();
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  expect(calls).toEqual([]);
  expect(metaCalls).toBe(1);
});

test("a host that refuses a report hears nothing more", async () => {
  answer = () => Promise.resolve({ ok: false, status: 401 });
  edit();
  await jest.advanceTimersByTimeAsync(1000);
  expect(calls).toHaveLength(1);
  edit();
  document.dispatchEvent(new CustomEvent("clay:dirty"));
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  expect(calls).toHaveLength(1);
});

test("a host that is not there is asked again until it answers", async () => {
  answer = () => Promise.reject(new TypeError("Failed to fetch"));
  edit();
  await jest.advanceTimersByTimeAsync(1000);
  expect(calls).toHaveLength(1);
  answer = () => Promise.resolve({ ok: true, status: 204 });
  await jest.advanceTimersByTimeAsync(5000);
  expect(bodies().map((b) => [b.unsaved, b.seq])).toEqual([[true, 1], [true, 2]]);
  await jest.advanceTimersByTimeAsync(30_000);
  expect(calls).toHaveLength(2);
});

test("a tab going away tells the host with keepalive", async () => {
  edit();
  await jest.advanceTimersByTimeAsync(1000);
  window.dispatchEvent(new Event("pagehide"));
  expect(calls).toHaveLength(2);
  expect(calls[1][1].keepalive).toBe(true);
  expect(bodies()[1].unsaved).toBe(false);
});

test("a page without a save token reports to the tokenless address with its cookies", async () => {
  token = null;
  edit();
  await jest.advanceTimersByTimeAsync(1000);
  expect(calls[0][0]).toBe(new URL("/_/unsaved", window.location.origin).href);
  expect(calls[0][1].credentials).toBe("same-origin");
});

// A page a live room keeps: the room's service writes what the room holds, and this tab
// never hears of that write, so its bytes keep differing from its own last save. Only
// work the room has not taken is something the host could lose.
test("on a page a live room keeps, only work the room has not taken is unsaved", () => {
  gateDirty = true;
  expect(unsavedForHost()).toBe(true);

  setLiveState(() => "room");
  try {
    expect(unsavedForHost()).toBe(false);
    let journal = true;
    const journalSource = registerUnsavedState({ id: "page:journal", isPending: () => journal });
    expect(unsavedForHost()).toBe(false);
    let live = true;
    const liveSource = registerUnsavedState({ id: "page:live", isPending: () => live });
    expect(unsavedForHost()).toBe(true);
    live = false;
    expect(unsavedForHost()).toBe(false);
    parked = true;
    expect(unsavedForHost()).toBe(true);
    journalSource.dispose();
    liveSource.dispose();
  } finally {
    setLiveState(() => null);
    parked = false;
    gateDirty = false;
  }
});

// A page with <base href> elsewhere: a relative report would carry the save token to
// the origin the base names, and HTML Clay would never hear the report.
test("a report goes to the page's own origin whatever its base says", async () => {
  const base = document.createElement("base");
  base.href = "https://cdn.example/assets/";
  document.head.append(base);
  try {
    edit();
    await jest.advanceTimersByTimeAsync(1000);
    expect(new URL(calls[0][0]).origin).toBe(window.location.origin);
  } finally {
    base.remove();
  }
});

// A background tab the browser freezes runs no timers, so it says so as it freezes,
// and reports afresh when it wakes.
test("a tab the browser freezes tells the host, and reports again when it wakes", async () => {
  edit();
  await jest.advanceTimersByTimeAsync(1000);
  document.dispatchEvent(new Event("freeze"));
  expect(calls).toHaveLength(2);
  expect(calls[1][1].keepalive).toBe(true);
  expect(bodies()[1]).toMatchObject({ unsaved: true, frozen: true });
  document.dispatchEvent(new Event("resume"));
  await jest.advanceTimersByTimeAsync(0);
  expect(bodies()[2]).toEqual({ tab: bodies()[0].tab, seq: 3, unsaved: true });
});

// An edit no input event announces (a drag, a script) while the dirty gate is
// already dirty, so no clay:dirty fires either: the minute check still finds it.
test("an edit no event announced is found while the page may hold work", async () => {
  document.documentElement.setAttribute("unsaved", "true");
  try {
    edit();
    unsaved = false;
    await jest.advanceTimersByTimeAsync(1000);
    expect(calls).toEqual([]);
    unsaved = true;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(bodies().map((b) => b.unsaved)).toEqual([true]);
  } finally {
    document.documentElement.removeAttribute("unsaved");
  }
});

// The host is asked every few seconds while typing. A capture there would cost a full
// serialization of a large page, run the page's capture hooks and close the open undo
// step, so the answer comes from the dirty gate alone.
test("the host's check reads the dirty gate and never captures the page", () => {
  captureOptions = [];
  currentBytes = "edited";
  try {
    expect(unsavedForHost()).toBe(false);
    gateDirty = true;
    expect(unsavedForHost()).toBe(true);
    expect(captureOptions).toEqual([]);
  } finally {
    currentBytes = "saved";
    gateDirty = false;
  }
});

// Pressing Ctrl+S to answer HTML Clay's Quit dialog and then "Check and quit" at once:
// the save's own event reports the page clean without waiting for the settle pause.
test("a save reports the page clean at once", async () => {
  edit();
  await jest.advanceTimersByTimeAsync(1000);
  unsaved = false;
  document.dispatchEvent(new CustomEvent("clay:save-saved"));
  await jest.advanceTimersByTimeAsync(0);
  expect(bodies().map((b) => b.unsaved)).toEqual([true, false]);
});

// Undoing back to the saved text fires input events while the host holds "unsaved":
// the page is checked again within a few seconds, not only at the next minute.
test("typing back to the saved text clears the report within seconds", async () => {
  edit();
  await jest.advanceTimersByTimeAsync(1000);
  unsaved = false;
  document.dispatchEvent(new Event("input"));
  await jest.advanceTimersByTimeAsync(5000);
  expect(bodies().map((b) => b.unsaved)).toEqual([true, false]);
});

// A tab closed while its first report is still on the wire: leaving clears it, the
// late answer changes nothing, and the hidden page reports nothing more.
test("a report still on its way when the tab closes is cleared", async () => {
  let land;
  answer = () => new Promise((resolve) => { land = resolve; });
  edit();
  await jest.advanceTimersByTimeAsync(1000);
  expect(calls).toHaveLength(1);
  answer = () => Promise.resolve({ ok: true, status: 204 });
  window.dispatchEvent(new Event("pagehide"));
  expect(bodies()[1]).toMatchObject({ unsaved: false });
  land({ ok: true, status: 204 });
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  try {
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("input"));
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toHaveLength(2);
  } finally {
    delete document.visibilityState;
  }
});

// A host restarting for an update fails /_/meta once: that is not "no reports here".
test("a host that failed to answer discovery is asked again", async () => {
  metaOutcome = "failed";
  extensions = [];
  edit();
  await jest.advanceTimersByTimeAsync(1000);
  expect(calls).toEqual([]);
  metaOutcome = "ok";
  extensions = ["unsaved-report-v1"];
  await jest.advanceTimersByTimeAsync(5000);
  expect(metaOptions[1]).toEqual({ fresh: true });
  expect(bodies().map((b) => b.unsaved)).toEqual([true]);
});

// A live store's change waits a few seconds for its checkpoint save; a host quitting
// in between would cut it off, so the host hears it as unsaved.
test("a live store change still waiting for its checkpoint is unsaved for the host", () => {
  expect(unsavedForHost()).toBe(false);
  setLiveState(() => "soon");
  try {
    expect(unsavedForHost()).toBe(true);
  } finally {
    setLiveState(() => null);
  }
});

// The close warning's module starts the page's own reporter at the first sign of work
// (a page nobody edits loads none of it). A fresh copy of the module, since earlier tests
// stopped or hid the one imported above. This file's test reporter holds "saved", so a
// report of the edited bytes can only come from the page's reporter.
test("the first sign of work starts the page's own reporter", async () => {
  await jest.isolateModulesAsync(() => import("../../src/core/unsaved-warning.js"));
  gateDirty = true;
  try {
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toEqual([]);
    document.dispatchEvent(new CustomEvent("clay:dirty"));
    for (let i = 0; i < 5; i++) await jest.advanceTimersByTimeAsync(1000);
    expect(bodies().map((b) => b.unsaved)).toEqual([true]);
  } finally {
    gateDirty = false;
  }
});
