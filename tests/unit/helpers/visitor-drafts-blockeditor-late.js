import { jest } from "@jest/globals";
import { deserialize, serialize } from "node:v8";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { seedValue } from "../../../src/page/ybind/seed.js";
import { renderFromTags } from "../../../src/page/save-projection.js";

globalThis.structuredClone ??= (value) => deserialize(serialize(value));
const BLOCKS = [
  { id: "title", t: "heading", text: "" },
  { id: "p1", t: "paragraph", text: "" },
];
const RULES = '{"title":"title","stamp":"#stamp"}';
const SLOT = "opus-r5-ended";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = (line) => process.stdout.write(`PROBE ${line}\n`);

function articleHtml() {
  const { html, rev } = renderFromTags([JSON.stringify(seedValue(BLOCKS))]);
  return `<article class="blockeditor" clay="freeze" data-blockeditor="1" data-rev="${rev}">${html}</article>`;
}

function firstParagraph(view) {
  let pos = null;
  view.state.doc.descendants((node, at) => { if (pos === null && node.type.name === "paragraph") pos = at + 1; });
  return pos;
}

async function waitFor(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await wait(25);
  }
  return predicate();
}


export async function scenario({ late, gate = true }) {
  const factory = new IDBFactory();
  globalThis.indexedDB = factory;
  globalThis.IDBKeyRange = IDBKeyRange;
  jest.resetModules();
  const root = document.documentElement;
  root.setAttribute("visitor-drafts", SLOT);
  root.setAttribute("opens-in", "edit");
  document.head.innerHTML = `<title>Page</title><script type="application/json" data-rules-name="api" data-rules-version="1">${RULES}</script><script type="application/json" merge="blockeditor.settings" clay="live">{}</script>`;
  document.body.innerHTML = `<p id="stamp" onbeforesave="this.textContent = String(Date.now())">0</p>` + articleHtml();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/page.html");
  window.clay = {};
  const fetchMock = jest.fn(async () => { throw new Error("no host request in draft mode"); });
  window.fetch = fetchMock;
  global.fetch = fetchMock;
  await import("../../../src/ui/toast.js");
  await import("../../../src/lib/region-policy.js");
  const { boot } = await import("../../../src/loader.js");
  await new Promise((resolve) => boot(null, new URLSearchParams("plugins=blockeditor,visitor-drafts,indicator"), resolve));
  const clay = window.clay;
  await clay.blockeditor.ready;
  const drafts = await import("../../../src/plugins/visitor-drafts.js");
  expect(await drafts.recoveryDrafts()).not.toBeNull();
  const draftMode = await import("../../../src/core/draft-mode.js");
  const send = draftMode.draftTransport();
  const sent = [];
  draftMode.setDraftTransport((html, at) => { sent.push({ html, at }); return send(html, at); });
  const { openDrafts } = await import("../../../src/plugins/visitor-drafts/idb.js");
  const { createStore, draftKey } = await import("../../../src/plugins/visitor-drafts/store.js");
  const { openSession } = await import("../../../src/plugins/visitor-drafts/session.js");
  const key = draftKey(SLOT, "/page.html");
  const dump = async () => {
    const db = await openDrafts({ factory, keyRange: IDBKeyRange });
    const all = await db.readAll(key);
    db.close();
    return JSON.stringify([...all]) + JSON.stringify(Object.entries(localStorage));
  };
  const view = clay.blockeditor.view;
  view.dispatch(view.state.tr.insertText("alpha", firstParagraph(view)));
  expect(await waitFor(() => sent.some(({ html }) => html.includes("alpha")))).toBe(true);
  expect(await waitFor(async () => (await dump()).includes("alpha"))).toBe(true);
  await wait(1500);
  expect(sent.length).toBeGreaterThan(0);
  for (const { at } of sent) {
    expect(typeof at?.gen).toBe("number");
    expect(Array.isArray(at?.probe)).toBe(true);
  }
  const docB = document.implementation.createHTMLDocument("b");
  docB.documentElement.setAttribute("visitor-drafts", SLOT);
  docB.head.innerHTML = `<title>Page</title><script type="application/json" data-rules-name="api" data-rules-version="1">${RULES}</script>`;
  docB.body.innerHTML = `<p id="stamp">0</p><script type="application/json" merge="blockeditor.settings" clay="live">{}</script>` + articleHtml();
  const storeB = createStore({ doc: docB, storage: localStorage, path: "/page.html" });
  storeB.restore();
  const sessionB = await openSession({ store: storeB, storage: localStorage, doc: docB, reload: () => {} });
  await sessionB.first.catch(() => {});
  const sentBefore = sent.length;
  if (late) view.dispatch(view.state.tr.insertText("bravo ", firstParagraph(view)));
  if (!gate) draftMode.setDraftGate(null);
  await sessionB.startOver();
  window.dispatchEvent(new StorageEvent("storage", { key: key + ":reset" }));
  await wait(400);
  expect(sessionStorage.getItem(key + ":started-over")).toBe("1");
  const slots = Object.entries(localStorage).filter(([name]) => name.startsWith(key + ":op:")).map(([, raw]) => JSON.parse(raw));
  const left = slots.flatMap((slot) => slot.ops ?? []);
  out(`late ${late} gate ${gate}: operations left in a journal slot: ${left.length}; keys: ${JSON.stringify(left.map((op) => [Object.keys(op.keys), Boolean(op.unit)]))}; saves sent while retiring: ${sent.length - sentBefore}`);
  return { everything: await dump(), left };
}
