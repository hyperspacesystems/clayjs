import { jest } from "@jest/globals";
import { captureAsync, last } from "./helpers/injected-ui.js";

// When the chip shows and goes: saving draws nothing, a failure stays until a later save
// clears it, and a reader who asked for reduced motion gets no transition.

const chip = () => document.querySelector("[data-clay-indicator]");
// The drawing is a module the first save state fetches, so a reading waits for it.
const drawn = async () => {
  await import("../../src/plugins/indicator-chip.js");
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const fire = (state) => document.dispatchEvent(new CustomEvent("clay:save-" + state));

async function load({ reduced = false } = {}) {
  jest.resetModules();
  document.body.innerHTML = "";
  window.clayEditMode = true;
  window.matchMedia = (query) => ({ matches: reduced && query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} });
  await import("../../src/plugins/indicator.js");
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  delete window.clayEditMode;
});

test("saving draws nothing, and leaves a standing failure up", async () => {
  await load();
  fire("saving");
  await drawn();
  expect(chip()).toBeNull();

  fire("error");
  await drawn();
  jest.advanceTimersByTime(60000);
  expect(chip().textContent).toBe("Couldn't save");
  expect(chip().style.opacity).toBe("1");

  fire("saving");
  await drawn();
  expect(chip().textContent).toBe("Couldn't save");
  expect(chip().style.opacity).toBe("1");
});

test("a failure chip stays up for as long as it takes, and a later save hides it", async () => {
  await load();
  fire("error");
  await drawn();
  jest.advanceTimersByTime(10000);
  expect(chip().style.opacity).toBe("1");
  expect(chip().textContent).toBe("Couldn't save");

  fire("saved");
  await drawn();
  expect(chip().style.opacity).toBe("0");
  expect(chip().textContent).toBe("");
});

test("reduced motion: no fade transition", async () => {
  let calls = [];
  await load({ reduced: true });
  calls = await captureAsync(async () => {
    fire("error");
    await drawn();
  });
  expect(last(calls, chip(), "transition")).toBe("none");
});

test("an indicator imported during a transition arms nothing", async () => {
  // A late import lands while the committed mode is still the one being left, so its
  // own start would be a chip no exit holds a lease over.
  jest.resetModules();
  document.body.innerHTML = "";
  window.clayEditMode = true;
  const mode = await import("../../src/core/is-edit-mode.js");
  const { saveFeedback } = await import("../../src/core/save-feedback.js");
  mode.commitModeFacts({ mode: "edit", isEditMode: true, phase: "leaving" });

  const added = [];
  const realAdd = document.addEventListener;
  document.addEventListener = function (type, ...rest) {
    added.push(type);
    return realAdd.call(this, type, ...rest);
  };
  try {
    await import("../../src/plugins/indicator.js");
  } finally {
    document.addEventListener = realAdd;
  }

  expect(saveFeedback.chip).toBe(false);
  expect(added).not.toContain("clay:save-saved");
});
