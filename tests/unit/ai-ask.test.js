import { jest } from "@jest/globals";

let wire;
let ai;
let resetHostMeta;
let sockets;
let sent;
let runFileRequests;

class FakeEventSource {
  constructor(url) {
    this.url = url;
    sockets.push(this);
    Promise.resolve().then(() => this.onopen && this.onopen());
  }
  close() {}
}

const DIFF = "diff --git a/a.go b/a.go\n--- a/a.go\n+++ b/a.go\n@@ -1 +1 @@\n-old\n+new\n";

function installHost({ helpers = [{ name: "ai-tools", state: "ready" }] } = {}) {
  global.fetch = jest.fn(async (url, init = {}) => {
    const path = new URL(String(url), window.location.origin).pathname;
    if (path === "/_/meta" || path === "/_/meta/tok-1") {
      return { ok: true, text: async () => JSON.stringify({ spec: 1, extensions: ["wire"], document: { helpers } }) };
    }
    if (path === "/_/wire/send") {
      sent.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ delivered: 1 }) };
    }
    if (path.startsWith("/_/wire/runs/")) {
      const headers = init.headers || {};
      runFileRequests.push({ path, headers });
      // The host finds the document from its address and checks the token: without
      // both it answers 404 (design.md 0.2).
      if (headers["Document-URL"] !== window.location.href || headers["Save-Token"] !== "tok-1") {
        return { ok: false, status: 404, text: async () => "" };
      }
      return { ok: true, status: 200, text: async () => DIFF };
    }
    throw new Error(`unexpected fetch ${path}`);
  });
}

const deliver = (frame) => sockets[0].onmessage({ data: JSON.stringify(frame) });
const settle = () => jest.advanceTimersByTimeAsync(1);
const MINUTE = 60000;

const RULES = {
  reviews: ["#reviews > article", { id: "@data-id", title: ".title", summary: ".summary", diff: ".diff", files: [".file", { path: "@data-path" }] }],
};

beforeAll(async () => {
  global.EventSource = FakeEventSource;
  window.EventSource = FakeEventSource;
  ({ wire } = await import("../../src/plugins/wire.js"));
  ({ ai } = await import("../../src/plugins/ai.js"));
  ({ resetHostMeta } = await import("../../src/core/host-meta.js"));
});

beforeEach(() => {
  jest.useFakeTimers();
  sockets = [];
  sent = [];
  runFileRequests = [];
  resetHostMeta();
  installHost();
  document.documentElement.setAttribute("savetoken", "tok-1");
  document.head.innerHTML =
    `<script type="application/json" data-rules-name="api" data-rules-version="1">${JSON.stringify(RULES)}</script>` +
    '<script type="text/x-clay-instructions" name="review">Explain the change.</script>' +
    '<script type="text/x-clay-instructions" name="level-reviewer">For a reviewer.</script>';
  window.clay = { wire };
});

afterEach(async () => {
  for (const rec of wire.list()) wire.cancel(rec.id);
  await settle();
  jest.useRealTimers();
});

function askReview(extra = {}) {
  return ai.ask({ request: "What changed?", instructions: ["review", "level-reviewer"], result: "reviews", omit: ["id", "diff"], sources: true, ...extra });
}

test("ask sends one ai-tools request with the instruction text and the answer shape", async () => {
  const handle = askReview();
  await settle();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ helper: "ai-tools", document: "none", id: handle.id });
  expect(sent[0].payload).toEqual({
    request: "What changed?",
    instructions: [{ name: "review", text: "Explain the change." }, { name: "level-reviewer", text: "For a reviewer." }],
    tools: "read",
    folder: "remembered",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "summary", "files"],
      properties: {
        title: { type: "string" },
        summary: { type: "string" },
        files: { type: "array", items: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" } } } },
      },
    },
    sources: true,
    engine: "",
  });
});

