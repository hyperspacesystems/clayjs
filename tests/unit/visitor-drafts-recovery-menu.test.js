import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { attachRecoveryMenu, openRecovery } from "../../src/plugins/visitor-drafts/recovery-menu.js";
import { COPY } from "../../src/plugins/visitor-drafts/recovery.js";
import modal from "../../src/ui/modal.js";

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const entry = (mark = "one") => ({ mark, copy: { data: { note: "<script>not executed</script>" } }, savedAt: "2026-11-12T12:00:00Z", fields: 1, available: true });
const button = (root, label) => [...root.querySelectorAll("button")].find((el) => el.textContent === label);
const shell = () => {
  const items = new Map();
  return { items, beforeOpen: [], goo: document.createElement("button"), note: jest.fn(), addItem: (item) => items.set(item.id, item), removeItem: (id) => items.delete(id) };
};
const service = (rows = [entry()]) => ({ list: jest.fn(async () => rows), restore: jest.fn(async () => {}), remove: jest.fn(async () => {}), download: jest.fn(async () => true), html: jest.fn(() => "<!DOCTYPE html><html><head><title>Earlier</title></head><body><p>Earlier text</p><script>throw new Error('do not run')</script></body></html>") });

beforeEach(() => { document.body.innerHTML = ""; window.scrollTo = () => {}; });
afterEach(() => { modal.close(); });

test("hidden with no copies, appears once a copy exists, and disappears after the last removal", async () => {
  const menu = shell();
  const recovery = service([]);
  const refresh = attachRecoveryMenu(menu, async () => recovery);
  await refresh();
  expect(menu.items.has("clay.earlier-drafts")).toBe(false);
  recovery.list.mockResolvedValue([entry()]);
  await refresh();
  expect(menu.items.get("clay.earlier-drafts").label).toBe(COPY.label);
  recovery.list.mockResolvedValue([]);
  await menu.beforeOpen[0]();
  expect(menu.items.has("clay.earlier-drafts")).toBe(false);
});

test("a missing database or failed read leaves no item", async () => {
  const menu = shell();
  await attachRecoveryMenu(menu, async () => null)();
  expect(menu.items.size).toBe(0);
  await attachRecoveryMenu(menu, async () => { throw new Error("unavailable"); })();
  expect(menu.items.size).toBe(0);
});

test("the newest completed refresh wins over an older slow list read", async () => {
  const menu = shell();
  let resolveOld;
  const recovery = service();
  recovery.list.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValue([]);
  const refresh = attachRecoveryMenu(menu, async () => recovery);
  await tick();
  await refresh();
  resolveOld([entry()]);
  await tick();
  expect(menu.items.size).toBe(0);
});

test("renders the shared name, time, summary and sandboxed preview without restoring or downloading", async () => {
  const recovery = service();
  const root = await openRecovery(recovery);
  expect(document.querySelector('[role="dialog"]').getAttribute("aria-label")).toBe(COPY.label);
  expect(root.textContent).toContain(COPY.intro);
  expect(root.querySelector("time").dateTime).toBe("2026-11-12T12:00:00Z");
  expect(root.textContent).toContain("1 saved field");
  button(root, "Preview").click();
  await tick();
  const frame = root.querySelector("iframe");
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.srcdoc).toContain("default-src 'none'");
  expect(frame.srcdoc).toContain("Earlier text");
  expect(frame.srcdoc).not.toContain("<script");
  expect(recovery.restore).not.toHaveBeenCalled();
  expect(recovery.download).not.toHaveBeenCalled();
  expect(button(root, "Preview").getAttribute("aria-expanded")).toBe("true");
  button(root, "Preview").click();
  await tick();
  expect(frame.parentElement.hidden).toBe(true);
});

test("removal requires one confirmation, cancellation keeps the copy, and confirm refreshes visibility", async () => {
  const recovery = service();
  const refresh = jest.fn();
  const root = await openRecovery(recovery, { refresh });
  button(root, "Remove").click();
  await tick();
  expect(recovery.remove).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(button(root, "Keep draft"));
  button(root, "Keep draft").click();
  expect(recovery.remove).not.toHaveBeenCalled();
  button(root, "Remove").click();
  await tick();
  recovery.list.mockResolvedValue([]);
  button(root, "Remove draft").click();
  await tick();
  expect(recovery.remove).toHaveBeenCalledTimes(1);
  expect(recovery.remove).toHaveBeenCalledWith("one");
  expect(root.querySelectorAll("li")).toHaveLength(0);
  expect(refresh).toHaveBeenCalledTimes(1);
});

test("restore and download use the selected row and a failure stays visible for retry", async () => {
  const recovery = service();
  const root = await openRecovery(recovery);
  button(root, "Download").click();
  await tick();
  expect(recovery.download).toHaveBeenCalledWith(entry().copy);
  recovery.restore.mockRejectedValueOnce(new Error("Keep this page open and try again."));
  button(root, "Restore").click();
  await tick();
  expect(recovery.restore).toHaveBeenCalledWith("one");
  expect(root.querySelector('[role="status"]').textContent).toBe("Keep this page open and try again.");
  button(root, "Restore").click();
  await tick();
  expect(recovery.restore).toHaveBeenCalledTimes(2);
});

test("saves and storage events do not reread copies after Settings has opened", async () => {
  const menu = shell();
  const recovery = service();
  attachRecoveryMenu(menu, async () => recovery);
  await tick();
  expect(recovery.list).toHaveBeenCalledTimes(1);
  document.dispatchEvent(new CustomEvent("clay:drafts-saved"));
  window.dispatchEvent(new StorageEvent("storage", { key: "unrelated-page" }));
  await tick();
  expect(recovery.list).toHaveBeenCalledTimes(1);
  await menu.beforeOpen[0]();
  expect(recovery.list).toHaveBeenCalledTimes(2);
});

test("preview removes HTML, image map and both SVG hyperlink targets", async () => {
  const recovery = service();
  recovery.html.mockReturnValue(`<!DOCTYPE html><html><head></head><body>
    <a href="https://example.invalid/html">HTML</a>
    <map name="links"><area href="https://example.invalid/map" shape="rect" coords="0,0,10,10"></map>
    <svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <a href="https://example.invalid/svg"><text>SVG</text></a>
      <a xlink:href="https://example.invalid/xlink"><text>Legacy SVG</text></a>
    </svg>
  </body></html>`);
  const root = await openRecovery(recovery);
  button(root, "Preview").click();
  await tick();
  const parsed = new DOMParser().parseFromString(root.querySelector("iframe").srcdoc, "text/html");
  const links = [...parsed.querySelectorAll("a, area")];
  expect(links).toHaveLength(4);
  for (const link of links) {
    expect(link.hasAttribute("href")).toBe(false);
    expect(link.hasAttribute("xlink:href")).toBe(false);
    expect(link.hasAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe(false);
  }
});
