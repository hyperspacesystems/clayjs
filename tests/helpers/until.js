// Waits until check() returns something truthy, and returns it. Throws when the time runs out, so a
// test never carries on past a wait that did not happen and fails later with a confusing message.
// check may be async. A proof that something did NOT happen is not a wait: sleep past the bound the
// code under test promises (or use fake timers), then assert.
export async function until(check, { timeout = 2000, interval = 5, what } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeout} ms waiting for ${what ?? String(check)}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// An edit boot's saved baseline settles at the latest through save.js's 3000 ms fallback
// (MAX_SETTLE_MS); the limit leaves room for a busy box. A view boot never settles it, so
// only wait on an edit boot.
export const untilBaselineSettled = (save) =>
  until(() => save.baselineSettled(), { timeout: 6000, what: "the saved baseline to settle" });
