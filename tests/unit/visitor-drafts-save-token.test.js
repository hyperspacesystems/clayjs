import { expect, jest, test } from "@jest/globals";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("ordinary autosave and sliced saves send their snapshot token to the draft transport", async () => {
  document.documentElement.setAttribute("visitor-drafts", "snapshot-token");
  document.head.innerHTML = '<script type="application/json" data-rules-name="api" data-rules-version="1">{"note":"#note","value":"#value@value"}</script>';
  document.body.innerHTML = `<article>${"x".repeat(320 * 1024)}</article><p id="note">initial</p><input id="value" persist value="initial">`;
  const mode = await import("../../src/core/draft-mode.js");
  mode.noteBootParams(new URLSearchParams("plugins=visitor-drafts"));
  const send = jest.fn(async () => {});
  mode.setDraftTransport(send);
  const fetch = jest.fn(async () => { throw new Error("draft saves must not reach the host"); });
  window.fetch = globalThis.fetch = fetch;
  const save = await import("../../src/core/save.js");
  const gate = await import("../../src/lib/dirty-gate.js");
  gate.startDirtyGate();
  for (let i = 0; i < 100 && !save.baselineSettled(); i++) await wait(50);
  expect(save.baselineSettled()).toBe(true);
  const note = document.getElementById("note");
  const input = document.getElementById("value");
  note.textContent = "ordinary autosave";
  input.value = "ordinary value";
  const ordinaryAt = gate.gateTokenNow();
  expect((await save.savePageThrottled()).ok).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0][0]).toContain("ordinary autosave");
  expect(send.mock.calls[0][1]).toEqual(ordinaryAt);
  expect(send.mock.calls[0][1].probe).toContainEqual([input, "ordinary value"]);

  let clock = 0;
  const performanceNow = jest.spyOn(performance, "now").mockImplementation(() => (clock += 10));
  try {
    note.textContent = "warm sliced driver";
    expect((await save.savePage()).ok).toBe(true);
    let captures = 0;
    const captured = () => { captures++; };
    document.addEventListener("clay:snapshot-ready", captured);
    try {
      note.textContent = "sliced checkpoint";
      input.value = "checkpoint value";
      const at = gate.gateTokenNow();
      const before = send.mock.calls.length;
      const saving = save.savePage();
      expect(captures).toBe(1);
      expect(send).toHaveBeenCalledTimes(before);
      note.textContent = "typed while preparing";
      input.value = "late value";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect((await saving).ok).toBe(true);
      expect(send).toHaveBeenCalledTimes(before + 1);
      const [html, token] = send.mock.calls.at(-1);
      expect(html).toContain("sliced checkpoint");
      expect(html).not.toContain("typed while preparing");
      expect(token).toEqual(at);
      expect(token.probe).toContainEqual([input, "checkpoint value"]);
      expect(gate.gateUnchangedSince(token)).toBe(false);
    } finally {
      document.removeEventListener("clay:snapshot-ready", captured);
    }
  } finally {
    performanceNow.mockRestore();
  }
  const { saveHtml } = await import("../../src/core/save-core.js");
  expect((await saveHtml("<!DOCTYPE html><html><head><title>Raw</title></head><body>raw capture</body></html>")).ok).toBe(true);
  expect(send.mock.calls.at(-1)[1]).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
}, 45000);
