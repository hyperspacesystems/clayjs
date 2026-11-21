import { jest } from "@jest/globals";

let wire;
let programs;
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

const NOTES = "# Release notes\n\n- Sessions refresh on their own.\n";

function installHost({ helpers = [{ name: "programs", state: "ready" }] } = {}) {
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
      if (headers["Document-URL"] !== window.location.href || headers["Save-Token"] !== "tok-1") {
        return { ok: false, status: 404, text: async () => "" };
      }
      return { ok: true, status: 200, text: async () => NOTES };
    }
    throw new Error(`unexpected fetch ${path}`);
  });
}

const deliver = (frame) => sockets[0].onmessage({ data: JSON.stringify(frame) });
const settle = () => jest.advanceTimersByTimeAsync(1);
const MINUTE = 60000;

beforeAll(async () => {
  global.EventSource = FakeEventSource;
  window.EventSource = FakeEventSource;
  ({ wire } = await import("../../src/plugins/wire.js"));
  ({ programs } = await import("../../src/plugins/programs.js"));
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
    '<script type="text/x-clay-program" name="release-notes" can="read">async function main(input) { return input }</script>' +
    '<script type="text/x-clay-program" name="fmt">exports.wrap = (s) => s;</script>' +
    '<script type="text/x-clay-instructions" name="review">Not a program.</script>';
  window.clay = { wire };
});

afterEach(async () => {
  for (const rec of wire.list()) wire.cancel(rec.id);
  await settle();
  jest.useRealTimers();
});

test("run sends the program's name and input to the programs helper, never its text", async () => {
  const handle = programs.run("release-notes", { input: { since: "v1.2.0" } });
  await settle();
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ helper: "programs", document: "none", id: handle.id });
  expect(sent[0].payload).toEqual({ program: "release-notes", input: { since: "v1.2.0" }, folder: "remembered" });
  expect(JSON.stringify(sent[0])).not.toContain("async function main");
});

test("the console streams to onLog, status to onStatus, and done carries the data and outputs", async () => {
  const log = [];
  const phases = [];
  const handle = programs.run("release-notes", { onLog: (text) => log.push(text), onStatus: (status) => phases.push(status.phase) });
  await settle();
  deliver({ type: "wire/ack", id: handle.id, payload: { mode: "jsonl", budgetMs: 1200000 } });
  deliver({ type: "wire/status", id: handle.id, text: "Choose a folder", payload: { phase: "asking" } });
  deliver({ type: "wire/ack", id: handle.id, payload: { mode: "jsonl", budgetMs: 330000 } });
  deliver({ type: "wire/status", id: handle.id, text: "reading tags\n", payload: { phase: "log" } });
  deliver({ type: "wire/status", id: handle.id, text: "Writing notes", payload: { phase: "working" } });
  deliver({ type: "wire/status", id: handle.id, text: "done\n", payload: { phase: "log" } });
  deliver({
    type: "wire/done",
    id: handle.id,
    payload: {
      program: "release-notes",
      data: { lines: 3 },
      log: "reading tags\ndone\n",
      logCut: false,
      outputs: [{ name: "notes", url: "/_/wire/runs/r1/files/f1", bytes: NOTES.length }],
      folder: { name: "app" },
      grant: { level: "read", remembered: true },
    },
  });
  const outcome = await handle.done;
  expect(log).toEqual(["reading tags\n", "done\n"]);
  expect(phases).toEqual(["asking", "working"]);
  expect(outcome).toMatchObject({
    state: "done",
    program: "release-notes",
    data: { lines: 3 },
    log: "reading tags\ndone\n",
    logCut: false,
    folder: { name: "app" },
    grant: { level: "read", remembered: true },
    error: null,
  });
  expect(outcome.outputs.notes).toMatchObject({ name: "notes", bytes: NOTES.length });
  await expect(outcome.outputs.notes.text()).resolves.toBe(NOTES);
  expect(runFileRequests.map((r) => r.path)).toEqual(["/_/wire/runs/r1/files/f1"]);
});

