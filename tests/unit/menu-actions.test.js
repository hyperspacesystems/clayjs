import { jest } from "@jest/globals";
import { docKey } from "../../src/lib/doc-storage.js";
import { $ } from "./helpers/editor-ui.js";

// Scenario: the menu's editing items call the services that already do the job. Undo
// and Redo follow the page's history and only exist when the page asked for the undo
// plugin, Ask AI to improve this page enters edit mode first or resumes across the
// reload, and Download
// saves what a save would send now. Every case boots through the real loader.

const SLOT = "/notes.html";
const BODY = '<div id="content">start</div>';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clearRoot() {
  const root = document.documentElement;
  for (const name of Array.from(root.attributes, (attribute) => attribute.name)) root.removeAttribute(name);
}

async function boot({ cookie = true, edit = false, plugins = "menu", resume = null, settle = true, helpers = null } = {}) {
  jest.resetModules();
  sessionStorage.clear();
  localStorage.clear();
  delete window.clayEditMode;
  delete window.__hyperclayEditMode;
  document.cookie = "isAdminOfCurrentResource=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  if (cookie) document.cookie = "isAdminOfCurrentResource=true; path=/";
  clearRoot();
  window.history.replaceState({}, "", edit ? `${SLOT}?editmode=true` : SLOT);
  if (resume != null) sessionStorage.setItem(docKey("menu-resume"), JSON.stringify(resume));
  document.head.innerHTML = "";
  document.body.innerHTML = BODY;
  window.fetch = async (url) => {
    // A host that lists a wire helper answers discovery; everything else is absent.
    if (helpers && String(url).includes("/_/meta")) {
      const body = JSON.stringify({ spec: 1, extensions: ["wire"], document: { helpers } });
      return { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => body };
    }
    return {
      ok: false,
      status: 404,
      statusText: "Not Found",
      headers: { get: () => null },
      text: async () => "",
      json: async () => ({}),
    };
  };
  window.clay = {};
  const params = new URLSearchParams(`plugins=${plugins}&exclude=richclay,source`);
  const { boot: run } = await import("../../src/loader.js");
  await new Promise((resolve) => run(null, params, resolve));
  if (settle) await flush();
}

const listOf = () => $(".clay-menu-list", "menu");
const noteOf = () => $(".clay-menu-note", "menu");
const buttonOf = (id) => $(`[role="menuitem"][data-menu-id="${id}"]`, "menu");
const isDisabled = (id) => buttonOf(id).getAttribute("aria-disabled") === "true";

function click(el) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function undoChange(canUndo, canRedo) {
  document.dispatchEvent(new CustomEvent("clay:undo-change", { detail: { canUndo, canRedo } }));
}

function setupDownload() {
  const names = [];
  const createObjectURL = jest.fn(() => "blob:x");
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = jest.fn();
  const anchorClick = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
    names.push(this.download);
  });
  return { names, createObjectURL, anchorClick };
}

test("view mode still records what an edit session would load", async () => {
  await boot({ plugins: "menu,undo" });

  expect(Array.isArray(window.clay.editPlugins)).toBe(true);
  expect(window.clay.editPlugins).toContain("undo");
  expect(window.clay.editPlugins).toContain("menu");
  expect(Object.isFrozen(window.clay.editPlugins)).toBe(true);
});

test("a document with neither page nor undo gets no pair and no Ask AI item", async () => {
  await boot({ plugins: "menu" });

  expect(listOf()).not.toBeNull();
  expect(buttonOf("clay.undo")).toBeNull();
  expect(buttonOf("clay.undo.undo")).toBeNull();
  expect(buttonOf("clay.ai")).toBeNull();
  expect(buttonOf("clay.download")).not.toBeNull();
});

// A Block-based document keeps its history in its own editor, so its pair reads that
// service and never hyper-undo's.
function asPageDocument(history) {
  window.clay.editPlugins = ["menu", "page"];
  window.clay.page = { history };
  document.dispatchEvent(new CustomEvent("clay:modechange"));
}

test("both halves of the pair stay disabled in view mode, whatever history says", async () => {
  await boot({ plugins: "menu,undo" });

  expect(isDisabled("clay.undo.undo")).toBe(true);
  expect(isDisabled("clay.undo.redo")).toBe(true);

  undoChange(true, true);

  expect(isDisabled("clay.undo.undo")).toBe(true);
  expect(isDisabled("clay.undo.redo")).toBe(true);
});

