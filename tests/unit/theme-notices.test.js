import { jest } from "@jest/globals";
import toast, { toastPersistent } from "../../src/ui/toast.js";
import { _resetTheme, parseColor, theme } from "../../src/ui/theme.js";
import { TOKENS } from "../../src/ui/bevel.js";
import { capture, captureAsync, last } from "./helpers/injected-ui.js";
import { toastStack, $$ } from "./helpers/editor-ui.js";
import * as conflictNotice from "../../src/core/conflict-notice-ui.js";

/**
 * Toasts, the stale-host notice and the conflict notice take the page's theme the way the
 * dialogs do: a captured theme per surface, tokens first, a page's explicit parts last,
 * and the exact Bevel look with every declaration unchanged when the page opts out.
 */

const PAGE = { tokens: { surface: "#202530", text: "#eef0f4", font: "Georgia, serif" } };

// The conflict notice draws its primary choice in the accent, so its theme names one.
const CONFLICT = {
  tokens: { surface: "#202530", text: "#eef0f4", accent: "#3a6ea5", accentText: "#ffffff", font: "Georgia, serif" },
  parts: { "conflict.mine": { base: { color: "#00ff00" } } },
};

const toasts = () => $$("[data-clay-toast]", "toasts");
const panel = () => toasts().at(-1);
const bar = () => document.querySelector("[data-clay-stale-host]");
const shown = (el, prop) => parseColor(el.style.getPropertyValue(prop));
const pointer = (el, type) => capture(() => el.dispatchEvent(new MouseEvent(type)));

const EDIT_PAGE = '<p id="tp">$12 per seat per month.</p>';
const loss = (id) => ({ id, kind: "text", node: document.querySelector("#tp"), local: `mine ${id}`, remote: `theirs ${id}`, base: "theirs" });
const ledgerOf = (records) => ({
  size: records.length,
  list: () => records,
  get: (id) => records.find((record) => record.id === id) ?? null,
  hasPendingApply: () => false,
  acknowledge: () => true,
});

const conflictRoot = () => document.querySelector("[data-clay-conflict]");
const conflictSurface = () => (conflictRoot() ? conflictRoot().firstElementChild : null);
const conflictPanel = () => (conflictRoot() ? conflictRoot().querySelector('[role="dialog"]') : null);
const partOf = (scope, name) => scope.querySelector(`[data-clay-part~="${name}"]`);
const partsOf = (scope, name) => scope.querySelectorAll(`[data-clay-part~="${name}"]`);
const buttonSaying = (scope, re) => [...scope.querySelectorAll("button")].find((b) => re.test(b.textContent));

// Back to a bar holding `records`: the notice keeps its state between draws, so the empty
// ledger first takes it to hidden and clears the panel the last test left open.
function showBar(count) {
  window.clay = { conflicts: ledgerOf([]) };
  conflictNotice._test.render();
  document.body.insertAdjacentHTML("afterbegin", EDIT_PAGE);
  const records = Array.from({ length: count }, (_, i) => loss(`c${i}`));
  window.clay = { conflicts: ledgerOf(records) };
  conflictNotice._test.render();
  return records;
}

function showPanel(count) {
  showBar(count);
  const review = buttonSaying(conflictRoot(), /Review/);
  expect(review).toBeDefined();
  review.click();
  return conflictPanel();
}

