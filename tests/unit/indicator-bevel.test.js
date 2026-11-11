import { jest } from "@jest/globals";
import { TOKENS, FONT_SANS } from "../../src/ui/bevel.js";
import { captureAsync, last, expectHostileProof, expectCallsResolved } from "./helpers/injected-ui.js";

let calls;

// The drawing is a module the first save state fetches, so a reading waits for it.
const drawn = async () => {
  await import("../../src/plugins/indicator-chip.js");
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

beforeAll(async () => {
  window.clayEditMode = true;
  document.documentElement.style.colorScheme = "dark";
  calls = await captureAsync(async () => {
    await import("../../src/plugins/indicator.js");
    document.dispatchEvent(new CustomEvent("clay:save-error"));
    await drawn();
  });
});

const fire = (state) => captureAsync(async () => {
  document.dispatchEvent(new CustomEvent("clay:save-" + state));
  await drawn();
});
const chip = () => document.querySelector("[data-clay-indicator]");

test("hostile-proof: runtime-only, no class or id, every declaration !important and resolved", () => {
  expect(expectHostileProof(chip())).toBe(1);
  expectCallsResolved(calls, chip());
  expect(chip().style.item(0)).toBe("all");
});

test("material: a Bevel surface in the system font, square, in the page's scheme", () => {
  const surface = calls.filter((call) => call.style === chip().style);
  expect(surface.find((call) => call.name === "background").value).toBe(TOKENS.surface);
  expect(surface.find((call) => call.name === "color").value).toBe(TOKENS.ink);
  expect(chip().style.getPropertyValue("font")).toContain(FONT_SANS);
  expect(chip().style.getPropertyValue("border-radius")).toBe("");
  expect(chip().style.getPropertyValue("color-scheme")).toBe("dark");
});

test("alarm: error and offline wear the ox tone, saved hides the chip", async () => {
  const error = await fire("error");
  expect(last(error, chip(), "background")).toBe(TOKENS["ox-soft"]);
  expect(last(error, chip(), "color")).toBe(TOKENS.ox);
  const offline = await fire("offline");
  expect(last(offline, chip(), "color")).toBe(TOKENS.ox);
  await fire("saved");
  expect(chip().textContent).toBe("");
  expect(chip().style.opacity).toBe("0");
});

test("a status-only change moves the chip with no save event behind it", async () => {
  await fire("saved");
  expect(chip().style.opacity).toBe("0");
  const failed = await captureAsync(async () => {
    document.dispatchEvent(new CustomEvent("clay:save-status", { detail: { state: "error" } }));
    await drawn();
  });
  expect(last(failed, chip(), "background")).toBe(TOKENS["ox-soft"]);
  expect(last(failed, chip(), "color")).toBe(TOKENS.ox);
});

test("opacity writes are !important, so a page rule cannot hide the chip", async () => {
  await fire("error");
  expect(chip().style.getPropertyPriority("opacity")).toBe("important");
  expect(chip().style.opacity).toBe("1");
});
