// Highlighted code as lines, for diff and file views that put each line in its own
// row. highlight.js leaves a span open across a line break inside a multi-line string
// or comment, so splitting its output on "\n" breaks the rows; every line here reopens
// what an earlier line left open and closes what it opened. A file's grammar loads
// the first time a file in that language is shown, and never otherwise.
import { assets } from "./assets.js";

const EXTENSIONS = {
  sh: "bash", bash: "bash", zsh: "bash",
  c: "c", h: "c",
  cc: "cpp", cpp: "cpp", cxx: "cpp", hh: "cpp", hpp: "cpp", hxx: "cpp",
  css: "css",
  diff: "diff", patch: "diff",
  go: "go",
  java: "java",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  json: "json",
  md: "markdown", markdown: "markdown",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sql: "sql",
  swift: "swift",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  html: "xml", htm: "xml", htmlclay: "xml", xml: "xml", svg: "xml",
  yml: "yaml", yaml: "yaml",
};

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ESCAPES[c]);
const TAG = /<span[^>]*>|<\/span>/g;

export function languageFor(path) {
  const name = String(path ?? "").split("/").pop().toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = name.slice(dot + 1);
  return Object.prototype.hasOwnProperty.call(EXTENSIONS, ext) ? EXTENSIONS[ext] : null;
}

export function balanceLines(html) {
  const lines = [];
  const open = [];
  for (const line of String(html).split("\n")) {
    const reopened = open.join("");
    for (const [tag] of line.matchAll(TAG)) {
      if (tag === "</span>") open.pop();
      else open.push(tag);
    }
    lines.push(reopened + line + "</span>".repeat(open.length));
  }
  return lines;
}

// One entry per line of `code`, each a balanced HTML string. A language with no
// grammar in this release gives escaped plain lines.
export async function highlightLines(code, language) {
  const text = String(code ?? "");
  if (!language || !assets.names().includes(`highlight/${language}`)) return text.split("\n").map(escapeHtml);
  const [{ default: hljs }, { default: grammar }] = await Promise.all([assets.load("highlight"), assets.load(`highlight/${language}`)]);
  if (!hljs.getLanguage(language)) hljs.registerLanguage(language, grammar);
  return balanceLines(hljs.highlight(text, { language, ignoreIllegals: true }).value);
}

export default { languageFor, balanceLines, highlightLines };
