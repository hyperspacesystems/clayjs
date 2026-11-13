/**
 * A link marked clay-wait-drafts waits for this page's last changes to reach the download
 * page before it navigates, up to the download deadline: the same wait the prompt's Download
 * button makes. A new tab or a modified click leaves this page open, so it does not wait.
 * Hyperclay's trial bar renders its Download and Host links in an open shadow root.
 *
 * Every case shares one boot: a boot's document listeners outlive the module
 * registry, so a second boot on the same document would answer a later click as well.
 */
import { afterEach, expect, jest, test } from "@jest/globals";
import { IDBFactory } from "fake-indexeddb";
import { hostOf, $ } from "./helpers/editor-ui.js";
import { bootPage, noDatabase, pause, type, useFactory, waitFor } from "./helpers/visitor-drafts-idb.js";

const holds = [];

afterEach(noDatabase);
afterEach(async () => {
  for (const release of holds.splice(0)) await release();
  await pause(100);
  delete window.hyperclayBar;
});

let page = null;
let factory = null;

async function booted() {
  if (page) return page;
  factory = new IDBFactory();
  useFactory(factory);
  page = await bootPage({ slot: "wait-links" });
  type("saved before the click");
  expect((await page.clay.save()).ok).toBe(true);
  return page;
}

async function holdDatabase(key) {
  const db = await new Promise((resolve, reject) => {
    const req = factory.open("clay-visitor-drafts", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  let release = false;
  const tx = db.transaction("records", "readwrite");
  const store = tx.objectStore("records");
  function hold() { store.get(key).onsuccess = () => { if (!release) hold(); }; }
  hold();
  const completed = new Promise((resolve) => { tx.oncomplete = resolve; });
  return async () => { release = true; await completed; db.close(); };
}

const hold = async () => {
  const release = await holdDatabase((await booted()).key);
  holds.push(release);
  return release;
};

// `window.location` as a browser runs a followed link: the page is left. jsdom cannot
// navigate, so the calls are recorded and the real location put back by the caller.
function followed() {
  const real = window.location;
  const calls = [];
  const fake = {
    href: real.href,
    pathname: real.pathname,
    search: real.search,
    hash: real.hash,
    origin: real.origin,
    assign(url) { calls.push(url); },
  };
  Object.defineProperty(window, "location", { value: fake, configurable: true });
  return { calls, restore: () => Object.defineProperty(window, "location", { value: real, configurable: true }) };
}

function waitLink({ wait = true, target = null } = {}) {
  const link = document.createElement("a");
  if (wait) link.setAttribute("clay-wait-drafts", "");
  link.setAttribute("href", "/_/download/x.html");
  if (target) link.setAttribute("target", target);
  link.textContent = "Download your copy";
  document.body.append(link);
  return link;
}

const click = (link, init = {}) => {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  link.dispatchEvent(event);
  return event;
};

test("with nothing pending a plain click on a clay-wait-drafts link goes ahead untouched", async () => {
  const boot = await booted();
  const location = followed();
  const link = waitLink();
  try {
    const event = click(link);
    expect(event.defaultPrevented).toBe(false);
    await pause();
    expect(location.calls).toEqual([]);
    expect(boot.clay.hasUnsavedChanges()).toBe(false);
  } finally {
    location.restore();
  }
});

test("a plain click on a clay-wait-drafts link waits for the pending save, then follows it", async () => {
  await booted();
  const release = await hold();
  const location = followed();
  const link = waitLink();
  try {
    type("typed just before the click");
    const event = click(link);
    expect(event.defaultPrevented).toBe(true);
    await pause(200);
    expect(location.calls).toEqual([]);
    await release();
    await waitFor(() => location.calls.length > 0, "the link to be followed");
    expect(location.calls).toEqual([link.href]);
  } finally {
    location.restore();
  }
});

test("a ctrl-click does not wait", async () => {
  await booted();
  await hold();
  const location = followed();
  const link = waitLink();
  try {
    type("typed just before the ctrl-click");
    const event = click(link, { ctrlKey: true });
    expect(event.defaultPrevented).toBe(false);
    await pause();
    expect(location.calls).toEqual([]);
  } finally {
    location.restore();
  }
});

test("a link for a new tab does not wait", async () => {
  await booted();
  await hold();
  const location = followed();
  const link = waitLink({ target: "_blank" });
  try {
    type("typed just before the new-tab click");
    const event = click(link);
    expect(event.defaultPrevented).toBe(false);
    await pause();
    expect(location.calls).toEqual([]);
  } finally {
    location.restore();
  }
});

test("a link without the attribute is left alone", async () => {
  await booted();
  await hold();
  const location = followed();
  const link = waitLink({ wait: false });
  try {
    type("typed just before the ordinary click");
    const event = click(link);
    expect(event.defaultPrevented).toBe(false);
    await pause();
    expect(location.calls).toEqual([]);
  } finally {
    location.restore();
  }
});

test("a save that never settles still lets the link go after the 3 s deadline", async () => {
  await booted();
  await hold();
  const location = followed();
  const link = waitLink();
  try {
    type("typed just before the deadline click");
    const started = Date.now();
    const event = click(link);
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => location.calls.length > 0, "the link to be followed", 4500);
    expect(Date.now() - started).toBeGreaterThanOrEqual(3000);
    expect(location.calls).toEqual([link.href]);
  } finally {
    location.restore();
  }
}, 10000);

test("a clay-wait-drafts link inside an open shadow root, like Hyperclay's trial bar, waits too", async () => {
  await booted();
  const release = await hold();
  const location = followed();
  const bar = document.createElement("div");
  document.body.append(bar);
  const root = bar.attachShadow({ mode: "open" });
  const link = document.createElement("a");
  link.setAttribute("clay-wait-drafts", "");
  link.setAttribute("href", "/_/download/x.html");
  link.textContent = "Download your copy";
  root.append(link);
  try {
    type("typed just before the bar click");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, button: 0 });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await pause(200);
    expect(location.calls).toEqual([]);
    await release();
    await waitFor(() => location.calls.length > 0, "the link to be followed");
    expect(location.calls).toEqual([link.href]);
  } finally {
    location.restore();
    bar.remove();
  }
});

test("a second click while the first one waits is held and navigates once", async () => {
  await booted();
  const release = await hold();
  const location = followed();
  const link = waitLink();
  try {
    type("typed before a double click");
    const first = click(link);
    const second = click(link);
    expect(first.defaultPrevented).toBe(true);
    expect(second.defaultPrevented).toBe(true);
    await release();
    await waitFor(() => location.calls.length > 0, "the link to be followed");
    await pause(100);
    expect(location.calls).toEqual([link.href]);
  } finally {
    location.restore();
  }
});