test("in edit mode the pair follows history and clicks reach the undo service", async () => {
  await boot({ plugins: "menu,undo", edit: true });

  const undo = { undo: jest.fn(), redo: jest.fn(), canUndo: true, canRedo: false };
  window.clay.undo = undo;

  undoChange(true, false);
  expect(isDisabled("clay.undo.undo")).toBe(false);
  expect(isDisabled("clay.undo.redo")).toBe(true);

  click(buttonOf("clay.undo.undo"));
  expect(undo.undo).toHaveBeenCalledTimes(1);
  click(buttonOf("clay.undo.redo"));
  expect(undo.redo).not.toHaveBeenCalled();

  undoChange(false, true);
  expect(isDisabled("clay.undo.undo")).toBe(true);
  expect(isDisabled("clay.undo.redo")).toBe(false);
});

test("a page plugin document's pair renders, follows clay.page.history and clicks reach it", async () => {
  await boot({ plugins: "menu", edit: true });

  const history = { undo: jest.fn(), redo: jest.fn(), canUndo: true, canRedo: false };
  asPageDocument(history);

  expect(window.clay.undo).toBeUndefined();
  expect(buttonOf("clay.undo.undo")).not.toBeNull();
  expect(isDisabled("clay.undo.undo")).toBe(false);
  expect(isDisabled("clay.undo.redo")).toBe(true);

  click(buttonOf("clay.undo.undo"));
  expect(history.undo).toHaveBeenCalledTimes(1);

  undoChange(false, true);
  expect(isDisabled("clay.undo.undo")).toBe(true);
  expect(isDisabled("clay.undo.redo")).toBe(false);
  click(buttonOf("clay.undo.redo"));
  expect(history.redo).toHaveBeenCalledTimes(1);

  // The editor closed after the item was drawn: the press reaches nothing and throws
  // nothing, because the service is read at use time.
  window.clay.page = null;
  expect(() => click(buttonOf("clay.undo.undo"))).not.toThrow();
  expect(history.undo).toHaveBeenCalledTimes(1);
});

test("an ordinary document with undo loaded still uses clay.undo, not a page on the window", async () => {
  await boot({ plugins: "menu,undo", edit: true });

  const undo = { undo: jest.fn(), redo: jest.fn(), canUndo: true, canRedo: false };
  window.clay.undo = undo;
  const pageHistory = { undo: jest.fn(), redo: jest.fn(), canUndo: false, canRedo: true };
  window.clay.page = { history: pageHistory };
  document.dispatchEvent(new CustomEvent("clay:modechange"));

  expect(window.clay.editPlugins).not.toContain("page");
  expect(isDisabled("clay.undo.undo")).toBe(false);
  expect(isDisabled("clay.undo.redo")).toBe(true);

  click(buttonOf("clay.undo.undo"));
  expect(undo.undo).toHaveBeenCalledTimes(1);
  expect(pageHistory.undo).not.toHaveBeenCalled();
});

test("Ask AI starts the picker in edit mode, and says so when it cannot", async () => {
  await boot({ plugins: "menu,ai-edit", edit: true, helpers: [{ name: "ai-edit", state: "ready" }] });

  const pick = jest.spyOn(window.clay.aiEdit, "pick").mockResolvedValue(true);
  for (let i = 0; i < 50 && !buttonOf("clay.ai"); i++) await wait(10);
  expect(buttonOf("clay.ai").textContent).toContain("Ask AI to improve this page");

  click(buttonOf("clay.ai"));
  await flush();

  expect(pick).toHaveBeenCalledTimes(1);

  pick.mockResolvedValue(false);
  click(buttonOf("clay.ai"));
  await flush();

  expect(noteOf().textContent).toBe("Ask AI isn't available on this page right now.");
  expect(noteOf().hidden).toBe(false);
});

test("a Block document in view mode gets Ask AI only when the host lists the helper", async () => {
  await boot({ plugins: "menu,ai-edit,page", helpers: [{ name: "ai-edit", state: "ready" }] });
  expect(window.clay.editPlugins).toContain("page");
  for (let i = 0; i < 50 && !buttonOf("clay.ai"); i++) await wait(10);
  expect(buttonOf("clay.ai")).not.toBeNull();
});

test("a Block document in view mode whose host lists no ai-edit helper gets no item", async () => {
  await boot({ plugins: "menu,ai-edit,page" });
  await flush();

  expect(window.clay.editPlugins).toContain("page");
  expect(buttonOf("clay.ai")).toBeNull();
  expect(buttonOf("clay.download")).not.toBeNull();
});

