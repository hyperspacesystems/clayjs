/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://example.com/sheet.html"}
 */
import { jest } from "@jest/globals";

class FakeEventSource extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
  }
  close() {}
}

const tallyBase = { name: "tally-base", version: "1.0.0", api: 1, setup: () => ({}) };

const tally = {
  name: "tally",
  version: "1.0.0",
  api: 1,
  order: 5,
  requires: ["tally-base"],
  boundaries: { tally: { opaque: true } },
  ownership: [{ within: "[tally]", select: "li[total]", text: true, attrs: ["data-sum"] }],
  setup() {
    return {
      boundaries: {
        tally(_pass, el) {
          let sum = 0;
          for (const li of el.children) {
            if (!li.hasAttribute("total")) sum += Number(li.textContent) || 0;
          }
          const total = el.querySelector("li[total]");
          if (total.textContent !== String(sum)) total.textContent = String(sum);
          if (total.getAttribute("data-sum") !== String(sum)) total.setAttribute("data-sum", String(sum));
        },
      },
    };
  },
};

const page = (n, a, b, total) =>
  `<main sap state="n:num" n="${n}"><output data-id="next" text="state.n + 1" attr:data-next="state.n + 1" data-next="${n + 1}">${n + 1}</output>` +
  `<ul tally="scores"><li data-id="a">${a}</li><li data-id="b">${b}</li>` +
  `<li total data-id="total" data-sum="${total}">${total}</li></ul></main>`;

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test("a sliced save refused by an owner answers ok: false and does not pass the person's save flag to the next autosave", async () => {
  jest.resetModules();
  if (window.__clayMutation?._observer) window.__clayMutation._observer.disconnect();
  delete window.__clayMutation;
  window.clayEditMode = true;
  window.scrollTo = () => {};

  const sentHeaders = [];
  global.fetch = jest.fn(async (url, init = {}) => {
    if (init.method === "POST" && /\/_\/save/.test(String(url))) {
      const h = init.headers || {};
      sentHeaders.push(h["X-Save-Trigger"] ?? h.get?.("X-Save-Trigger") ?? null);
      return { ok: true, status: 200, statusText: "OK", headers: { get: () => null }, text: async () => JSON.stringify({ msg: "Saved", etag: "e1" }) };
    }
    return { ok: false, status: 404, statusText: "Not Found", headers: { get: () => null }, text: async () => "" };
  });

  const big = "x".repeat(330_000);
  document.body.innerHTML = `<p id="note">hello</p><section item><table grid><tbody><tr><td>1</td></tr></tbody></table></section>`;

  const save = await import("../../src/core/save.js");
  const regions = await import("../../src/lib/owned-regions.js");
  const gesture = await import("../../src/lib/user-gesture.js");
  await flush();
  save.releaseBootSettle();

  let rev = 1;
  let refuse = false;
  const handle = regions.own("section[item] > table[grid]", {
    serialize: () => {
      if (refuse) throw Object.assign(new Error("pending cell"), { code: "sheet-pending" });
      return `<tbody><tr><td>${rev}:${big}</td></tr></tbody>`;
    },
    revision: () => rev,
  });

  // First save writes >320 KB so preparesSliced() becomes true!
  await save.savePageForce();
  expect(sentHeaders.length).toBe(1);

  // User presses Cmd+S while sheet refuses with code='sheet-pending'
  rev = 2;
  refuse = true;
  gesture.markExplicitSave();
  const errResult = await save.savePage();
  const leakedExplicitIntent = gesture.consumeExplicitSave();

  expect(errResult.ok).toBe(false);
  expect(errResult.code).toBe("sheet-pending");
  expect(leakedExplicitIntent).toBe(false);
  await new Promise((r) => setTimeout(r, 50));
  handle.dispose();
});
