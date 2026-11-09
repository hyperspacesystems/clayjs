import { jest } from "@jest/globals";
import { createPicker, genericSurface } from "../../src/plugins/ai-edit/picker.js";
import { STRIP_FROM_SAVE } from "../../src/lib/region-policy.js";

/**
 * The area picker: hover outlines a block, a click picks one, a drag or a Shift-click
 * extends across blocks, a tap on a coarse pointer only selects, and "Whole page" stays
 * one press away. jsdom has no layout, so the hit testing is injected here and stubbed
 * where the plugin builds the generic surface itself; what a browser makes of the
 * overlay is checked in the browser pass, not here.
 */

const PAGE = `
  <section data-edit-id="hero">
    <h1>Heading</h1>
    <p>First</p>
    <p>Second</p>
  </section>
  <section data-edit-id="body">
    <p>Elsewhere</p>
  </section>
`;

const pickerRoot = (name) => document.querySelector(`[data-clay-ai-edit="${name}"]`);
const overlay = () => pickerRoot("picker");
const ring = () => pickerRoot("picker-ring");
const bar = () => pickerRoot("picker-bar");
const part = (name) => document.querySelector(`[data-clay-ai-edit-part="${name}"]`);
const all = (selector) => Array.from(document.querySelectorAll(selector));

function mount() {
  document.body.innerHTML = PAGE;
  return {
    hero: document.querySelector('[data-edit-id="hero"]'),
    body: document.querySelector('[data-edit-id="body"]'),
    heading: document.querySelector("h1"),
    first: document.querySelectorAll("p")[0],
    second: document.querySelectorAll("p")[1],
    elsewhere: document.querySelectorAll("p")[2],
  };
}

function fire(el, type, { x = 0, y = 0, shift = false } = {}) {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, shiftKey: shift }));
}

function press(el, { from = [0, 0], to = [0, 0], shift = false } = {}) {
  fire(el, "pointerdown", { x: from[0], y: from[1], shift });
  fire(el, "pointerup", { x: to[0], y: to[1], shift });
}

function coarse(matches) {
  window.matchMedia = (query) => ({
    matches: matches && String(query).includes("coarse"),
    addEventListener() {},
    removeEventListener() {},
  });
}

afterEach(() => {
  document.querySelectorAll("[data-clay-ai-edit]").forEach((el) => el.remove());
  coarse(false);
});

// A surface that answers by block, as window.clay.page.ai does: points are mapped by
// hand, and a span is whatever the test says the two ends cover.
function fakeSurface({ at = new Map(), span = () => null } = {}) {
  const asked = [];
  return {
    asked,
    targetAt: jest.fn((x, y) => at.get(`${x},${y}`) || null),
    between: jest.fn((a, b) => {
      asked.push([a, b]);
      return span(a, b);
    }),
    rectOf: (target) => (target ? target.getBoundingClientRect() : null),
  };
}

test("a click picks one block and opens the composer straight away", () => {
  const nodes = mount();
  const surface = fakeSurface({ at: new Map([["10,10", nodes.first]]) });
  const onPicked = jest.fn();
  const picker = createPicker({ surface, onPicked });

  picker.open();
  expect(picker.picking).toBe(true);
  expect(overlay()).not.toBeNull();

  press(overlay(), { from: [10, 10], to: [10, 10] });

  expect(surface.between).not.toHaveBeenCalled();
  expect(onPicked).toHaveBeenCalledTimes(1);
  expect(onPicked.mock.calls[0][0]).toBe(nodes.first);
  expect(picker.picking).toBe(true); // the overlay stays up while the composer is open
});

test("a drag across blocks reports the span between them, not the start block", () => {
  const nodes = mount();
  const surface = fakeSurface({
    at: new Map([["10,10", nodes.first], ["10,200", nodes.second]]),
    span: (a, b) => (a === nodes.first && b === nodes.second ? nodes.hero : null),
  });
  const onPicked = jest.fn();
  const picker = createPicker({ surface, onPicked });
  picker.open();

  press(overlay(), { from: [10, 10], to: [10, 200] });

  expect(surface.between).toHaveBeenCalledWith(nodes.first, nodes.second);
  expect(onPicked).toHaveBeenCalledTimes(1);
  expect(onPicked.mock.calls[0][0]).toBe(nodes.hero);
});

