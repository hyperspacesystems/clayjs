import { jest } from "@jest/globals";

// The page editor puts up its own notice, with Download and Copy text, when it cannot save
// at all. The corner chip must not say "Can't save here" beside it: one problem, one notice.
const drawn = async () => {
  await import("../../src/plugins/indicator-chip.js");
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const blockeditorState = (state) => document.dispatchEvent(new CustomEvent("clay:blockeditor-save-state", { detail: { state, code: "unsupported-host", message: "" } }));
const chip = () => document.querySelector("[data-clay-indicator]");

beforeAll(async () => {
  window.clayEditMode = true;
  await import("../../src/plugins/indicator.js");
});

test.each(["blocked", "unavailable"])("a page that cannot save (%s) shows no chip beside the page notice", async (state) => {
  blockeditorState("error");
  await drawn();
  expect(chip().textContent).toBe("Couldn't save");
  expect(chip().style.opacity).toBe("1");

  blockeditorState(state);
  await drawn();
  expect(chip().textContent).toBe("");
  expect(chip().style.opacity).toBe("0");
  expect(chip().dataset.state).toBeUndefined();
});

test("the chip comes back for the page's next failure", async () => {
  blockeditorState("blocked");
  await drawn();
  blockeditorState("error");
  await drawn();
  expect(chip().textContent).toBe("Couldn't save");
  expect(chip().style.opacity).toBe("1");
});

test("a core save that is blocked still shows the chip: only the page editor has its own notice", async () => {
  document.dispatchEvent(new CustomEvent("clay:save-blocked"));
  await drawn();
  expect(chip().textContent).toBe("Can't save here");
});
