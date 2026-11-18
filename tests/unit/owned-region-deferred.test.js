import { jest } from "@jest/globals";

let snapshot;
let lib;
let Mutation;
let owner;
let release;

const PAGE = `<main><section item data-id="tab-1"><table grid><tbody><tr><td>0</td><td>0</td></tr></tbody></table></section><p id="outside">text</p></main>`;

async function load() {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  delete window.clay;
  delete window.clayEditMode;
  window.scrollTo = () => {};
  document.body.innerHTML = PAGE;
  snapshot = await import("../../src/core/snapshot.js");
  lib = await import("../../src/lib/derived.js");
  Mutation = (await import("../../src/lib/mutation.js")).default;
  const regions = await import("../../src/lib/owned-regions.js");
  const { undo } = await import("../../src/plugins/undo.js");
  window.clay = { derived: lib.derived, Mutation, undo };
  undo.start({ bindKeys: false });
  owner = { rev: 1 };
  release = regions.own("section[item] > table[grid]", { serialize: (root) => root.innerHTML, revision: () => owner.rev });
}

function engine() {
  const heard = [];
  const atFlush = [];
  Mutation.onAnyChange({ require: "observed" }, (changes) => {
    for (const change of changes) heard.push(`${change.type} ${change.element.localName}`);
  });
  lib.derived.register(() => {}, { flush: () => atFlush.push([...heard]) });
  return { heard, atFlush };
}

function edit(text, rev, mark) {
  document.querySelector("td").textContent = text;
  owner.rev = rev;
  document.getElementById("outside").setAttribute("data-edited", mark);
}

afterEach(() => {
  release?.dispose();
  release = null;
  window.clay?.undo?.stop();
});

test("an edit inside an owned region made through undo, then a save: before its flush the engine hears the region once as an owned change and no record from inside it, as a direct edit does", async () => {
  await load();
  const { heard, atFlush } = engine();

  window.clay.undo.commit("Type", () => edit("7", 2, "1"));
  snapshot.captureForSaveAndComparison();
  await Promise.resolve();
  const afterCapture = heard.splice(0);

  edit("8", 3, "2");
  await Promise.resolve();

  expect({ atFlush, afterCapture, direct: heard }).toEqual({
    atFlush: [["attribute p", "owned table"]],
    afterCapture: ["attribute p", "owned table"],
    direct: ["attribute p", "owned table"],
  });
});

test("an edit inside an owned region made through undo that leaves its revision alone: before its flush the engine hears only the edit outside the region", async () => {
  await load();
  const { heard, atFlush } = engine();

  window.clay.undo.commit("Type", () => edit("7", 1, "1"));
  snapshot.captureForSaveAndComparison();
  await Promise.resolve();

  expect({ atFlush, afterCapture: heard }).toEqual({ atFlush: [["attribute p"]], afterCapture: ["attribute p"] });
});
