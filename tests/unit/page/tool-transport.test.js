import { jest } from "@jest/globals";
import { createToolTransport } from "../../../src/page/tool-transport.js";

/**
 * The page-tool helper over clay.wire. `clay.wire` is read when a request goes out,
 * because the page plugin loads before the wire does; a failure keeps the host's code
 * and a cancel reaches the handle the request made.
 */

const payload = { protocol: "page-tool/1", requestId: "req-1", prompt: "make a tally", context: {}, target: null, current: null };
const reply = { requestId: "req-1", artifact: { title: "T" }, state: {}, model: "m" };

const baseClay = window.clay;
afterEach(() => { window.clay = baseClay; });

function wireFor(outcome) {
  const calls = [];
  const send = jest.fn((body, options) => {
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    calls.push({ body, options, resolve: finish });
    return { done, cancel: jest.fn() };
  });
  return { wire: { send }, calls };
}

test("a request goes out as the page-tool helper with the request id and the status hook", async () => {
  const { wire, calls } = wireFor();
  const onStatus = jest.fn();
  window.clay = { wire };
  const transport = createToolTransport();

  const result = transport.request(payload, { onStatus });
  calls[0].resolve({ state: "done", result: reply });

  await expect(result).resolves.toEqual(reply);
  expect(calls[0].body).toBe(payload);
  expect(calls[0].options).toEqual({ helper: "page-tool", document: "none", id: "req-1", onStatus });
});

test("the wire is read when a request is made, not when the transport is built", async () => {
  window.clay = undefined;
  const transport = createToolTransport();
  const { wire, calls } = wireFor();
  window.clay = { wire };

  const result = transport.request(payload, {});
  calls[0].resolve({ state: "done", result: reply });

  await expect(result).resolves.toEqual(reply);
});

test("a page with no wire rejects with no-wire and sends nothing", async () => {
  window.clay = undefined;
  const transport = createToolTransport();

  await expect(transport.request(payload, {})).rejects.toMatchObject({ code: "no-wire", name: "ToolTransportError" });
});

test("a host error keeps its code and message", async () => {
  const { wire, calls } = wireFor();
  window.clay = { wire };
  const transport = createToolTransport();

  const result = transport.request(payload, {});
  calls[0].resolve({ state: "error", error: "this account is out of credits", errorCode: "no-credits" });

  await expect(result).resolves.toEqual({
    requestId: "req-1",
    code: "no-credits",
    message: "this account is out of credits",
  });
});

test("cancelling reaches the handle that request made, and only that one", async () => {
  const { wire, calls } = wireFor();
  window.clay = { wire };
  const transport = createToolTransport();

  const first = transport.request(payload, {});
  const second = transport.request({ ...payload, requestId: "req-2" }, {});
  transport.cancel("req-1");
  transport.cancel("req-9");

  expect(wire.send.mock.results[0].value.cancel).toHaveBeenCalledTimes(1);
  expect(wire.send.mock.results[1].value.cancel).not.toHaveBeenCalled();

  calls[0].resolve({ state: "cancelled" });
  calls[1].resolve({ state: "done", result: { ...reply, requestId: "req-2", state: 1 } });
  await expect(first).resolves.toMatchObject({ code: "cancelled" });
  await expect(second).resolves.toMatchObject({ requestId: "req-2", state: 1 });
});