test("done carries the data, engine, model, folder name and fetched sources", async () => {
  const phases = [];
  const handle = askReview({ onStatus: (status) => phases.push(status.phase) });
  await settle();
  deliver({ type: "wire/ack", id: handle.id, payload: { mode: "jsonl", budgetMs: 1200000, parked: true } });
  deliver({ type: "wire/status", id: handle.id, text: "Reading", payload: { phase: "working" } });
  deliver({
    type: "wire/done",
    id: handle.id,
    payload: {
      data: { title: "Sessions", summary: "Refresh moved.", files: [] },
      sources: [{ id: "diff", kind: "git", base: "aaa", head: "bbb", url: "/_/wire/runs/r1/files/diff", bytes: DIFF.length, sha256: "x", truncated: false, skipped: ["package-lock.json"] }],
      folder: { name: "app" },
      grant: { level: "read", remembered: true },
      engine: "claude",
      model: "claude-sonnet",
    },
  });
  const outcome = await handle.done;
  expect(phases).toEqual(["working"]);
  expect(outcome).toMatchObject({
    state: "done",
    data: { title: "Sessions", summary: "Refresh moved.", files: [] },
    folder: { name: "app" },
    grant: { level: "read", remembered: true },
    engine: "claude",
    model: "claude-sonnet",
    error: null,
  });
  expect(outcome.sources.diff).toMatchObject({ id: "diff", kind: "git", base: "aaa", head: "bbb", skipped: ["package-lock.json"] });
  expect(outcome.sources.diff.url).toBeUndefined();
  await expect(outcome.sources.diff.text()).resolves.toBe(DIFF);
  expect(runFileRequests).toHaveLength(1);
  expect(runFileRequests[0].path).toBe("/_/wire/runs/r1/files/diff");
});

test("a run file the host refuses rejects text() with source_unavailable", async () => {
  document.documentElement.removeAttribute("savetoken");
  const handle = askReview();
  await settle();
  deliver({ type: "wire/done", id: handle.id, payload: { data: {}, sources: [{ id: "diff", url: "/_/wire/runs/r1/files/diff" }] } });
  const outcome = await handle.done;
  await expect(outcome.sources.diff.text()).rejects.toMatchObject({ code: "source_unavailable" });
});

test("a host error arrives as error.code and error.message", async () => {
  const handle = askReview();
  await settle();
  deliver({ type: "wire/error", id: handle.id, text: "This repository is a partial clone.", payload: { source: "host", code: "source_unsupported" } });
  await expect(handle.done).resolves.toMatchObject({
    state: "error",
    data: null,
    error: { code: "source_unsupported", message: "This repository is a partial clone." },
  });
});

// The host parks a request for up to 5 minutes while it asks, then acks again when
// the run starts, with the run's own 15 minute budget (design.md 0.2).
test("the run's own ack moves the deadline, so a run after a long park is not cut", async () => {
  const handle = askReview();
  await settle();
  deliver({ type: "wire/ack", id: handle.id, payload: { mode: "jsonl", budgetMs: 1200000, parked: true } });
  await jest.advanceTimersByTimeAsync(10 * MINUTE);
  deliver({ type: "wire/ack", id: handle.id, payload: { mode: "jsonl", budgetMs: 900000 } });
  await jest.advanceTimersByTimeAsync(14 * MINUTE);
  expect(handle.state).toBe("acked");
  deliver({ type: "wire/done", id: handle.id, payload: { data: { title: "t" } } });
  await expect(handle.done).resolves.toMatchObject({ state: "done", data: { title: "t" } });
});

test("a page without the wire, as in draft mode, gets ai_unavailable and sends nothing", async () => {
  window.clay = {};
  const outcome = await askReview().done;
  expect(outcome).toMatchObject({ state: "error", error: { code: "ai_unavailable" } });
  expect(global.fetch).not.toHaveBeenCalled();
  await expect(ai.available()).resolves.toBeNull();
});

test("a missing instruction or an oversized request is refused before anything is sent", async () => {
  await expect(ai.ask({ request: "x", instructions: ["nope"] }).done).resolves.toMatchObject({ error: { code: "instruction_missing" } });
  await expect(ai.ask({ request: "x".repeat(64 * 1024 + 1) }).done).resolves.toMatchObject({ error: { code: "invalid_request" } });
  await expect(ai.ask({ request: "x", tools: "write" }).done).resolves.toMatchObject({ error: { code: "invalid_request" } });
  expect(sent).toHaveLength(0);
});

test("available reports the ai-tools helper's state, and null when the host has none", async () => {
  await expect(ai.available()).resolves.toBe("ready");
  resetHostMeta();
  installHost({ helpers: [{ name: "ai-edit", state: "ready" }] });
  await expect(ai.available()).resolves.toBeNull();
});