test("a host that lists no ai-edit helper gets no Ask AI item", async () => {
  await boot({ plugins: "menu,ai-edit", edit: true });
  await flush();

  expect(window.clay.aiEdit).toBeTruthy();
  expect(await window.clay.aiEdit.available()).toBe(false);
  expect(buttonOf("clay.ai")).toBeNull();
  expect(buttonOf("clay.download")).not.toBeNull();
});

test("Ask AI from view mode enters edit live and runs the action", async () => {
  await boot({ plugins: "menu,ai-edit" });

  const setMode = jest.fn(async () => ({ ok: true }));
  window.clay.setMode = setMode;
  const pick = jest.fn(async () => true);
  window.clay.aiEdit = { pick };

  click(buttonOf("clay.ai"));
  await flush();

  expect(setMode).toHaveBeenCalledTimes(1);
  expect(setMode).toHaveBeenCalledWith("edit");
  expect(pick).toHaveBeenCalledTimes(1);
  expect(window.clay.storage.session.get("menu-resume")).toBeUndefined();
});

test("Ask AI from view mode leaves its receipt for the reload", async () => {
  await boot({ plugins: "menu,ai-edit" });

  window.clay.setMode = jest.fn(async () => ({ ok: true, reloading: true }));
  const pick = jest.fn(async () => true);
  window.clay.aiEdit = { pick };

  click(buttonOf("clay.ai"));
  await flush();

  expect(pick).not.toHaveBeenCalled();
  expect(window.clay.storage.session.get("menu-resume")).toBe("ai");
});

test("Ask AI says why when the mode change is refused", async () => {
  await boot({ plugins: "menu,ai-edit" });

  window.clay.setMode = jest.fn(async () => ({ ok: false, code: "permission-denied" }));
  const pick = jest.fn(async () => true);
  window.clay.aiEdit = { pick };

  click(buttonOf("clay.ai"));
  await flush();

  expect(noteOf().textContent).toBe("You don't have permission to edit this document.");
  expect(pick).not.toHaveBeenCalled();
  expect(window.clay.storage.session.get("menu-resume")).toBeUndefined();
});

test("a receipt left by the reload runs the action once in edit mode", async () => {
  await boot({ plugins: "menu,ai-edit", edit: true, resume: "ai", settle: false, helpers: [{ name: "ai-edit", state: "ready" }] });

  const pick = jest.spyOn(window.clay.aiEdit, "pick").mockResolvedValue(true);
  for (let i = 0; i < 50 && !buttonOf("clay.ai"); i++) await wait(10);
  await wait(120);
  await flush();

  expect(pick).toHaveBeenCalledTimes(1);
  expect(window.clay.storage.session.get("menu-resume")).toBeUndefined();
});

test("a reload entry waits for the page's AI surface before opening the picker", async () => {
  await boot({ plugins: "menu,ai-edit", edit: true, resume: "ai", settle: false, helpers: [{ name: "ai-edit", state: "ready" }] });

  const pick = jest.spyOn(window.clay.aiEdit, "pick").mockResolvedValue(true);
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  window.clay.page = { ready, ai: null };

  await wait(80);
  expect(pick).not.toHaveBeenCalled();

  release();
  window.clay.page.ai = {};
  for (let i = 0; i < 100 && pick.mock.calls.length === 0; i++) await wait(10);

  expect(pick).toHaveBeenCalledTimes(1);
  expect(noteOf().hidden).toBe(true);
});

test("Download in edit mode saves what a save would send now", async () => {
  await boot({ plugins: "menu", edit: true });
  window.clay.getHTML = () => "<html>copy</html>";
  const { names, createObjectURL, anchorClick } = setupDownload();

  try {
    click(buttonOf("clay.download"));
    await flush();

    expect(names).toHaveLength(1);
    expect(names[0]).toBe("notes.html");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    if (typeof blob.text === "function") expect(await blob.text()).toBe("<html>copy</html>");
  } finally {
    anchorClick.mockRestore();
  }
});

