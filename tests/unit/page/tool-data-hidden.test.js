import { project, renderModel } from "../../../src/page/projection.js";
import { extractData } from "../../../src/vendor/hyper-html-api-data.vendor.js";

// A tool section carries its source as JSON in a script. A data reader must see the
// tool's visible fallback text, never that JSON.
const blocks = {
  tool: { t: "tool", pos: "Q", artifact: { title: "Countdown", html: "<b>x</b>", css: "", javascript: "", fallbackHtml: "<p>Launch in 9 days</p>", summary: "" }, rev: "r1", state: { n: 1 } },
};

function read() {
  const model = project(blocks);
  const html = renderModel(model, { fallbackOf: (id) => blocks[id]?.artifact?.fallbackHtml ?? "" });
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body><article class="blockeditor" data-blockeditor="1">${html}</article></body></html>`, "text/html");
  return { doc, content: extractData(doc, { content: "article section" }).content };
}

test("a tool section's data is its visible text, without the tool's JSON source", () => {
  const { doc, content } = read();
  expect(doc.querySelector("script[data-tool]")).not.toBeNull();
  expect(content).toContain("Launch in 9 days");
  expect(content).not.toContain("artifact");
  expect(content).not.toContain("Countdown");
});
