import { TOKENS, FONT_MONO } from "../../src/ui/bevel.js";
import { capture, last, expectHostileProof, expectCallsResolved } from "./helpers/injected-ui.js";

import { ask, consent, tell, snippet } from "../../src/ui/dialogs.js";
import themodal from "../../src/ui/modal.js";

const dialog = () => document.querySelector('[role="dialog"]');
const submit = () => dialog().querySelector('button[type="submit"]');
const close = () => dialog().querySelector('button[aria-label="Close"]');

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  if (themodal.isShowing) themodal.close();
});

test("ask: title, Bevel input and the close are hostile-proof; the caller's prompt node is placed as it is", () => {
  const prompt = document.createElement("span");
  prompt.append("Rename ");
  const caller = document.createElement("b");
  caller.dataset.caller = "1";
  caller.textContent = "this";
  prompt.append(caller, "?");
  let result;
  const calls = capture(() => { result = ask(prompt, null, "old"); });
  result.catch(() => {});
  const root = document.querySelector("[data-clay-modal]");
  expect(dialog().contains(caller)).toBe(true);
  expect(expectHostileProof(root, { skip: (el) => prompt.contains(el) })).toBeGreaterThanOrEqual(12);
  expectCallsResolved(calls, root);
  expect(caller.hasAttribute("style")).toBe(false);
  const input = dialog().querySelector("input");
  expect(last(calls, input, "background")).toBe(TOKENS.ground);
  expect([input.required, input.getAttribute("value"), document.activeElement]).toEqual([true, "old", input]);
  const x = close().querySelector("svg");
  const ink = calls.filter((call) => call.style === x.style && call.name === "color");
  expect(ink.map((call) => [call.value, call.priority])).toEqual([["inherit", "important"]]);
  expect(x.querySelector("path").style.getPropertyValue("fill")).toBe("currentColor");
  expect(x.getAttribute("class")).toBeNull();
  expect(x.querySelector("path").style.getPropertyPriority("fill")).toBe("important");
  expect(document.querySelector('[class*="micromodal"]')).toBeNull();

  themodal.close();
  ask('Rename <b>x</b>?', null, "old").catch(() => {});
  expect(dialog().textContent).toContain('Rename <b>x</b>?');
  expect(dialog().querySelector("b")).toBeNull();
});

test("consent: extra content inherits Bevel body type, not the reset font", () => {
  const calls = capture(() => { consent("Delete?", null, '<p data-extra="1">This cannot be undone.</p>').catch(() => {}); });
  const extra = dialog().querySelector('[data-extra="1"]');
  expect(last(calls, extra.parentElement, "color")).toBe(TOKENS["ink-2"]);
  expect(last(calls, extra.parentElement, "font")).toMatch(/^14\.5px\/1\.55 /);
});

test("coarse pointer dialogs use touch sized inputs and footer buttons", () => {
  const original = window.matchMedia;
  window.matchMedia = query => ({ matches: query === "(pointer: coarse)", media: query, addEventListener() {}, removeEventListener() {} });
  try {
    ask("Rename?", null, "old").catch(() => {});
    const input = dialog().querySelector("input");
    const buttons = [...dialog().lastElementChild.querySelectorAll("button")];
    expect([input.style.fontSize, input.style.blockSize, input.style.minBlockSize]).toEqual(["16px", "40px", "40px"]);
    expect(buttons.map(button => [button.style.blockSize, button.style.minBlockSize])).toEqual([["40px", "40px"], ["40px", "40px"]]);
  } finally {
    themodal.close();
    window.matchMedia = original;
  }
});

test("tell: the title and each paragraph in Bevel type, caller paragraph nodes placed as they are", () => {
  const paragraph = document.createElement("span");
  paragraph.append("first ");
  const caller = document.createElement("i");
  caller.dataset.caller = "p";
  caller.textContent = "one";
  paragraph.append(caller);
  const calls = capture(() => { tell("Heads up", paragraph, "second").catch(() => {}); });
  const root = document.querySelector("[data-clay-modal]");
  expect(dialog().contains(caller)).toBe(true);
  expect(expectHostileProof(root, { skip: (el) => paragraph.contains(el) })).toBeGreaterThanOrEqual(10);
  expectCallsResolved(calls, root);
  expect(dialog().textContent).toContain("Heads up");
  expect(caller.outerHTML).toBe('<i data-caller="p">one</i>');

  themodal.close();
  tell("Heads up", "<i data-caller='q'>two</i>").catch(() => {});
  expect(dialog().textContent).toContain("<i data-caller='q'>two</i>");
  expect(dialog().querySelector("i")).toBeNull();
});

test("snippet: the code sits in a mono well, copy is a Bevel button, no confirm button", () => {
  const calls = capture(() => { snippet("Embed", "the code"); });
  const root = document.querySelector("[data-clay-modal]");
  expect(expectHostileProof(root)).toBeGreaterThanOrEqual(10);
  expectCallsResolved(calls, root);
  const pre = dialog().querySelector("pre");
  expect(pre.textContent).toBe("the code");
  expect(pre.style.getPropertyValue("font")).toContain(FONT_MONO);
  expect(submit().hidden).toBe(true);
});

test("snippet: code is shown as written, never parsed", () => {
  snippet("Embed", "<div>hi</div>");
  const pre = dialog().querySelector("pre");
  expect(pre.textContent).toBe("<div>hi</div>");
  expect(pre.querySelector("div")).toBeNull();
});

test("confirm opens with the primary button focused, so Enter confirms", () => {
  consent("Delete it?");

  expect(document.activeElement).toBe(submit());
  expect(document.activeElement.textContent).toBe("Confirm");
});

test("a title-only dialog has no doubled rule and is named by its title", () => {
  consent("Delete it?");

  const footer = dialog().lastElementChild;
  expect([footer.style.getPropertyValue("border-top"), footer.style.getPropertyPriority("border-top")]).toEqual(["0", "important"]);
  expect(dialog().getAttribute("aria-label")).toBe("Delete it?");
});

test("confirm: the prompt is the panel's title, an empty body is hidden, Cancel then Confirm", async () => {
  const result = consent("Delete it?");
  const panel = dialog();
  const heading = panel.querySelector('[role="heading"]');
  expect(heading.textContent).toBe("Delete it?");

  const body = heading.parentElement.nextElementSibling;
  expect([body.hidden, body.style.getPropertyValue("display")]).toEqual([true, "none"]);

  const footer = panel.lastElementChild;
  expect([...footer.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Confirm"]);

  footer.querySelector("button").click();
  await expect(result).rejects.toBeUndefined();
  expect(dialog()).toBeNull();
});
