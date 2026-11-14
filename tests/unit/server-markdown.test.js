/**
 * @jest-environment node
 */
import { JSDOM } from "jsdom";
import { Marked } from "../../src/vendor/marked.vendor.js";
import { markdownArticle } from "../../src/server/markdown/index.js";
import { importMarkdownTokens } from "../../src/page/import-markdown.js";
import { project, revOf } from "../../src/page/projection.js";

const createDocument = () => new JSDOM("").window.document;

const TEXT = "# Notes\n\nA **bold** word.\n\n- one\n- [x] done\n";

const root = (html, document) => {
  const node = document.createElement("div");
  node.innerHTML = html;
  return node;
};

test("a heading, a paragraph and a task list become one article with its title and revision", () => {
  const document = createDocument();
  const { html, rev, title } = markdownArticle(TEXT, { document });
  const node = root(html, document);
  const heading = node.querySelector("h1");
  expect(heading.textContent).toBe("Notes");
  expect(node.querySelector("strong").textContent).toBe("bold");
  expect(node.querySelectorAll("ul > li")).toHaveLength(2);
  const box = node.querySelector('input[type="checkbox"]');
  expect(box.checked).toBe(true);
  expect(box.disabled).toBe(true);
  expect(node.querySelector("h1").getAttribute("data-id")).toBeTruthy();
  expect(node.querySelector("p").getAttribute("data-id")).toBeTruthy();
  for (const item of node.querySelectorAll("li")) expect(item.getAttribute("data-id")).toBeTruthy();
  expect(title).toBe("Notes");
  expect(rev).toMatch(/^[0-9a-f]{16}$/);
});

test("the revision is the projection's own, and it moves with the text", () => {
  const document = createDocument();
  const tokens = new Marked().lexer(TEXT);
  const { blocks } = importMarkdownTokens(tokens, { document });
  const model = project(blocks);
  expect(revOf(model)).toMatch(/^[0-9a-f]{16}$/);
  expect(revOf(project(blocks))).toBe(revOf(model));
  const first = markdownArticle(TEXT, { document });
  const second = markdownArticle(TEXT, { document });
  const shape = (html) => html.replace(/data-id="[^"]*"/g, 'data-id=""');
  expect(shape(second.html)).toBe(shape(first.html));
  expect(markdownArticle("# Other\n", { document }).rev).not.toBe(first.rev);
});

test("raw HTML is cleaned of scripts and handlers, and both blocks are named unsupported", () => {
  const document = createDocument();
  const { html, unsupported } = markdownArticle("<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n", { document });
  expect(html).not.toContain("<script");
  expect(html).not.toContain("onerror");
  expect(unsupported).toHaveLength(2);
});

test("an image address is resolved when asked, and refused when the default check reads it", () => {
  const document = createDocument();
  const resolved = markdownArticle("![chart](img/a.png)", {
    document,
    resolveImage: (src) => (src === "img/a.png" ? "/uploads/u/a.png" : null),
  });
  expect(resolved.html).toContain('src="/uploads/u/a.png"');
  const plain = markdownArticle("![chart](img/a.png)", { document });
  expect(plain.html).not.toContain("<img");
  expect(plain.refused).toEqual([{ type: "image", href: "img/a.png" }]);
  expect(plain.html).toContain("chart");
});

test("a call without a DOM document is refused", () => {
  expect(() => markdownArticle("# Hi")).toThrow(TypeError);
});

test("a link to another local file is kept as text, never turned into a web address", () => {
  const { html, refused } = markdownArticle("See [other](other.md), [page](notes/a.html) and [site](example.com).", { document: createDocument() });
  expect(html).not.toContain("https://other.md");
  expect(html).not.toContain("notes/a.html\"");
  expect(html).toContain("other");
  expect(html).not.toContain("https://example.com");
  expect(refused.map((entry) => entry.href)).toEqual(["other.md", "notes/a.html", "example.com"]);
});

test("a relative path to any file never becomes a web address, for links and images", () => {
  const { html, refused } = markdownArticle("Run [setup](setup.sh), get [zip](export.zip), keep [web](https://example.com/a).\n\n![demo](demo.mov)", { document: createDocument() });
  expect(html).not.toContain("https://setup.sh");
  expect(html).not.toContain("https://export.zip");
  expect(html).not.toContain("https://demo.mov");
  expect(html).not.toContain("<img");
  expect(html).toContain('href="https://example.com/a"');
  expect(refused.map((entry) => entry.href)).toEqual(["setup.sh", "export.zip", "demo.mov"]);
});

test("resolveLink maps a local link to the page the host imported", () => {
  const resolveLink = (href) => (href === "other.md" ? "/notes/other.html" : null);
  const { html, refused } = markdownArticle("See [other](other.md).", { document: createDocument(), resolveLink });
  expect(html).toContain('href="/notes/other.html"');
  expect(refused).toEqual([]);
});
