import { jest } from "@jest/globals";

/**
 * The notice after a destructive write, and the one click that undoes it. Nothing
 * starts it yet, so these tests drive it by hand: one start per test, a queue of canned
 * server answers, and the toast module stood in for by spies.
 *
 * The module's own state lives at module scope, so every test gets a fresh registry,
 * and every test stops what it started.
 */

const TITLE = "Some saved data was removed";
const DONE_KEY = "clay:doc:/:data-guard-done";
const UNREACHED = "Could not reach the server. Try again.";

const liveToasts = new Map();
const toast = jest.fn();
const toastPersistent = jest.fn((message) => { liveToasts.set(message, true); });
const dismissPersistent = jest.fn((message) => { liveToasts.delete(message); });

await jest.unstable_mockModule("../../src/ui/toast.js", () => ({
  default: toast,
  toastPersistent,
  dismissPersistent,
}));

let fakeTimers = false;
const flush = async () => {
  if (fakeTimers) {
    await jest.advanceTimersByTimeAsync(20);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
};

const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const pending = () => {
  const box = {};
  box.promise = new Promise((resolve) => { box.release = resolve; });
  return box;
};

const event = (over = {}) => ({
  id: "e1",
  status: "pending",
  restorable: true,
  canRevert: true,
  lastWriteAt: 1,
  lossSummary: { provenance: "external", removedItems: 2, destroyedAtoms: 0 },
  preview: [{ key: "title", yours: "Mine", now: "Theirs" }],
  droppedAdditions: 1,
  ...over,
});

const notification = (action, data) =>
  new CustomEvent("clay:notification", { detail: { msgType: "data-loss", action, data } });

// What live-sync dispatches when it applies a change written outside this page, and what
// save.js dispatches once the merge that follows one has reached the host.
const outsideApplied = () =>
  document.dispatchEvent(new CustomEvent("clay:sync-applied", {
    detail: { seq: 1, source: "disk", lane: "saved", by: null, html: "", report: {}, conflictIds: [] },
  }));
const saved = () => document.dispatchEvent(new CustomEvent("clay:save-saved"));

const serverBar = () => {
  const bar = document.createElement("div");
  bar.setAttribute("data-htmlclay-guard", "");
  document.body.append(bar);
};

const lastActions = () => toastPersistent.mock.calls.at(-1)[2].actions;
const action = (label) => lastActions().find((entry) => entry.label === label);

let queue = [];
let reload;
let notice;
let fetchMock;

async function boot({ href = "/guard", entries = [] } = {}) {
  jest.resetModules();
  queue = [...entries];
  fetchMock = jest.fn(() => {
    const next = queue.shift();
    if (typeof next === "function") return next();
    return Promise.resolve(next);
  });
  global.fetch = fetchMock;
  notice = await import("../../src/sync/data-guard-notice.js");
  notice.start({ href, reload });
  await flush();
  return notice;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("savetoken");
  document.documentElement.removeAttribute("htmlclaytoken");
  sessionStorage.clear();
  delete window.clay;
  liveToasts.clear();
  toast.mockClear();
  toastPersistent.mockClear();
  dismissPersistent.mockClear();
  reload = jest.fn();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  notice?.stop();
  notice = null;
  delete global.fetch;
  jest.restoreAllMocks();
  jest.useRealTimers();
  fakeTimers = false;
});

test("the first read asks the given href, uncached, with the page it is asking about", async () => {
  await boot({ href: "/guard", entries: [answer(200, { event: null })] });

  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("http://localhost/guard");
  expect(init.method).toBe("GET");
  expect(init.cache).toBe("no-store");
  expect(init.headers["Document-URL"]).toBe(location.href);
  expect(init.credentials).toBe("same-origin");
});

test("a page with a save token sends no cookies, a page without one sends its own origin's", async () => {
  document.documentElement.setAttribute("savetoken", "tok-1");
  await boot({ entries: [answer(200, { event: null })] });

  expect(fetchMock.mock.calls[0][1].credentials).toBe("omit");
});

test("a pending event draws the notice, in the order the choices are offered", async () => {
  await boot({ entries: [answer(200, { event: event() })] });

  expect(toastPersistent).toHaveBeenCalledTimes(1);
  const [message, tone, { detail, actions }] = toastPersistent.mock.calls[0];
  expect([message, tone]).toEqual([TITLE, "warning"]);
  expect(actions.map((entry) => entry.label)).toEqual(["Restore", "Undo the change", "Keep as is"]);
  expect(detail).toContain("A change from outside this page removed 2 items.");
  expect(detail).toContain("title: Mine before, Theirs now.");
  expect(detail).toContain("Restoring removes 1 item added or changed since.");
});

