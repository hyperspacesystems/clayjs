import { jest } from "@jest/globals";

/**
 * The notice is drawn through the real toast module here. jsdom has no cascade, so this
 * proves structure only: one toast at a time, and the three choices in the order the
 * page offers them. How it looks is the browser pass's question.
 */

const TITLE = "Saved data was overwritten";

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const answer = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const stack = () => document.querySelector('clay-editor-ui[data-clay-ui="toasts"]')?.shadowRoot ?? null;
const toasts = () => stack().querySelectorAll("[data-clay-toast]");
const labels = () => [...toasts()[0].querySelectorAll("button:not([aria-label])")].map((button) => button.textContent);

const event = {
  id: "e1",
  status: "pending",
  restorable: true,
  canRevert: true,
  lastWriteAt: 1,
  lossSummary: { provenance: "external", removedItems: 2, destroyedAtoms: 0 },
  preview: [{ key: "title", yours: "Mine", now: "Theirs" }],
  droppedAdditions: 1,
};

let queue = [];
let notice;
let fetchMock;

async function boot(entries) {
  jest.resetModules();
  queue = [...entries];
  fetchMock = jest.fn(() => Promise.resolve(queue.shift()));
  global.fetch = fetchMock;
  notice = await import("../../src/sync/data-guard-notice.js");
  notice.start({ href: "/guard", reload: () => {} });
  await flush();
  return notice;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("savetoken");
  document.documentElement.removeAttribute("htmlclaytoken");
  sessionStorage.clear();
});

afterEach(() => {
  notice?.stop();
  notice = null;
  delete global.fetch;
  jest.useRealTimers();
});

test("two reads of one event leave one toast, with the three choices in order", async () => {
  await boot([answer(200, { event }), answer(409, {}), answer(200, { event })]);

  expect(toasts()).toHaveLength(1);
  expect(labels()).toEqual(["Restore", "Undo the change", "Keep as is"]);

  toasts()[0].querySelectorAll("button:not([aria-label])")[0].click();
  await flush();
  expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "POST", "GET"]);

  // The 409 says a passing warning of its own. Click it away, wait out its fade, and
  // only the notice is left in the stack.
  for (const el of toasts()) if (!el.querySelector("button:not([aria-label])")) el.click();
  await new Promise((resolve) => setTimeout(resolve, 600));

  expect(toasts()).toHaveLength(1);
  expect(labels()).toEqual(["Restore", "Undo the change", "Keep as is"]);
  expect(toasts()[0].textContent).toContain(TITLE);
  expect(toasts()[0].textContent).toContain("title: Mine before, Theirs now.");
});