test("a movement under four pixels is still a click, not a drag", () => {
  const nodes = mount();
  const surface = fakeSurface({ at: new Map([["10,10", nodes.first], ["13,12", nodes.second]]) });
  const onPicked = jest.fn();
  const picker = createPicker({ surface, onPicked });
  picker.open();

  press(overlay(), { from: [10, 10], to: [13, 12] });

  expect(surface.between).not.toHaveBeenCalled();
  expect(onPicked.mock.calls[0][0]).toBe(nodes.second);
});

test("Shift-click extends from the chosen block with between", () => {
  const nodes = mount();
  const surface = fakeSurface({
    at: new Map([["10,10", nodes.first], ["10,300", nodes.elsewhere]]),
    span: (a, b) => (a === nodes.first && b === nodes.elsewhere ? document.body : null),
  });
  const onPicked = jest.fn();
  const picker = createPicker({ surface, onPicked });
  picker.open();

  press(overlay(), { from: [10, 10], to: [10, 10] });
  expect(onPicked.mock.calls[0][0]).toBe(nodes.first);

  press(overlay(), { from: [10, 300], to: [10, 300], shift: true });

  expect(surface.between).toHaveBeenCalledWith(nodes.first, nodes.elsewhere);
  expect(onPicked).toHaveBeenCalledTimes(2);
  expect(onPicked.mock.calls[1][0]).toBe(document.body);
});

test("Shift-click before anything is chosen behaves as a click", () => {
  const nodes = mount();
  const surface = fakeSurface({ at: new Map([["10,10", nodes.second]]) });
  const onPicked = jest.fn();
  const picker = createPicker({ surface, onPicked });
  picker.open();

  press(overlay(), { from: [10, 10], to: [10, 10], shift: true });

  expect(surface.between).not.toHaveBeenCalled();
  expect(onPicked.mock.calls[0][0]).toBe(nodes.second);
});

test("on a coarse pointer a tap only selects, and Continue opens the composer", () => {
  const nodes = mount();
  coarse(true);
  const surface = fakeSurface({
    at: new Map([["10,10", nodes.first], ["10,200", nodes.second]]),
    span: (a, b) => (a === nodes.first && b === nodes.second ? nodes.hero : null),
  });
  const onPicked = jest.fn();
  const picker = createPicker({ surface, onPicked });
  picker.open();

  expect(part("picker-continue")).not.toBeNull();
  expect(part("picker-continue").hidden).toBe(true);

  press(overlay(), { from: [10, 10], to: [10, 10] });
  expect(onPicked).not.toHaveBeenCalled();
  expect(part("picker-continue").hidden).toBe(false);

  // A second tap extends rather than replacing: a tap has no Shift to hold.
  press(overlay(), { from: [10, 200], to: [10, 200] });
  expect(surface.between).toHaveBeenCalledWith(nodes.first, nodes.second);
  expect(onPicked).not.toHaveBeenCalled();

  part("picker-continue").click();
  expect(onPicked).toHaveBeenCalledTimes(1);
  expect(onPicked.mock.calls[0][0]).toBe(nodes.hero);
});

test("a fine pointer's bar has no Continue button", () => {
  mount();
  coarse(false);
  const picker = createPicker({ surface: fakeSurface() });
  picker.open();

  expect(part("picker-continue")).toBeNull();
  expect(part("picker-whole").textContent).toBe("Whole page");
  expect(part("picker-cancel").textContent).toBe("Cancel");
  expect(part("picker-hint").textContent).toBe("Click or drag blocks");
});

test("Whole page and Cancel are one press each", () => {
  mount();
  const onWholePage = jest.fn();
  const onCancel = jest.fn();
  const picker = createPicker({ surface: fakeSurface(), onWholePage, onCancel });
  picker.open();

  part("picker-whole").click();
  expect(onWholePage).toHaveBeenCalledTimes(1);

  part("picker-cancel").click();
  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(picker.picking).toBe(false);
  expect(overlay()).toBeNull();
});

