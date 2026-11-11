/**
 * save-header-source: a header computed from the bytes of one save, and the host's
 * `siteData` answer carried out to the result and to the accepted hook.
 */
import { jest } from "@jest/globals";

const okJson = (body) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: { get: () => null },
  text: async () => JSON.stringify(body)
});

let core;
let save;
let accepted;

beforeAll(async () => {
  window.clayEditMode = true;
  document.body.innerHTML = '<div id="content">start</div>';
  core = await import("../../src/core/save-core.js");
  save = await import("../../src/core/save.js");
  accepted = await import("../../src/core/save-accepted.js");
});

const answerSavesWith = (body) => {
  const sent = [];
  global.fetch = jest.fn(async (url, options = {}) => {
    if (String(url).includes("/_/save")) {
      sent.push(options);
      return okJson(body);
    }
    return okJson({ spec: 1, document: { etag: "base-1" } });
  });
  return sent;
};

test("a source's headers describe the bytes of that request", () => {
  const remove = core.addSaveHeaderSource((content) => ({ "X-Length": content.length }));
  try {
    expect(core.buildSaveRequest("abc", false, undefined, "id-1", null).options.headers["X-Length"]).toBe("3");
    expect(core.buildSaveRequest("abcdef", false, undefined, "id-2", null).options.headers["X-Length"]).toBe("6");
  } finally {
    remove();
  }
  expect(core.buildSaveRequest("abc", false, undefined, "id-3", null).options.headers["X-Length"]).toBeUndefined();
});

test("a source that returns null adds nothing, and one that throws does not stop the save", () => {
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  const removeNull = core.addSaveHeaderSource(() => null);
  const removeThrow = core.addSaveHeaderSource(() => { throw new Error("no"); });
  try {
    const { options } = core.buildSaveRequest("abc", false, undefined, "id-4", "etag-1");
    expect(options.headers["Save-ID"]).toBe("id-4");
    expect(options.headers["If-Match"]).toBe("etag-1");
    expect(error).toHaveBeenCalled();
  } finally {
    removeNull();
    removeThrow();
    error.mockRestore();
  }
});

test("a source cannot replace the stamp of the save", () => {
  const remove = core.addSaveHeaderSource(() => ({ "If-Match": "forged" }));
  try {
    expect(core.buildSaveRequest("abc", false, undefined, "id-5", "etag-real").options.headers["If-Match"]).toBe("etag-real");
  } finally {
    remove();
  }
});

test("the host's siteData reaches the result and the accepted hook", async () => {
  const siteData = { written: ["nav"], refused: [{ key: "brand", code: "not-allowed" }] };
  answerSavesWith({ msg: "Saved", etag: "e-2", siteData });
  const seen = [];
  accepted.onSaveAccepted((html, info) => seen.push(info));
  document.getElementById("content").textContent = "edited once";

  const result = await save.savePage();

  expect(result.ok).toBe(true);
  expect(result.siteData).toEqual(siteData);
  expect(seen.at(-1).siteData).toEqual(siteData);
});

test("a save the host answers without siteData has no such field anywhere", async () => {
  answerSavesWith({ msg: "Saved", etag: "e-3" });
  const seen = [];
  accepted.onSaveAccepted((html, info) => seen.push(info));
  document.getElementById("content").textContent = "edited twice";

  const result = await save.savePage();

  expect(result.ok).toBe(true);
  expect("siteData" in result).toBe(false);
  expect("siteData" in seen.at(-1)).toBe(false);
});
