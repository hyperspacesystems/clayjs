import { beforeEach, expect, test } from "@jest/globals";
import { ai } from "../../src/plugins/ai.js";

const RULES = {
  incoming: ["#incoming > article", { title: ".title", summary: ".summary", diff: ".diff" }],
  reviews: ["#reviews > article", { id: "@data-id", title: ".title", summary: ".summary", diff: ".diff" }],
};

beforeEach(() => {
  document.head.innerHTML =
    `<script type="application/json" data-rules-name="api" data-rules-version="1">${JSON.stringify(RULES)}</script>` +
    '<script type="text/x-clay-instructions" name="review">Explain the change for a reviewer.</script>';
  window.clay = { canEdit: true, isDraftMode: false };
});

const ask = (extra = {}) => ai.prompt({ request: "What changed on this branch?", instructions: ["review"], result: "reviews", omit: ["id", "diff"], into: "incoming", ...extra });

test("an owner's prompt holds the request, the instruction text, the shape and the Clay CLI steps", () => {
  const text = ask();
  const doc = window.location.origin + window.location.pathname;
  expect(text.startsWith("What changed on this branch?\n")).toBe(true);
  expect(text).toContain("### review\n\nExplain the change for a reviewer.");
  const shape = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
  expect(shape.required).toEqual(["title", "summary"]);
  expect(text).toContain(`npx -y @panphora/claycli data '${doc}' --json > /tmp/clay-read.json`);
  expect(text).toContain(`'{"incoming": ((.data["incoming"] // []) + $item)}'`);
  expect(text).toContain(`--write - --if-match "$(jq -r .etag /tmp/clay-read.json)"`);
  expect(text).not.toContain("drop that file");
});

test("a visitor's prompt asks for a file to drop and names no Clay CLI step", () => {
  window.clay = { canEdit: true, isDraftMode: true };
  const text = ask({ fileName: "review.json" });
  expect(text).toContain("Save your JSON object to a file named review.json.");
  expect(text).toContain("drop that file on the page");
  expect(text).not.toContain("claycli");
});

test("notes from the page come last", () => {
  const text = ask({ notes: "Attach the diff with jq --rawfile." });
  expect(text.trimEnd().endsWith("## Notes from this page\n\nAttach the diff with jq --rawfile.")).toBe(true);
});

test("an unknown instruction, or into naming no list, throws with a code", () => {
  expect(() => ask({ instructions: ["nope"] })).toThrow(expect.objectContaining({ code: "instruction_missing" }));
  expect(() => ask({ into: "title" })).toThrow(expect.objectContaining({ code: "invalid_request" }));
});

test("a document address with a quote stays one shell word", () => {
  history.replaceState(null, "", "/it's.html");
  const text = ask();
  expect(text).toContain(`data '${window.location.origin}/it'\\''s.html' --json`);
  history.replaceState(null, "", "/");
});