test("Esc closes the overlay and takes it out of the DOM", () => {
  mount();
  const onCancel = jest.fn();
  const picker = createPicker({ surface: fakeSurface(), onCancel });
  picker.open();
  expect(all("[data-clay-ai-edit]")).toHaveLength(3);

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

  expect(onCancel).toHaveBeenCalledTimes(1);
  expect(picker.picking).toBe(false);
  expect(overlay()).toBeNull();
  expect(ring()).toBeNull();
  expect(bar()).toBeNull();
  expect(picker.contains(document.body)).toBe(false);
});

test("the overlay contains its bar, so a click on a control is not a click away", () => {
  mount();
  const picker = createPicker({ surface: fakeSurface() });
  picker.open();

  expect(picker.contains(overlay())).toBe(true);
  expect(picker.contains(part("picker-whole"))).toBe(true);
  expect(picker.contains(document.body)).toBe(false);
});

test("generic between names the common ancestor through the block rules", () => {
  const nodes = mount();
  const surface = genericSurface();

  expect(surface.between(nodes.first, nodes.second)).toBe(nodes.hero);
  // Different sections have only the page around them.
  expect(surface.between(nodes.first, nodes.elsewhere)).toBe(document.body);
  // Mismatched ancestors never resolve to the start block.
  expect(surface.between(nodes.heading, nodes.first)).toBe(nodes.hero);
  expect(surface.between(nodes.first, nodes.first)).toBe(nodes.first);
});

test("generic targetAt skips the overlay, AI chrome and what the save strips", () => {
  const nodes = mount();
  const picker = createPicker({ surface: null });
  picker.open();

  const chrome = document.createElement("div");
  chrome.setAttribute("data-clay-ai-edit", "panel");
  const stripped = document.createElement("div");
  stripped.setAttribute("clay", "no-save");
  stripped.innerHTML = "<p>Saved elsewhere</p>";
  document.body.append(chrome, stripped);

  document.elementsFromPoint = jest.fn(() => [overlay(), part("picker-whole"), chrome, stripped, nodes.first]);
  expect(genericSurface().targetAt(1, 1)).toBe(nodes.first);

  document.elementsFromPoint = jest.fn(() => [overlay(), chrome, stripped]);
  expect(genericSurface().targetAt(1, 1)).toBeNull();

  delete document.elementsFromPoint;
  picker.close();
  chrome.remove();
  stripped.remove();
});

test("the saved page keeps no trace of the picker", () => {
  mount();
  const picker = createPicker({ surface: fakeSurface() });
  picker.open();
  expect(overlay()).not.toBeNull();

  const clone = document.body.cloneNode(true);
  clone.querySelectorAll(STRIP_FROM_SAVE).forEach((node) => node.remove());

  expect(clone.querySelector("[data-clay-ai-edit]")).toBeNull();
  picker.close();
});

// The picker on the real plugin: the overlay's own clicks reach ai-edit's click-away
// handler, which has to know they came from the picker.
const fakeWire = { helpers: jest.fn(), send: jest.fn() };
jest.unstable_mockModule("../../src/plugins/wire.js", () => ({ default: fakeWire, wire: fakeWire }));

test("a click inside the overlay does not close the composer", async () => {
  window.clayEditMode = true;
  fakeWire.helpers.mockResolvedValue([{ name: "ai-edit", state: "ready" }]);
  window.clay = window.clay || {};
  window.clay.save = jest.fn(async () => ({ ok: true }));
  const nodes = mount();
  document.elementsFromPoint = jest.fn(() => [overlay(), nodes.heading]);

  const { aiEdit } = await import("../../src/plugins/ai-edit.js");
  const panel = () => document.querySelector('[data-clay-ai-edit="panel"]');

  expect(await aiEdit.pick()).toBe(true);
  expect(overlay()).not.toBeNull();

  press(overlay(), { from: [10, 10], to: [10, 10] });
  expect(panel().hidden).toBe(false);
  expect(panel().querySelector("textarea")).toBe(document.activeElement);

  fire(overlay(), "click", { x: 10, y: 10 });
  fire(part("picker-whole"), "click");
  expect(panel().hidden).toBe(false);

  // A click on the page itself is still a click away from the composer.
  fire(nodes.first, "click");
  expect(panel().hidden).toBe(true);
  delete document.elementsFromPoint;
});