test("an output the host no longer serves rejects text() with output_unavailable", async () => {
  document.documentElement.removeAttribute("savetoken");
  const handle = programs.run("release-notes");
  await settle();
  deliver({ type: "wire/done", id: handle.id, payload: { data: null, outputs: [{ name: "notes", url: "/_/wire/runs/r1/files/f1" }] } });
  const outcome = await handle.done;
  await expect(outcome.outputs.notes.text()).rejects.toMatchObject({ code: "output_unavailable" });
});

// A done frame relayed by something other than the host must not make the page
// send its save token to another address.
test("an output address that is not one of the host's run files is never fetched", async () => {
  const handle = programs.run("release-notes");
  await settle();
  const urls = ["https://evil.example/_/wire/runs/r1/files/f1", "//evil.example/x", "/_/wire/runs/r1/files/../../../_/api/a.html", "/_/api/secret.html"];
  deliver({ type: "wire/done", id: handle.id, payload: { outputs: urls.map((url, i) => ({ name: `o${i}`, url })) } });
  const outcome = await handle.done;
  for (const name of Object.keys(outcome.outputs)) {
    await expect(outcome.outputs[name].text()).rejects.toMatchObject({ code: "output_unavailable" });
  }
  expect(Object.keys(outcome.outputs)).toHaveLength(urls.length);
  expect(runFileRequests).toHaveLength(0);
  expect(global.fetch.mock.calls.filter(([url]) => !String(url).includes("/_/meta") && !String(url).includes("/_/wire/send"))).toHaveLength(0);
});

test("a refusal arrives as error.code and error.message", async () => {
  const handle = programs.run("release-notes");
  await settle();
  deliver({ type: "wire/error", id: handle.id, text: "The program release-notes changed while HTML Clay was getting it ready. Run it again.", payload: { source: "application", code: "program_changed" } });
  await expect(handle.done).resolves.toMatchObject({
    state: "error",
    data: null,
    error: { code: "program_changed", message: "The program release-notes changed while HTML Clay was getting it ready. Run it again." },
  });
});

// The host parks a run for up to 20 minutes while the person answers, then acks
// again with the run's own budget.
test("the run's own ack moves the deadline, so a run after a long question is not cut", async () => {
  const handle = programs.run("release-notes");
  await settle();
  deliver({ type: "wire/ack", id: handle.id, payload: { mode: "jsonl", budgetMs: 1200000 } });
  await jest.advanceTimersByTimeAsync(15 * MINUTE);
  deliver({ type: "wire/ack", id: handle.id, payload: { mode: "jsonl", budgetMs: 330000 } });
  await jest.advanceTimersByTimeAsync(5 * MINUTE);
  expect(handle.state).toBe("acked");
  deliver({ type: "wire/done", id: handle.id, payload: { data: 1 } });
  await expect(handle.done).resolves.toMatchObject({ state: "done", data: 1 });
});

test("an abort signal cancels the run on the host", async () => {
  const controller = new AbortController();
  const handle = programs.run("release-notes", { signal: controller.signal });
  await settle();
  deliver({ type: "wire/ack", id: handle.id, payload: { mode: "jsonl", budgetMs: 1200000 } });
  controller.abort();
  await settle();
  expect(sent.some((frame) => frame.type === "wire/cancel" && frame.id === handle.id)).toBe(true);
  await expect(handle.done).resolves.toMatchObject({ state: "cancelled" });
});

test("a page without the wire, as in draft mode, gets programs_unavailable and sends nothing", async () => {
  window.clay = {};
  await expect(programs.run("release-notes").done).resolves.toMatchObject({ state: "error", error: { code: "programs_unavailable" } });
  expect(global.fetch).not.toHaveBeenCalled();
  await expect(programs.available()).resolves.toBeNull();
});