test("Download in view mode fetches the saved file, and says when it cannot", async () => {
  await boot({ plugins: "menu" });
  delete window.clay.getHTML;
  const fetchMock = jest.fn(async () => ({ ok: true, text: async () => "<html>saved</html>" }));
  window.fetch = fetchMock;
  const { names, createObjectURL, anchorClick } = setupDownload();

  try {
    click(buttonOf("clay.download"));
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(location.href);
    expect(fetchMock.mock.calls[0][1]).toEqual({ cache: "no-store", credentials: "same-origin" });
    expect(names).toHaveLength(1);
    expect(names[0]).toBe("notes.html");
    const blob = createObjectURL.mock.calls[0][0];
    if (typeof blob.text === "function") expect(await blob.text()).toBe("<html>saved</html>");

    window.fetch = jest.fn(async () => ({ ok: false }));
    click(buttonOf("clay.download"));
    await flush();

    expect(noteOf().textContent).toBe("Couldn't build the download. Try again.");
    expect(noteOf().hidden).toBe(false);
  } finally {
    anchorClick.mockRestore();
  }
});

const blobText = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsText(blob);
});

test("Download drops copy-only content while the page still holds it", async () => {
  await boot({ plugins: "menu", edit: true });
  document.body.insertAdjacentHTML("beforeend", '<div id="promo" clay="no-copy">Subscribe now</div><p id="keep">kept</p>');
  expect(window.clay.getHTML()).toContain("Subscribe now");
  const { names, createObjectURL, anchorClick } = setupDownload();

  try {
    click(buttonOf("clay.download"));
    await flush();

    expect(names).toEqual(["notes.html"]);
    const text = await blobText(createObjectURL.mock.calls[0][0]);
    expect(text).not.toContain("Subscribe now");
    expect(text).not.toContain("no-copy");
    expect(text).toContain("kept");
    expect(document.body.innerHTML).toContain("Subscribe now");
  } finally {
    anchorClick.mockRestore();
  }
});

test("Download in view mode drops copy-only content from the fetched file", async () => {
  await boot({ plugins: "menu" });
  delete window.clay.getHTML;
  const saved = '<html><body><div clay="no-copy">Subscribe now</div><p>kept</p></body></html>';
  window.fetch = jest.fn(async () => ({ ok: true, text: async () => saved }));
  const { names, createObjectURL, anchorClick } = setupDownload();

  try {
    click(buttonOf("clay.download"));
    await flush();

    expect(names).toEqual(["notes.html"]);
    const text = await blobText(createObjectURL.mock.calls[0][0]);
    expect(text).not.toContain("Subscribe now");
    expect(text).toContain("kept");
  } finally {
    anchorClick.mockRestore();
  }
});

test("Undo reflects history made before the menu loaded", async () => {
  const undo = { undo: jest.fn(), redo: jest.fn(), canUndo: true, canRedo: false };
  const seed = () => {
    window.clay.undo = undo;
  };
  document.addEventListener("clay:ready", seed, { once: true });
  try {
    await boot({ plugins: "menu,undo", edit: true });
  } finally {
    document.removeEventListener("clay:ready", seed);
  }
  expect(window.clay.undo).toBe(undo);

  expect(isDisabled("clay.undo.undo")).toBe(false);
  expect(isDisabled("clay.undo.redo")).toBe(true);
});

test("Download names upload paths in full", async () => {
  await boot({ plugins: "menu", edit: true });
  window.clay.getHTML = () =>
    '<img src="/_/uploads/cover.jpg"><a href="https://x.example/_/uploads/keep.png">k</a>';
  const { createObjectURL, anchorClick } = setupDownload();

  try {
    click(buttonOf("clay.download"));
    await flush();

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob).toBeInstanceOf(Blob);
    if (typeof blob.text === "function") {
      const html = await blob.text();
      expect(html).toContain(`src="${location.origin}/_/uploads/cover.jpg"`);
      expect(html).toContain("https://x.example/_/uploads/keep.png");
    }
  } finally {
    anchorClick.mockRestore();
  }
});

test("a copy whose filter cannot be loaded reports failure and downloads nothing", async () => {
  jest.unstable_mockModule("../../src/core/copy-content.js", () => { throw new Error("no copy filter"); });
  await boot({ plugins: "menu", edit: true });
  window.clay.getHTML = () => '<html><div clay="no-copy">secret</div></html>';
  const { names, createObjectURL, anchorClick } = setupDownload();
  const logged = jest.spyOn(console, "error").mockImplementation(() => {});

  try {
    const { downloadHtml } = await import("../../src/core/download.js");
    expect(await downloadHtml({ html: '<html><div clay="no-copy">secret</div></html>', name: "notes.html" })).toBe(false);

    click(buttonOf("clay.download"));
    await flush();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(names).toHaveLength(0);
    expect(noteOf().textContent).toBe("Couldn't build the download. Try again.");
  } finally {
    logged.mockRestore();
    anchorClick.mockRestore();
  }
});
