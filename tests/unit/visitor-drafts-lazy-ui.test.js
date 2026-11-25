/**
 * The chrome a draft boot draws, now that its pieces arrive as their own imports:
 * no floating download prompt on a healthy boot, the owner chip only for the signed-in
 * owner, and the storage-error card with its stylesheet before its element only when
 * browser storage fails.
 */
import { jest } from "@jest/globals";
import { $, hostOf, sheetText } from "./helpers/editor-ui.js";

const PARAMS = "plugins=visitor-drafts&exclude=richclay,source";
const RULES = '{"title":"#title","note":"#note@value"}';

function clearCookies() {
  document.cookie = "isAdminOfCurrentResource=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
}

function setOwnerCookie() {
  document.cookie = "isAdminOfCurrentResource=true; path=/";
}

function setPage({ slot }) {
  const root = document.documentElement;
  for (const name of Array.from(root.attributes, (attribute) => attribute.name)) root.removeAttribute(name);
  root.setAttribute("visitor-drafts", slot);
  document.head.innerHTML = `<script type="application/json" data-rules-name="api" data-rules-version="1">${RULES}</script>`;
  document.body.innerHTML = '<h1 id="title">owner title</h1><input id="note" persist value="owner note">';
  localStorage.clear();
}

function notFound() {
  return { ok: false, status: 404, statusText: "Not Found", text: async () => "" };
}

async function bootPage({ slot, owner = false } = {}) {
  jest.resetModules();
  delete window.clayEditMode;
  delete window.__hyperclayEditMode;
  clearCookies();
  if (owner) setOwnerCookie();
  window.history.replaceState({}, "", "/notes.html");
  setPage({ slot });
  window.clay = {};
  window.scrollTo = () => {};
  window.scrollBy = () => {};
  const fetchMock = jest.fn(async () => notFound());
  window.fetch = fetchMock;
  global.fetch = fetchMock;

  const { boot } = await import("../../src/loader.js");
  await new Promise((resolve) => boot(null, new URLSearchParams(PARAMS), resolve));
  return { clay: window.clay };
}

const prompt = () => $("#hcp", "download-prompt");
const chip = () => $(".clay-owner", "owner");

afterEach(() => {
  clearCookies();
});

test("a visitor's draft boot draws neither a floating download prompt nor an owner chip", async () => {
  const { clay } = await bootPage({ slot: "lazy-visitor-1" });

  expect(clay.isDraftMode).toBe(true);
  expect(hostOf("download-prompt")).toBeNull();
  expect(hostOf("owner")).toBeNull();
});

test("an owner's draft boot gets the owner-only chip and no floating download prompt", async () => {
  const { clay } = await bootPage({ slot: "lazy-owner-1", owner: true });

  expect(clay.isDraftMode).toBe(true);
  expect(hostOf("download-prompt")).toBeNull();
  expect(chip()).not.toBeNull();
  expect(chip().querySelector(".clay-owner__lead").textContent)
    .toBe("Owner only (visitors don't see this): you're in a private draft.");
});

test("a storage failure mounts the error card with its stylesheet already attached", async () => {
  await bootPage({ slot: "lazy-style-1" });
  expect(hostOf("download-prompt")).toBeNull();

  let sheetAtInsert = null;
  const insertBefore = document.body.insertBefore;
  document.body.insertBefore = function (node, before) {
    if (node.matches?.('clay-editor-ui[data-clay-ui="download-prompt"]')) {
      sheetAtInsert = Array.from(node.shadowRoot.querySelectorAll("style"), (style) => style.textContent).join("\n");
    }
    return insertBefore.call(this, node, before);
  };
  try {
    document.dispatchEvent(new CustomEvent("clay:drafts-store-failed", { detail: { error: new Error("full") } }));
    for (let i = 0; i < 20 && !prompt(); i++) await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    document.body.insertBefore = insertBefore;
  }

  expect(prompt()).not.toBeNull();
  expect(prompt().getAttribute("data-hcp-state")).toBe("card");
  expect(prompt().getAttribute("data-hcp-reason")).toBe("error");
  expect(sheetAtInsert).toContain(".hcp-card");
  expect(sheetText("download-prompt")).toContain(".hcp-card");
  expect(hostOf("download-prompt").getAttribute("clay")).toBe("editor-ui");
});
