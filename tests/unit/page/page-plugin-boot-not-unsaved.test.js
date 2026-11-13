/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/notes.html"}
 */
import { jest } from "@jest/globals";
import * as realEditor from "../../../src/page/editor.js";
import { seedValue } from "../../../src/page/ybind/seed.js";
import { renderFromTags } from "../../../src/page/save-projection.js";

/**
 * The autosave baseline settles once the boot's own churn stops, and the boot churn
 * it absorbs is cleared from the scoped-sync gate at that capture. Anything that
 * changes the article after it is a change no save has written, so the page reads
 * unsaved. The editor is a separate download from the page plugin, so whether the
 * article swap lands before or after the settle decides which side of that line it
 * falls on.
 */

// A paragraph boots with no optional blocks; a table of contents is an optional block, which
// reveals the editor later, in openInput, after its feature loads.
const DOCUMENTS = [
  ["only plain blocks", [{ id: "p", t: "paragraph", text: "Hello" }]],
  ["an optional block", [{ id: "h", t: "heading", level: 1, text: "Hello" }, { id: "toc", t: "toc", maxLevel: 3 }]],
];
const TAG_SEL = 'script[type="application/json"][merge="blockeditor"]';
const clone = (v) => JSON.parse(JSON.stringify(v));
const flushAsync = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const pageHtml = (value) => {
  const { html, rev } = renderFromTags([JSON.stringify(value)]);
  return `<article data-blockeditor="1" data-rev="${rev}">${html}</article>`;
};

const settle = async (save, timeout = 6000) => {
  const deadline = Date.now() + timeout;
  while (!save.baselineSettled() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
};

const roomState = (room) => ({
  epoch: room.epoch, seq: room.seq, writer: room.writer, conn: 0,
  stores: clone(room.stores),
});

async function load({ html, editorGate = null } = {}) {
  jest.resetModules();
  window.clayEditMode = true;
  document.documentElement.removeAttribute("documentetag");
  document.head.innerHTML = "";
  document.body.innerHTML = html;

  const extensions = ["blockeditor"];
  const handlersRef = { h: null };
  const room = { epoch: "e1", seq: 0, writer: null, stores: {} };

  await jest.unstable_mockModule("../../../src/core/host-meta.js", () => ({
    hostMeta: async () => ({ spec: 1, extensions, document: { etag: "stamp-1" } }),
    hostSupports: async (name) => extensions.includes(name),
    hostMetaOutcome: () => "ok",
    querySaveOutcome: () => null,
    resetHostMeta: () => ({}),
  }));

  await jest.unstable_mockModule("../../../src/live/local-lane.js", () => ({
    localLaneSupported: () => false,
    localTransport: () => ({}),
  }));

  await jest.unstable_mockModule("../../../src/live/server-lane.js", () => ({
    serverTransport: () => ({
      start(handlers) {
        handlersRef.h = handlers;
        handlers.open({ clientId: "tab-1", lane: "live" });
        handlers.state(roomState(room));
        return () => {};
      },
      async send(clientId) {
        room.seq += 1;
        if (room.writer === null) room.writer = clientId;
        handlersRef.h?.writer({ epoch: room.epoch, writer: room.writer, landed: null });
        return { status: 200, body: { seq: room.seq, epoch: room.epoch } };
      },
      async fetchState() {
        return roomState(room);
      },
    }),
  }));

  // The editor's own download, held for as long as the caller wants.
  await jest.unstable_mockModule("../../../src/page/editor.js", async () => {
    if (editorGate) await editorGate.promise;
    return realEditor;
  });

  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: "",
    headers: { get: () => null },
    text: async () => JSON.stringify({ msg: "Saved", etag: "stamp-2" }),
  }));

  const { live } = await import("../../../src/plugins/live.js");
  window.clay = { live: (name) => live(name) };
  const { page } = await import("../../../src/plugins/page.js");
  return { page };
}

afterEach(async () => {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  // The finished case's ClayJS copy stays subscribed, so emptying the page reads to it
  // as an edit and it marks the root on a microtask; let that land before clearing it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.documentElement.removeAttribute("unsaved");
  document.documentElement.removeAttribute("documentetag");
  delete global.fetch;
});

test.each(DOCUMENTS)("a saved Block editor document with %s is not unsaved after load, when the editor loads after the boot settle", async (_, blocks) => {
  const editorGate = deferred();
  const { page } = await load({ html: pageHtml(seedValue(blocks)), editorGate });
  const save = await import("../../../src/core/save.js");

  // The boot settles with the editor's download still outstanding, exactly as it can
  // when that chunk is slow to arrive.
  await settle(save);
  expect(save.baselineSettled()).toBe(true);
  expect(document.querySelectorAll(".blockeditor-shell")).toHaveLength(0);

  editorGate.resolve();
  await page.ready;
  await flushAsync();
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(document.querySelectorAll(".blockeditor-shell")).toHaveLength(1);
  expect(document.documentElement.hasAttribute("unsaved")).toBe(false);
});

test.each(DOCUMENTS)("a saved Block editor document with %s is not unsaved after load, when the editor loads before the boot settle", async (_, blocks) => {
  const { page } = await load({ html: pageHtml(seedValue(blocks)) });
  const save = await import("../../../src/core/save.js");

  await page.ready;
  await flushAsync();
  await settle(save);
  await flushAsync();

  expect(save.baselineSettled()).toBe(true);
  expect(document.querySelectorAll(".blockeditor-shell")).toHaveLength(1);
  expect(document.documentElement.hasAttribute("unsaved")).toBe(false);
});