beforeEach(() => {
  jest.useFakeTimers();
  _resetTheme();
  delete window.clayTheme;
  delete window.clay;
  document.documentElement.removeAttribute("style");
  document.body.removeAttribute("style");
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

test("a themed toast takes the page's surface, ink and type, and keeps its tone edge", () => {
  theme(PAGE);
  toast("Saved", "success");

  const el = panel();
  expect(el.getAttribute("data-clay-part")).toContain("toast.panel");
  expect(shown(el, "background")).toEqual(parseColor(PAGE.tokens.surface));
  expect(el.style.getPropertyPriority("background")).toBe("important");
  expect(el.style.getPropertyValue("font-family")).toContain("Georgia");

  const texts = el.querySelectorAll('[data-clay-part~="toast.text"]');
  expect(texts.length).toBeGreaterThan(0);
  expect(shown(texts[0], "color")).toEqual(parseColor(PAGE.tokens.text));

  const calls = capture(() => toast("Again", "success"));
  expect(last(calls, panel(), "border-inline-start-color")).toBe(TOKENS.teal);
});

test("an explicit part wins over the token it would have taken", () => {
  theme({
    tokens: { radius: "12px" },
    parts: { "toast.panel": { base: { "border-radius": "2px" } } },
  });
  const calls = capture(() => toast("Saved"));
  const el = panel();

  expect(el.getAttribute("data-clay-part")).toContain("toast.panel");
  expect(el.style.getPropertyValue("border-radius")).toBe("2px");
  expect(last(calls, el, "border-radius")).toBe("2px");
});

test("a themed persistent toast's close repaints on hover and clears it on leave", () => {
  theme({
    tokens: { surface: "#202530", text: "#eef0f4" },
    parts: { "toast.close": { hover: { background: "red" } } },
  });
  toastPersistent("Offline", "warning");

  const close = panel().querySelector("button");
  expect(close).not.toBeNull();
  expect(close.getAttribute("data-clay-part")).toContain("toast.close");
  const icon = close.querySelector("svg");
  expect(icon.getAttribute("data-clay-part")).toContain("toast.closeIcon");

  const over = pointer(close, "pointerenter");
  expect(last(over, close, "background")).toBe("red");

  const away = pointer(close, "pointerleave");
  expect(last(away, close, "background")).toBe("#202530");
});

test("a toast keeps the theme it was built with, and a later theme reaches only new ones", () => {
  theme({ tokens: { surface: "#202530" } });
  toast("A");
  const first = panel();
  expect(shown(first, "background")).toEqual(parseColor("#202530"));

  theme({ tokens: { surface: "#111111" } });
  toast("B");
  const second = panel();
  expect(second).not.toBe(first);
  expect(shown(second, "background")).toEqual(parseColor("#111111"));
  expect(shown(first, "background")).toEqual(parseColor("#202530"));
});

test("exact Bevel: no parts, no theme type, the Bevel surface as before", () => {
  theme(false);
  const calls = capture(() => toast("Saved"));

  const el = panel();
  expect(el.getAttribute("data-clay-part")).toBeNull();
  expect(toastStack().getAttribute("data-clay-part")).toBeNull();
  expect(toastStack().querySelectorAll("[data-clay-part]").length).toBe(0);
  expect(last(calls, el, "background")).toBe(TOKENS.surface);
  expect(calls.filter((call) => call.style === el.style && call.name === "font-family")).toEqual([]);
});

test("the toast stack keeps its live region under a theme", () => {
  theme({ tokens: { surface: "#202530" } });
  toast("Saved");
  toastPersistent("Offline", "warning");

  expect(toasts().length).toBe(2);
  expect(toastStack().getAttribute("aria-live")).toBe("polite");
  expect(toastStack().getAttribute("data-clay-part")).toContain("toast.stack");
});

test("the stale-host notice takes the theme and still dismisses", async () => {
  jest.resetModules();
  window.clayTheme = { tokens: { surface: "#202530", text: "#eef0f4", font: "Georgia, serif" } };
  document.body.innerHTML = "";
  document.documentElement.setAttribute("htmlclaytoken", "tok-old");
  jest.spyOn(console, "warn").mockImplementation(() => {});

  await captureAsync(async () => (await import("../../src/core/stale-host-notice.js")).whenShown());

  expect(bar()).not.toBeNull();
  expect(bar().getAttribute("data-clay-part")).toContain("staleHost.root");
  expect(shown(bar(), "background")).toEqual(parseColor("#202530"));
  expect(bar().style.getPropertyPriority("background")).toBe("important");

  const close = bar().querySelector("button");
  expect(close.getAttribute("data-clay-part")).toContain("staleHost.button");
  close.click();
  expect(bar().style.display).toBe("none");
});

test("the conflict toast, bar and panel take the page's theme", () => {
  window.clay = { conflicts: ledgerOf([loss("c0")]) };
  theme(CONFLICT);

  const calls = capture(() => conflictNotice.toast("Put back 1 change. Saving."));
  const toast = conflictSurface();
  expect(toast.getAttribute("data-clay-part")).toContain("conflict.panel");
  expect(shown(toast, "color")).toEqual(parseColor(CONFLICT.tokens.text));
  // The teal tint stays, in place of a left edge; a later change is the one that takes it away.
  expect(last(calls, toast, "background")).toBe(TOKENS["teal-soft"]);
  expect(last(calls, toast, "border-left")).toBeNull();
  expect(last(calls, toast, "border-left-color")).toBeNull();

  // The toast goes on its own timer; the bar is what the notice draws after it.
  jest.advanceTimersByTime(6000);

  const barEl = conflictSurface();
  expect(barEl).not.toBeNull();
  expect(barEl.getAttribute("data-clay-part")).toContain("conflict.panel");
  expect(shown(barEl, "background")).toEqual(parseColor(CONFLICT.tokens.surface));
  expect(barEl.style.getPropertyValue("font-family")).toContain("Georgia");

  const dot = partOf(barEl, "conflict.dot");
  expect(dot).not.toBeNull();
  const text = partOf(barEl, "conflict.text");
  expect(text).not.toBeNull();
  expect(shown(text, "color")).toEqual(parseColor(CONFLICT.tokens.text));
  const barButtons = partsOf(barEl, "conflict.button");
  expect(barButtons.length).toBeGreaterThan(0);
  expect(partsOf(barEl, "conflict.buttonLabel").length).toBeGreaterThan(0);

  barButtons[0].click();

  const dialog = conflictPanel();
  expect(dialog).not.toBeNull();
  expect(dialog.getAttribute("data-clay-part")).toContain("conflict.panel");
  expect(shown(dialog, "background")).toEqual(parseColor(CONFLICT.tokens.surface));
  expect(conflictRoot().getAttribute("data-clay-part")).toContain("conflict.root");

  const header = partOf(dialog, "conflict.header");
  expect(header).not.toBeNull();
  const title = partOf(dialog, "conflict.title");
  expect(title).not.toBeNull();
  expect(shown(title, "color")).toEqual(parseColor(CONFLICT.tokens.text));
  expect(partOf(dialog, "conflict.actions")).not.toBeNull();
  expect(partsOf(dialog, "conflict.close").length).toBeGreaterThan(0);
  expect(partsOf(dialog, "conflict.button").length).toBeGreaterThan(0);
  expect(partsOf(dialog, "conflict.buttonLabel").length).toBeGreaterThan(0);

  const accept = buttonSaying(dialog, /Accept theirs/);
  expect(accept).toBeDefined();
  expect(accept.getAttribute("data-clay-part")).toContain("conflict.button");
  expect(shown(accept, "background")).toEqual(parseColor(CONFLICT.tokens.accent));
  expect(shown(accept, "color")).toEqual(parseColor(CONFLICT.tokens.accentText));
});

test("a themed row carries its location, its labels and both sides of the edit", () => {
  theme(CONFLICT);
  const dialog = showPanel(2);

  const see = buttonSaying(dialog, /See the edits/);
  expect(see).toBeDefined();
  see.click();

  const well = partOf(conflictPanel(), "conflict.well");
  expect(well).not.toBeNull();
  expect(well.getAttribute("data-clay-part")).toContain("conflict.list");

  const rows = partsOf(well, "conflict.row");
  expect(rows.length).toBeGreaterThan(0);
  const locations = partsOf(well, "conflict.location");
  expect(locations.length).toBeGreaterThan(0);
  const labels = partsOf(well, "conflict.valueLabel");
  expect(labels.length).toBeGreaterThan(0);
  const mine = partOf(rows[0], "conflict.mine");
  const theirs = partOf(rows[0], "conflict.theirs");
  expect(mine).not.toBeNull();
  expect(theirs).not.toBeNull();
  expect(mine.textContent).toContain("mine c0");
  expect(theirs.textContent).toContain("theirs c0");
  expect(partOf(mine, "conflict.value")).not.toBeNull();
  expect(shown(mine, "color")).toEqual(parseColor("#00ff00"));
});

test("the conflict panel keeps the theme it was drawn with, and the next draw takes the new one", () => {
  theme({ tokens: { surface: "#202530", text: "#eef0f4" } });
  const first = showPanel(1);
  expect(shown(first, "background")).toEqual(parseColor("#202530"));

  theme({ tokens: { surface: "#111111", text: "#ffffff" } });
  expect(shown(first, "background")).toEqual(parseColor("#202530"));

  conflictNotice._test.render();
  const second = conflictPanel();
  expect(second).not.toBe(first);
  expect(shown(second, "background")).toEqual(parseColor("#111111"));
  expect(shown(first, "background")).toEqual(parseColor("#202530"));
});

test("exact Bevel: the conflict notice marks no part and keeps every Bevel declaration", () => {
  theme(false);
  const calls = capture(() => showPanel(1));

  const rootEl = conflictRoot();
  expect(rootEl.getAttribute("data-clay-part")).toBeNull();
  expect(rootEl.querySelectorAll("[data-clay-part]").length).toBe(0);

  const dialog = conflictPanel();
  expect(dialog).not.toBeNull();
  expect(last(calls, dialog, "background")).toBe(TOKENS.surface);
  expect(calls.filter((call) => call.style === dialog.style && call.name === "font-family")).toEqual([]);
  expect([...rootEl.querySelectorAll("button")].length).toBeGreaterThan(0);
});
