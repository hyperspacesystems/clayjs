import { jest } from "@jest/globals";

/**
 * A hidden edit tab takes in a peer's save while it is hidden.
 *
 * Chrome runs no animation frames in a hidden tab. LiveSync applied every peer frame
 * on the next animation frame and adopts the frame's stamp only once it is applied,
 * so a hidden tab kept the stamp of the version before the peer's save, and its own
 * next save was refused as a conflict (six-tab browser pass, 3 runs of 3).
 *
 *   - hidden, a stamped peer frame is applied without an animation frame, and the
 *     tab's next save names the peer's version;
 *   - a frame that was waiting for an animation frame when the page was hidden is
 *     moved to the hidden schedule and applied.
 *
 * jsdom reports every page visible and has no MessageChannel, so each test makes the
 * page hidden and supplies a channel. The animation frame here never runs.
 */

class FakeEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
  }
  close() {}
}

class FakeChannel {
  constructor() {
    const port1 = { onmessage: null, closed: false, close() { this.closed = true; } };
    this.port1 = port1;
    this.port2 = { postMessage() { setTimeout(() => { if (!port1.closed) port1.onmessage?.({ data: null }); }, 0); } };
  }
}

const META = { spec: 1, extensions: ["sync", "conditional"], document: { etag: "E0" } };
const savePosts = [];
let saveResponse = () => ({ status: 200, body: { msg: "Saved", etag: "E2" } });

function respond(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return Promise.resolve({
    ok: status < 400,
    status,
    statusText: String(status),
    text: async () => text,
    json: async () => JSON.parse(text),
  });
}

let LiveSync;
let snapshot;
let gate;
let save;
let etag;
let hidden = false;
const realRaf = window.requestAnimationFrame;
const realCancel = window.cancelAnimationFrame;

beforeAll(async () => {
  window.clayEditMode = true;
  global.EventSource = FakeEventSource;
  window.EventSource = FakeEventSource;
  window.scrollTo = () => {};
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  global.fetch = jest.fn((url, options = {}) => {
    const u = String(url);
    const method = (options.method || "GET").toUpperCase();
    if (u.includes("/_/meta")) return respond(200, META);
    if (method === "POST" && u.includes("/_/sync")) return respond(200, { success: true });
    if (method === "POST" && u.includes("/_/save")) {
      savePosts.push({ url: u, headers: options.headers });
      const r = saveResponse(options);
      return respond(r.status, r.body);
    }
    return respond(404, "");
  });

  const liveSyncModule = await import("../../src/sync/live-sync.js");
  ({ LiveSync } = liveSyncModule);
  liveSyncModule.liveSync.stop();
  snapshot = await import("../../src/core/snapshot.js");
  gate = await import("../../src/lib/dirty-gate.js");
  save = await import("../../src/core/save.js");
  etag = await import("../../src/core/etag.js");
  await etag.seedEtag();
});

afterAll(() => {
  delete document.hidden;
  delete global.MessageChannel;
});

beforeEach(async () => {
  savePosts.length = 0;
  hidden = false;
  global.MessageChannel = FakeChannel;
  window.requestAnimationFrame = jest.fn(() => 7);
  window.cancelAnimationFrame = jest.fn();
  document.documentElement.removeAttribute("autosave");
  document.documentElement.setAttribute("savestatus", "saved");
  document.body.innerHTML = "";
  await Promise.resolve();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
  etag.recordEtag("E0");
});

afterEach(() => {
  window.requestAnimationFrame = realRaf;
  window.cancelAnimationFrame = realCancel;
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (predicate, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + what);
    await wait(10);
  }
};

const BOARD = '<p class="card" data-id="one">One</p><p class="card" data-id="two">Two</p>';

async function settle(body) {
  document.body.innerHTML = body;
  const { forComparison, forDirty } = snapshot.captureForComparisonAndDirty({ flushUndo: false });
  save.setLastSavedBaselines(forComparison, forDirty);
  save.setUnsavedChanges(false);
  await Promise.resolve();
  gate.gateClearIfUnchanged(gate.gateCaptureToken());
}

function peerFrame(seq, stamp) {
  const html = snapshot.serializeForSync(snapshot.captureSnapshot({ flushUndo: false })).replace(">Two<", ">Two FROM PEER<");
  return { data: JSON.stringify({ html, sender: "peer", seq, etag: stamp }) };
}

test("a hidden tab applies a peer's stamped frame without an animation frame, and its next save names that version", async () => {
  await settle(BOARD);
  const sync = new LiveSync();
  sync.start("index.html");
  await sync._ready;
  try {
    hidden = true;
    sync.sse.onmessage(peerFrame(10, "E1"));
    await until(() => etag.lastSeenEtag() === "E1", "the peer's stamp");
    expect(document.querySelector('[data-id="two"]').textContent).toBe("Two FROM PEER");
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();

    document.querySelector('[data-id="one"]').textContent = "One EDITED WHILE HIDDEN";
    await Promise.resolve();
    const result = await save.savePage();
    expect(result.ok).toBe(true);
    expect(savePosts.at(-1).headers["If-Match"]).toBe("E1");
  } finally {
    sync.stop();
  }
});

test("a frame waiting for an animation frame when the page is hidden is applied on the hidden schedule", async () => {
  await settle(BOARD);
  const sync = new LiveSync();
  sync.start("index.html");
  await sync._ready;
  try {
    sync.sse.onmessage(peerFrame(11, "E1"));
    expect(window.requestAnimationFrame).toHaveBeenCalledTimes(1);
    await wait(30);
    expect(document.querySelector('[data-id="two"]').textContent).toBe("Two");
    expect(etag.lastSeenEtag()).toBe("E0");

    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await until(() => etag.lastSeenEtag() === "E1", "the peer's stamp after hiding");
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(7);
    expect(document.querySelector('[data-id="two"]').textContent).toBe("Two FROM PEER");
  } finally {
    sync.stop();
  }
});
