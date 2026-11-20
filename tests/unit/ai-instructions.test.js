import { beforeEach, expect, test } from "@jest/globals";
import { instructions } from "../../src/plugins/ai.js";

let writable;

beforeEach(() => {
  writable = true;
  window.clay = { modeLifecycle: { canWrite: () => writable } };
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

const tag = (name, text) => `<script type="text/x-clay-instructions" name="${name}">${text}</script>`;

test("get returns the trimmed text of the first tag with the name, and null for none", () => {
  document.head.innerHTML = tag("review", "\n  Explain it.\n") + tag("review", "second");
  expect(instructions.get("review")).toBe("Explain it.");
  expect(instructions.get("missing")).toBeNull();
});

test("names lists each name once, in document order", () => {
  document.head.innerHTML = tag("b", "1") + tag("a", "2") + tag("b", "3");
  expect(instructions.names()).toEqual(["b", "a"]);
});

test("set writes nothing and answers false when this tab cannot write", () => {
  document.head.innerHTML = tag("review", "old");
  writable = false;
  expect(instructions.set("review", "new")).toBe(false);
  expect(instructions.set("added", "x")).toBe(false);
  expect(instructions.get("review")).toBe("old");
  expect(document.querySelectorAll("script").length).toBe(1);
});

test("set changes the saved tag, or adds one to the head", () => {
  document.head.innerHTML = tag("review", "old");
  expect(instructions.set("review", "new")).toBe(true);
  expect(document.querySelector('script[name="review"]').textContent).toBe("new");
  expect(instructions.set("level-pm", "For a product manager.")).toBe(true);
  const added = document.head.lastElementChild;
  expect(added.getAttribute("type")).toBe("text/x-clay-instructions");
  expect(added.getAttribute("name")).toBe("level-pm");
});

// A script's text ends at "</script", and "<!--" can swallow the real end tag, so
// text holding either, or their escaped forms, must be stored so it reads back exactly.
test("text with a script end tag, a comment opener or their escaped forms survives a save and reload", () => {
  const text = 'Never print </script>, <\\/script>, <!-- or <\\!-- <script> into the page.';
  instructions.set("review", text);
  document.body.innerHTML = '<p id="after">still here</p>';
  const saved = "<!doctype html>" + document.documentElement.outerHTML;
  const reloaded = new DOMParser().parseFromString(saved, "text/html");
  document.head.innerHTML = reloaded.head.innerHTML;
  document.body.innerHTML = reloaded.body.innerHTML;
  expect(instructions.get("review")).toBe(text);
  expect(document.getElementById("after")?.textContent).toBe("still here");
});

test("set refuses in a visitor's draft, and names skips an empty name", () => {
  document.head.innerHTML = tag("", "ignored") + tag("review", "old");
  expect(instructions.names()).toEqual(["review"]);
  window.clay = { isDraftMode: true, modeLifecycle: { canWrite: () => true } };
  expect(instructions.set("review", "new")).toBe(false);
  expect(instructions.get("review")).toBe("old");
});

test("fromForm reads the form's names, then the chosen controls, each once", () => {
  document.body.innerHTML = `
    <form instructions="review shared">
      <select instructions><option value="level-reviewer">R</option><option value="level-pm" selected>P</option></select>
      <input type="checkbox" instructions value="tests" checked>
      <input type="checkbox" instructions value="style">
      <input type="radio" name="t" instructions value="review" checked>
    </form>`;
  expect(instructions.fromForm(document.querySelector("form"))).toEqual(["review", "shared", "level-pm", "tests"]);
});