test("no event draws nothing", async () => {
  await boot({ entries: [answer(200, { event: null })] });

  expect(toastPersistent).not.toHaveBeenCalled();
  expect(dismissPersistent).not.toHaveBeenCalled();
});

test("a raised notice draws, and raising the same event again draws nothing more", async () => {
  await boot({ entries: [answer(200, { event: null })] });

  document.dispatchEvent(notification("raised", event()));
  await flush();
  expect(toastPersistent).toHaveBeenCalledTimes(1);

  document.dispatchEvent(notification("raised", event()));
  await flush();
  expect(toastPersistent).toHaveBeenCalledTimes(1);
});

test("a raise right after an outside change waits, and draws nothing when the merge keeps it", async () => {
  fakeTimers = true;
  jest.useFakeTimers();
  await boot({ entries: [answer(200, { event: null }), answer(200, { event: null })] });

  await jest.advanceTimersByTimeAsync(200);
  outsideApplied();
  document.dispatchEvent(notification("raised", event()));
  await flush();
  expect(toastPersistent).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(400);
  saved();
  await jest.advanceTimersByTimeAsync(7000);

  expect(toastPersistent).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("a raise right after an outside change draws once when the re-read still holds the event", async () => {
  fakeTimers = true;
  jest.useFakeTimers();
  await boot({ entries: [answer(200, { event: null }), answer(200, { event: event() })] });

  await jest.advanceTimersByTimeAsync(200);
  outsideApplied();
  document.dispatchEvent(notification("raised", event()));
  await flush();
  expect(toastPersistent).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await jest.advanceTimersByTimeAsync(400);
  saved();
  await flush();
  expect(toastPersistent).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(5000);
  expect(toastPersistent).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("a raise with no outside change to wait for draws at once", async () => {
  fakeTimers = true;
  jest.useFakeTimers();
  await boot({ entries: [answer(200, { event: null })] });

  await jest.advanceTimersByTimeAsync(200);
  outsideApplied();
  await jest.advanceTimersByTimeAsync(10000);
  document.dispatchEvent(notification("raised", event()));
  await flush();

  expect(toastPersistent).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a resolved push during the wait cancels it, and nothing is drawn", async () => {
  fakeTimers = true;
  jest.useFakeTimers();
  await boot({ entries: [answer(200, { event: null })] });

  await jest.advanceTimersByTimeAsync(200);
  outsideApplied();
  document.dispatchEvent(notification("raised", event()));
  await flush();
  expect(toastPersistent).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(100);
  document.dispatchEvent(notification("resolved", { id: "e1" }));
  await jest.advanceTimersByTimeAsync(10000);

  expect(toastPersistent).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a wait with no save behind it reads and draws once the cap passes", async () => {
  fakeTimers = true;
  jest.useFakeTimers();
  await boot({ entries: [answer(200, { event: null }), answer(200, { event: event() })] });

  await jest.advanceTimersByTimeAsync(200);
  outsideApplied();
  document.dispatchEvent(notification("raised", event()));
  await jest.advanceTimersByTimeAsync(5999);
  expect(toastPersistent).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(1);
  expect(toastPersistent).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("resolved for the shown event takes the notice down", async () => {
  await boot({ entries: [answer(200, { event: event() })] });
  dismissPersistent.mockClear();

  document.dispatchEvent(notification("resolved", { id: "e1" }));
  await flush();

  expect(dismissPersistent).toHaveBeenCalledWith(TITLE, { now: true });
});

test("resolved for another event leaves the notice up", async () => {
  await boot({ entries: [answer(200, { event: event() })] });
  dismissPersistent.mockClear();

  document.dispatchEvent(notification("resolved", { id: "e2" }));
  await flush();

  expect(dismissPersistent).not.toHaveBeenCalled();
});

test("a read that answers after the event resolved draws nothing", async () => {
  const read = pending();
  await boot({ entries: [() => read.promise] });

  document.dispatchEvent(notification("resolved", { id: "e1" }));
  read.release(answer(200, { event: event() }));
  await flush();

  expect(toastPersistent).not.toHaveBeenCalled();
});

test("a read in flight when another event resolves draws nothing", async () => {
  const read = pending();
  await boot({ entries: [() => read.promise] });

  document.dispatchEvent(notification("resolved", { id: "e2" }));
  read.release(answer(200, { event: event() }));
  await flush();

  expect(toastPersistent).not.toHaveBeenCalled();
});

test("a read that answers no event after a raise does not take the notice down", async () => {
  const read = pending();
  await boot({ entries: [() => read.promise] });

  document.dispatchEvent(notification("raised", event()));
  await flush();
  expect(toastPersistent).toHaveBeenCalledTimes(1);
  dismissPersistent.mockClear();

  read.release(answer(200, { event: null }));
  await flush();

  expect(toastPersistent).toHaveBeenCalledTimes(1);
  expect(dismissPersistent).not.toHaveBeenCalled();
});

test("an event on the server takes its own bar down", async () => {
  serverBar();
  await boot({ entries: [answer(200, { event: event() })] });

  expect(document.querySelector("[data-htmlclay-guard]")).toBeNull();
});

test("an empty answer takes the server's bar down too", async () => {
  serverBar();
  await boot({ entries: [answer(200, { event: null })] });

  expect(document.querySelector("[data-htmlclay-guard]")).toBeNull();
});

test("a refusal to answer leaves the server's bar where it is", async () => {
  serverBar();
  await boot({ entries: [answer(500, {})] });

  expect(document.querySelector("[data-htmlclay-guard]")).not.toBeNull();
});

test("a network that never answers leaves the server's bar where it is", async () => {
  serverBar();
  await boot({ entries: [() => Promise.reject(new TypeError("offline"))] });

  expect(document.querySelector("[data-htmlclay-guard]")).not.toBeNull();
});

test("Restore posts the choice, reloads, and says so on the next start", async () => {
  await boot({ entries: [answer(200, { event: event() })] });

  queue.push(answer(200, { ok: true }));
  action("Restore").onClick();
  await flush();

  const [, init] = fetchMock.mock.calls[1];
  expect(init.method).toBe("POST");
  expect(init.headers["Document-URL"]).toBe(location.href);
  expect(JSON.parse(init.body)).toEqual({ id: "e1", choice: "restore" });
  expect(reload).toHaveBeenCalledTimes(1);
  expect(JSON.parse(sessionStorage.getItem(DONE_KEY))).toBe("restore");

  notice.stop();
  queue.push(answer(200, { event: null }));
  notice.start({ href: "/guard", reload });
  await flush();

  expect(toast).toHaveBeenCalledWith("Your saved data is back.", "success");
  expect(sessionStorage.getItem(DONE_KEY)).toBeNull();
});

test("Keep as is posts the choice, keeps the page, and says so", async () => {
  await boot({ entries: [answer(200, { event: event() })] });

  queue.push(answer(200, { ok: true }));
  action("Keep as is").onClick();
  await flush();

  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: "e1", choice: "dismiss" });
  expect(reload).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith("Kept the page as it is.", "info");
  expect(sessionStorage.getItem(DONE_KEY)).toBeNull();
});

test("404 takes the notice down and points at the page", async () => {
  await boot({ entries: [answer(200, { event: event() })] });
  dismissPersistent.mockClear();

  queue.push(answer(404, {}));
  action("Restore").onClick();
  await flush();

  expect(dismissPersistent).toHaveBeenCalledWith(TITLE, { now: true });
  expect(toast).toHaveBeenCalledWith(expect.stringContaining("already taken care of"), "info");
});

test("409 reads the server again", async () => {
  await boot({ entries: [answer(200, { event: event() })] });

  queue.push(answer(409, {}), answer(200, { event: event({ lastWriteAt: 2 }) }));
  action("Restore").onClick();
  await flush();

  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "POST", "GET"]);
  expect(toastPersistent).toHaveBeenCalledTimes(2);
  expect(toast).toHaveBeenCalledWith(expect.stringContaining("changed after the notice appeared"), "warning");
});

test("422 on Restore redraws without the choice the server just refused", async () => {
  await boot({ entries: [answer(200, { event: event() })] });

  queue.push(answer(422, { ok: false }));
  action("Restore").onClick();
  await flush();

  expect(toastPersistent).toHaveBeenCalledTimes(2);
  expect(lastActions().map((entry) => entry.label)).toEqual(["Undo the change", "Keep as is"]);
  expect(toast).toHaveBeenCalledWith("That data no longer fits this page, so it could not be restored.", "warning");
});

test("a 500 keeps the notice and names the failure", async () => {
  await boot({ entries: [answer(200, { event: event() })] });
  dismissPersistent.mockClear();

  queue.push(answer(500, {}));
  action("Restore").onClick();
  await flush();

  expect(dismissPersistent).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(UNREACHED, "error");
});

test("a dropped connection keeps the notice and names the failure", async () => {
  await boot({ entries: [answer(200, { event: event() })] });
  dismissPersistent.mockClear();

  queue.push(() => Promise.reject(new TypeError("offline")));
  action("Restore").onClick();
  await flush();

  expect(dismissPersistent).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith(UNREACHED, "error");
});

test("two presses while the first is in flight post once", async () => {
  await boot({ entries: [answer(200, { event: event() })] });

  const post = pending();
  queue.push(() => post.promise);
  action("Restore").onClick();
  action("Restore").onClick();
  await flush();

  expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);

  post.release(answer(200, { ok: true }));
  await flush();
  expect(reload).toHaveBeenCalledTimes(1);
});

test("nothing that can be undone offers one choice, and says why", async () => {
  await boot({ entries: [answer(200, { event: event({ restorable: false, canRevert: false }) })] });

  expect(lastActions().map((entry) => entry.label)).toEqual(["Keep as is"]);
  expect(toastPersistent.mock.calls[0][2].detail.endsWith("It cannot be restored from here.")).toBe(true);
});

test("a save reads soon after it", async () => {
  fakeTimers = true;
  jest.useFakeTimers();
  await boot({ entries: [answer(200, { event: null }), answer(200, { event: null })] });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await jest.advanceTimersByTimeAsync(6500);
  document.dispatchEvent(new CustomEvent("clay:save-saved"));
  await jest.advanceTimersByTimeAsync(1499);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await jest.advanceTimersByTimeAsync(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("a burst of saves reads once", async () => {
  fakeTimers = true;
  jest.useFakeTimers();
  await boot({ entries: [answer(200, { event: null }), answer(200, { event: null })] });

  await jest.advanceTimersByTimeAsync(6500);
  document.dispatchEvent(new CustomEvent("clay:save-saved"));
  document.dispatchEvent(new CustomEvent("clay:save-saved"));
  document.dispatchEvent(new CustomEvent("clay:save-saved"));
  await jest.advanceTimersByTimeAsync(1500);

  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("coming back to the tab reads only once the last read is old enough", async () => {
  fakeTimers = true;
  jest.useFakeTimers();
  await boot({ entries: [answer(200, { event: null }), answer(200, { event: null })] });

  await jest.advanceTimersByTimeAsync(29999 - 20);
  document.dispatchEvent(new Event("visibilitychange"));
  await jest.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await jest.advanceTimersByTimeAsync(1);
  document.dispatchEvent(new Event("visibilitychange"));
  await jest.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test("a href on another origin starts nothing", async () => {
  await boot({ href: "https://example.com/guard", entries: [answer(200, { event: event() })] });

  expect(fetchMock).not.toHaveBeenCalled();
  document.dispatchEvent(notification("raised", event()));
  await flush();
  expect(toastPersistent).not.toHaveBeenCalled();
});

test("stop takes the listeners out", async () => {
  await boot({ entries: [answer(200, { event: null })] });

  notice.stop();
  document.dispatchEvent(notification("raised", event()));
  document.dispatchEvent(new CustomEvent("clay:save-saved"));
  await flush();

  expect(toastPersistent).not.toHaveBeenCalled();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("a read that says more items were added since redraws the notice", async () => {
  fakeTimers = true;
  jest.useFakeTimers();
  await boot({ entries: [answer(200, { event: event({ droppedAdditions: 0 }) }), answer(200, { event: event({ droppedAdditions: 3 }) })] });

  expect(toastPersistent).toHaveBeenCalledTimes(1);
  expect(toastPersistent.mock.calls[0][2].detail).not.toContain("Restoring removes");

  await jest.advanceTimersByTimeAsync(30000);
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();

  expect(toastPersistent).toHaveBeenCalledTimes(2);
  expect(toastPersistent.mock.calls[1][2].detail).toContain("Restoring removes 3 items added or changed since.");
});

test("Restore over edits that cannot be saved posts nothing and asks for a save", async () => {
  await boot({ entries: [answer(200, { event: event() })] });
  window.clay = { hasUnsavedChanges: () => true, save: { flush: async () => {} } };

  queue.push(answer(200, { ok: true }));
  action("Restore").onClick();
  await flush();

  expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(0);
  expect(reload).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith("Save your changes first, then try again.", "warning");
});

test("Restore over edits saves them first, then posts once", async () => {
  await boot({ entries: [answer(200, { event: event() })] });
  let unsaved = true;
  const flushEdits = jest.fn(async () => { unsaved = false; });
  window.clay = { hasUnsavedChanges: () => unsaved, save: { flush: flushEdits } };

  queue.push(answer(200, { ok: true }));
  action("Restore").onClick();
  await flush();

  expect(flushEdits).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
  expect(reload).toHaveBeenCalledTimes(1);
});

test("Keep as is posts without saving first", async () => {
  await boot({ entries: [answer(200, { event: event() })] });
  const flushEdits = jest.fn(async () => {});
  window.clay = { hasUnsavedChanges: () => true, save: { flush: flushEdits } };

  queue.push(answer(200, { ok: true }));
  action("Keep as is").onClick();
  await flush();

  expect(flushEdits).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
});

test("a read in flight when Keep as is answers draws nothing afterwards", async () => {
  fakeTimers = true;
  jest.useFakeTimers();
  const read = pending();
  await boot({ entries: [answer(200, { event: event() }), () => read.promise] });

  await jest.advanceTimersByTimeAsync(30000);
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(2);

  const keep = action("Keep as is");
  toastPersistent.mockClear();
  queue.push(answer(200, { ok: true }));
  keep.onClick();
  await flush();

  read.release(answer(200, { event: event() }));
  await flush();

  expect(toastPersistent).not.toHaveBeenCalled();
});

test("a late 200 for an older event leaves the newer notice up", async () => {
  const post = pending();
  await boot({ entries: [answer(200, { event: event() })] });
  queue.push(() => post.promise);
  action("Keep as is").onClick();
  await flush();

  document.dispatchEvent(notification("raised", event({ id: "e2" })));
  await flush();
  expect(toastPersistent).toHaveBeenCalledTimes(2);
  toastPersistent.mockClear();
  dismissPersistent.mockClear();

  post.release(answer(200, { ok: true }));
  await flush();

  expect(toastPersistent).not.toHaveBeenCalled();
  expect(dismissPersistent).not.toHaveBeenCalled();
});

test("a late 404 for an older event leaves the newer notice up", async () => {
  const post = pending();
  await boot({ entries: [answer(200, { event: event() })] });
  queue.push(() => post.promise);
  action("Restore").onClick();
  await flush();

  document.dispatchEvent(notification("raised", event({ id: "e2" })));
  await flush();
  expect(toastPersistent).toHaveBeenCalledTimes(2);
  toastPersistent.mockClear();
  dismissPersistent.mockClear();

  post.release(answer(404, {}));
  await flush();

  expect(toastPersistent).not.toHaveBeenCalled();
  expect(dismissPersistent).not.toHaveBeenCalled();
});

test("a late 422 for an older event does not redraw it over the newer notice", async () => {
  const post = pending();
  await boot({ entries: [answer(200, { event: event() })] });
  queue.push(() => post.promise);
  action("Restore").onClick();
  await flush();

  document.dispatchEvent(notification("raised", event({ id: "e2" })));
  await flush();
  expect(toastPersistent).toHaveBeenCalledTimes(2);
  toastPersistent.mockClear();

  post.release(answer(422, { ok: false }));
  await flush();

  expect(toastPersistent).not.toHaveBeenCalled();
});

test("a 401 and a 403 ask for a reload", async () => {
  await boot({ entries: [answer(200, { event: event() })] });

  queue.push(answer(401, {}));
  action("Restore").onClick();
  await flush();
  expect(toast).toHaveBeenCalledWith("Reload the page, then try again.", "error");

  toast.mockClear();
  queue.push(answer(403, {}));
  action("Restore").onClick();
  await flush();
  expect(toast).toHaveBeenCalledWith("Reload the page, then try again.", "error");
  expect(toast).not.toHaveBeenCalledWith(UNREACHED, "error");
});

test("a notice that can be undone says the undo takes later edits with it", async () => {
  await boot({ entries: [answer(200, { event: event({ restorable: false, canRevert: true }) })] });

  expect(toastPersistent.mock.calls[0][2].detail.endsWith("Undo the change also removes edits made since.")).toBe(true);
});

test("each reason says what happened, and the tone stays calm for what you typed", async () => {
  const cases = [
    ["recent", "A change from outside this page removed something you typed", "info"],
    ["all-typed", "A change from outside this page removed everything you typed", "info"],
    ["emptied", "A change from outside this page emptied this page's data", "warning"],
    ["unreadable", "A change from outside this page left its data unreadable", "warning"],
  ];
  for (const [reason, title, tone] of cases) {
    liveToasts.clear();
    toastPersistent.mockClear();
    await boot({ entries: [answer(200, { event: event({ id: reason, reason, typed: [], canPutBack: true }) })] });
    expect(liveToasts.size).toBe(1);
    expect([toastPersistent.mock.calls[0][0], toastPersistent.mock.calls[0][1]]).toEqual([title, tone]);
    notice.stop();
  }
});

test("a recent loss names what you typed and how long ago, with Put it back", async () => {
  await boot({ entries: [answer(200, { event: event({
    reason: "recent",
    canPutBack: true,
    typed: [{ path: "items[id:5].note", yours: "mine", at: Date.now() - 3 * 60000 - 500 }],
  }) })] });

  expect(liveToasts.size).toBe(1);
  const [title, tone, { detail }] = toastPersistent.mock.calls[0];
  expect(title).toBe("A change from outside this page removed something you typed");
  expect(tone).toBe("info");
  expect(detail).toContain('note: "mine"');
  expect(detail).toContain("You typed it 3 minutes ago.");
  expect(lastActions().map((entry) => entry.label)).toEqual(["Put it back", "Undo the change", "Keep the change"]);
});

test("an all-typed loss shows three rows and counts the rest, with no minute line", async () => {
  const typed = [1, 2, 3, 4, 5].map((n) => ({ path: `item_${n}.body-text`, yours: `mine ${n}`, at: Date.now() - 120000 }));
  await boot({ entries: [answer(200, { event: event({ reason: "all-typed", typed, canPutBack: true }) })] });

  expect(liveToasts.size).toBe(1);
  const { detail } = toastPersistent.mock.calls[0][2];
  expect(detail).toContain('body text: "mine 1"; body text: "mine 2"; body text: "mine 3" and 2 more.');
  expect(detail).not.toContain("You typed");
});

test("Put it back posts the choice, reloads, and says so on the next start", async () => {
  await boot({ entries: [answer(200, { event: event({ reason: "recent", canPutBack: true, typed: [{ path: "note", yours: "mine", at: Date.now() }] }) })] });

  queue.push(answer(200, { ok: true }));
  action("Put it back").onClick();
  await flush();

  const [, init] = fetchMock.mock.calls[1];
  expect(init.method).toBe("POST");
  expect(JSON.parse(init.body)).toEqual({ id: "e1", choice: "put-back" });
  expect(reload).toHaveBeenCalledTimes(1);
  expect(JSON.parse(sessionStorage.getItem(DONE_KEY))).toBe("put-back");
});

test("an event that cannot be put back offers no Put it back", async () => {
  await boot({ entries: [answer(200, { event: event({ reason: "recent", canPutBack: false, typed: [{ path: "note", yours: "mine", at: Date.now() }] }) })] });

  expect(liveToasts.size).toBe(1);
  expect(lastActions().map((entry) => entry.label)).toEqual(["Undo the change", "Keep the change"]);
  expect(action("Put it back")).toBeUndefined();
});

test("an event with no reason keeps Restore and Keep as is", async () => {
  await boot({ entries: [answer(200, { event: event({ canPutBack: true }) })] });

  expect(liveToasts.size).toBe(1);
  expect(toastPersistent.mock.calls[0][0]).toBe(TITLE);
  expect(lastActions().map((entry) => entry.label)).toEqual(["Restore", "Undo the change", "Keep as is"]);
});

test("a second event with another reason leaves exactly one notice", async () => {
  await boot({ entries: [answer(200, { event: null })] });

  document.dispatchEvent(notification("raised", event({ reason: "recent", canPutBack: true, typed: [{ path: "note", yours: "mine", at: Date.now() }] })));
  await flush();
  expect(liveToasts.size).toBe(1);

  document.dispatchEvent(notification("raised", event({ id: "e2", reason: "emptied", typed: [], restorable: false })));
  await flush();

  expect(liveToasts.size).toBe(1);
  expect(liveToasts.has("A change from outside this page emptied this page's data")).toBe(true);
  expect(liveToasts.has("A change from outside this page removed something you typed")).toBe(false);
});
