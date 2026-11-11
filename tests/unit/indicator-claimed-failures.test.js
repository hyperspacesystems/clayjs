import { FAILURE_CLAIMED } from "../../src/core/save-feedback.js";

// The chip beside the block editor's own save notices. The editor claims the failures it
// puts its own notice up for, and moves to `retrying` while it keeps trying on its own.
// Here a stand-in for the editor subscribes before the indicator, which is the order after
// a view to edit switch, so the chip must read the claim rather than rely on going last.

const chip = () => document.querySelector("[data-clay-indicator]");
const drawn = async () => {
  await import("../../src/plugins/indicator-chip.js");
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

let claiming = false;
const fire = (state, detail = {}) => document.dispatchEvent(new CustomEvent("clay:save-" + state, { detail }));
const editorState = (state) => document.dispatchEvent(new CustomEvent("clay:blockeditor-save-state", { detail: { state } }));

beforeAll(async () => {
  window.clayEditMode = true;
  document.addEventListener("clay:save-error", (event) => {
    if (!claiming) return;
    event.detail[FAILURE_CLAIMED] = true;
    editorState("blocked");
  });
  await import("../../src/plugins/indicator.js");
});

test("offline stays up while the block editor retries", async () => {
  fire("offline");
  editorState("retrying");
  await drawn();
  expect(chip().textContent).toBe("Offline, will retry");
  expect(chip().style.opacity).toBe("1");
});

test("a plain Couldn't save gives way to the block editor's retrying", async () => {
  fire("error");
  await drawn();
  expect(chip().textContent).toBe("Couldn't save");

  editorState("retrying");
  await drawn();
  expect(chip().textContent).toBe("");
  expect(chip().style.opacity).toBe("0");
});

test("a failure the block editor claimed draws no chip, whichever listener ran first", async () => {
  claiming = true;
  fire("error");
  claiming = false;
  await drawn();
  expect(chip().textContent).toBe("");
});

test("control: the same failure unclaimed draws the chip", async () => {
  fire("error");
  await drawn();
  expect(chip().textContent).toBe("Couldn't save");
});