test("a bad name, reserved name, bad options, folder or input is refused before anything is sent", async () => {
  await expect(programs.run("Release Notes").done).resolves.toMatchObject({ error: { code: "invalid_request" } });
  await expect(programs.run("ai-tools").done).resolves.toMatchObject({ error: { code: "invalid_request" } });
  await expect(programs.run("programs").done).resolves.toMatchObject({ error: { code: "invalid_request" } });
  await expect(programs.run("release-notes", null).done).resolves.toMatchObject({ error: { code: "invalid_request" } });
  await expect(programs.run("release-notes", []).done).resolves.toMatchObject({ error: { code: "invalid_request" } });
  await expect(programs.run("release-notes", { folder: "/Users/me" }).done).resolves.toMatchObject({ error: { code: "invalid_request" } });
  await expect(programs.run("release-notes", { input: "x".repeat(256 * 1024) }).done).resolves.toMatchObject({ error: { code: "invalid_request" } });
  await expect(programs.run("release-notes", { input: { n: 1n } }).done).resolves.toMatchObject({ error: { code: "invalid_request" } });
  await settle();
  expect(sent).toHaveLength(0);
  programs.run("release-notes", { input: "x".repeat(200 * 1024) });
  await settle();
  expect(sent).toHaveLength(1);
});

test("list ignores SVG scripts and built-in reserved names", () => {
  document.head.innerHTML =
    '<script type="text/x-clay-program" name="ai-tools" can="read">async function main() {}</script>' +
    '<script type="text/x-clay-program" name="programs" can="read">async function main() {}</script>' +
    '<script type="text/x-clay-program" name="ok-one" can="read">async function main() {}</script>';
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const svgScript = document.createElementNS("http://www.w3.org/2000/svg", "script");
  svgScript.setAttribute("type", "text/x-clay-program");
  svgScript.setAttribute("name", "svg-hidden");
  svgScript.textContent = "async function main() {}";
  svg.appendChild(svgScript);
  document.body.appendChild(svg);
  try {
    expect(programs.list()).toEqual([{ name: "ok-one", can: "read", level: "read" }]);
  } finally {
    svg.remove();
  }
});

test("list names each program tag with the level the host runs it at, or null where the host refuses it", () => {
  const tag = (name, can, text = "async function main() {}") =>
    `<script type="text/x-clay-program" name="${name}"${can === null ? "" : ` can="${can}"`}>${text}</script>`;
  document.head.innerHTML =
    tag("notes", null) +
    tag("fix", "read change") +
    tag("news", " internet ") +
    tag("both", "read internet") +
    tag("odd", "write") +
    tag("twice", "read") +
    tag("Bad Name", "read") +
    tag("huge", "read", "x".repeat(256 * 1024 + 1)) +
    "<template>" + tag("hidden", "read") + "</template>" +
    tag("twice", "change") +
    tag("p6", "git") +
    tag("p7", "read") +
    tag("p8", "read") +
    tag("p9", "read");
  expect(programs.list()).toEqual([
    { name: "notes", can: "", level: "read" },
    { name: "fix", can: "read change", level: "change" },
    { name: "news", can: "internet", level: "internet" },
    { name: "both", can: "read internet", level: null },
    { name: "odd", can: "write", level: null },
    { name: "twice", can: "read", level: null },
    { name: "huge", can: "read", level: null },
    { name: "p6", can: "git", level: "read" },
    { name: "p7", can: "read", level: "read" },
    { name: "p8", can: "read", level: null },
    { name: "p9", can: "read", level: null },
  ]);
});

test("available reports the programs helper's state, and null when the host has none", async () => {
  await expect(programs.available()).resolves.toBe("ready");
  resetHostMeta();
  installHost({ helpers: [{ name: "ai-tools", state: "ready" }] });
  await expect(programs.available()).resolves.toBeNull();
});
