import { expect, test } from "@jest/globals";
import { assets } from "../../src/lib/assets.js";

const opens = (line) => (line.match(/<span[^>]*>/g) || []).length;
const closes = (line) => (line.match(/<\/span>/g) || []).length;

test("the asset resolves the three helpers", async () => {
  const mod = await assets.load("highlight-lines");
  expect(typeof mod.highlightLines).toBe("function");
  expect(typeof mod.languageFor).toBe("function");
  expect(typeof mod.balanceLines).toBe("function");
});

// Highlighting a Rust file must not fetch or register any other grammar: a review of a
// hundred files in four languages downloads four grammars.
test("highlighting a file registers its grammar and no other", async () => {
  const { highlightLines } = await assets.load("highlight-lines");
  const { default: hljs } = await assets.load("highlight");
  expect(hljs.getLanguage("rust")).toBeUndefined();
  await highlightLines("fn main() {}", "rust");
  expect(hljs.getLanguage("rust")).toBeDefined();
  expect(hljs.getLanguage("go")).toBeUndefined();
  expect(hljs.getLanguage("swift")).toBeUndefined();
});

test("a comment that crosses lines is reopened and closed on every line", async () => {
  const { highlightLines } = await assets.load("highlight-lines");
  const code = "const a = 1;\n/* one\ntwo\nthree */\nconst b = 2;";
  const lines = await highlightLines(code, "typescript");
  expect(lines).toHaveLength(5);
  for (const line of lines) expect(opens(line)).toBe(closes(line));
  expect(lines[2]).toMatch(/^<span class="hljs-comment">two<\/span>$/);
});

test("languageFor maps extensions, and unknown or prototype names to null", async () => {
  const { languageFor } = await assets.load("highlight-lines");
  expect(languageFor("internal/auth/refresh.go")).toBe("go");
  expect(languageFor("web/App.TSX")).toBe("typescript");
  expect(languageFor("Makefile")).toBeNull();
  expect(languageFor("a.constructor")).toBeNull();
  expect(languageFor("notes.txt")).toBeNull();
});

test("a language with no grammar gives escaped plain lines", async () => {
  const { highlightLines } = await assets.load("highlight-lines");
  await expect(highlightLines("<b>&\nx", null)).resolves.toEqual(["&lt;b&gt;&amp;", "x"]);
});
