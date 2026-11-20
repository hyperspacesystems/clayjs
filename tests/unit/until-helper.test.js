import { until } from "../helpers/until.js";

test("until returns the first truthy value the check gives", async () => {
  let calls = 0;
  await expect(until(() => (++calls >= 3 ? { ready: calls } : null))).resolves.toEqual({ ready: 3 });
});

test("until throws, naming what it waited for, when the time runs out", async () => {
  await expect(until(() => false, { timeout: 30, what: "the saved toast" })).rejects.toThrow("timed out after 30 ms waiting for the saved toast");
});

test("until waits for an async check", async () => {
  let n = 0;
  await expect(until(async () => ++n > 2)).resolves.toBe(true);
});
