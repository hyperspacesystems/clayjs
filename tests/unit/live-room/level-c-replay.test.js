/**
 * @jest-environment node
 */
// C4 part 3: Level C replay through a seeded fault proxy. Drives real headless createRoomClient
// instances against createReferenceHost with injected transport faults (dropped frame POSTs, lost
// save answers, room restarts, version restores over dirty rooms, and host agent patches), then
// verifies convergence and durability against an independent read of the host file.
import { createReferenceHost } from "../../live-room/host/reference-host.mjs";
import { createRoomClient } from "../../../src/live-room/room-client.js";
import { serialize, parse } from "../../../src/live-room/core/record.js";
import { useCodec } from "../../../src/live-room/core/codec.js";
import { labLimits } from "../../../src/live-room/core/limits.js";
import { codec as tiny } from "../../live-room/lab/codec-tiny/reducer.mjs";

const RECORD = { v: 2, doc: "doc0123456789abc", gen: "0.00000000", epoch: 0, commit: "c00000000000", parent: null, through: 0 };
const START = { wb: { rows: { r1: { pos: "1", cells: { c1: "init" } }, r2: { pos: "2", cells: {} }, r3: { pos: "3", cells: {} } } }, seen: {}, lineage: [], cut: null, floor: -1 };
const set = (row, col, value) => ({ t: "set", row, col, value });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const open = [];
afterEach(() => Promise.all(open.splice(0).map((c) => c.close())));

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("level-c timeout");
    await pause(5);
  }
}

// A fault proxy over referenceHost.fetch that injects seeded drops, delays, and 503 save-unknowns
// while `active` is true, then becomes clean so the session can settle.
function faultProxy(host, seed) {
  const rand = rng(seed);
  let active = true;
  const counts = { droppedFrames: 0, unknownSaves: 0, delayed: 0 };
  const fetch = async (url, init = {}) => {
    const path = String(url);
    const method = (init.method ?? "GET").toUpperCase();
    if (active && method === "POST" && path.includes("/_/sync/room") && !path.includes("op=") && rand() < 0.25) {
      counts.droppedFrames += 1;
      throw new TypeError("fault proxy: dropped frame batch");
    }
    if (active && method === "POST" && path.includes("/_/save") && rand() < 0.35) {
      const real = await host.fetch(url, init);
      if (real.ok) {
        counts.unknownSaves += 1;
        return new Response("save unknown", { status: 503 });
      }
      return real;
    }
    if (active && rand() < 0.2) {
      counts.delayed += 1;
      await pause(Math.floor(rand() * 12) + 2);
    }
    return host.fetch(url, init);
  };
  return {
    fetch,
    calm() {
      active = false;
    },
    counts,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}

test("Level C fault-proxy replay: two tabs + room restart + host agent patch converge cleanly across seeded schedules", async () => {
  for (const seed of [101, 202, 303, 404, 505]) {
    const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits() } });
    useCodec(tiny);
    host.put("doc", serialize(RECORD, START));
    const proxy = faultProxy(host, seed);

    const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: proxy.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 12, maxMs: 35, waitMs: 25 });
    const ben = createRoomClient({ page: "doc", codec: tiny, clientId: "ben", fetch: proxy.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 12, maxMs: 35, waitMs: 25 });
    open.push(ana, ben);
    await Promise.all([ana.ready, ben.ready]);

    const rand = rng(seed + 999);
    const handles = [];
    let agentSubmitted = false;
    for (let step = 0; step < 10; step++) {
      const tab = step % 2 === 0 ? ana : ben;
      const row = step % 3 === 0 ? "r1" : step % 3 === 1 ? "r2" : "r3";
      const col = `c${(step % 3) + 1}`;
      const h = tab.submit(set(row, col, `s${seed}-${step}`));
      if (h) handles.push({ tab, h, row, col, val: `s${seed}-${step}` });
      if (step === 4) host.loseRoom("doc");
      if (step === 7 && host.rooms.get("doc")) {
        const res = await host.submit("doc", set("r3", "c4", `agent-${seed}`), { waitMs: 40 });
        expect(res.answer).toBe("ok");
        agentSubmitted = true;
      }
      if (rand() < 0.4) await pause(8);
    }

    proxy.calm();
    await Promise.all([ana.flush(), ben.flush()]);
    await until(() => JSON.stringify(canonical(ana.view())) === JSON.stringify(canonical(ben.view())), 3000);

    useCodec(tiny);
    const disk = parse(host.file("doc").bytes).state.wb;
    expect(ana.view()).toEqual(disk);
    expect(ben.view()).toEqual(disk);
    if (agentSubmitted) expect(disk.rows.r3.cells.c4).toBe(`agent-${seed}`);
    expect(ana.status.pending).toBe(0);
    expect(ben.status.pending).toBe(0);
    expect(ana.status.unknownSave).toBe(false);
    expect(ben.status.unknownSave).toBe(false);

    // Every edit handle settled cleanly as saved (no silent drops).
    for (const item of handles) {
      expect(await item.h.durable).toBe("saved");
    }
    await Promise.all([ana.close(), ben.close()]);
  }
});

test("Level C fault-proxy replay: version restore over dirty room backs up and auto-restores non-conflicting cells", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits() } });
  useCodec(tiny);
  const v0 = serialize(RECORD, START);
  host.put("doc", v0);
  {
    const { record, state } = parse(v0);
    state.wb.rows.r1.cells.c1 = "v1";
    await host.outside("doc", serialize(record, state), "agent");
  }
  const proxy = faultProxy(host, 777);
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: proxy.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 15, maxMs: 40, waitMs: 25 });
  open.push(ana);
  await ana.ready;

  // Ana edits r2.c1 (non-conflicting with v0's r1.c1="init"), room drops, v0 restored.
  await ana.submit(set("r2", "c1", "ana-kept")).admitted;
  host.loseRoom("doc");
  await host.outside("doc", v0, "restore");

  proxy.calm();
  await ana.flush();
  await until(() => {
    useCodec(tiny);
    return parse(host.file("doc").bytes).state.wb.rows.r2?.cells?.c1 === "ana-kept";
  }, 3000);

  useCodec(tiny);
  const disk = parse(host.file("doc").bytes).state.wb;
  expect(disk.rows.r1.cells.c1).toBe("init");
  expect(disk.rows.r2.cells.c1).toBe("ana-kept");
  expect(ana.view()).toEqual(disk);
  expect(ana.status.copies).toBeGreaterThanOrEqual(1);
});

// Bug it catches: reference-host split h:<gen>:<n> on the first colon, returning "lost" for a
// durable agent edit whenever the room dropped after the commit landed on disk.
test("host.submit reports ok when the room drops right after the agent patch commits to disk", async () => {
  const host = createReferenceHost({ codecs: { tiny }, codec: "tiny", rooms: { limits: labLimits() } });
  useCodec(tiny);
  host.put("doc", serialize(RECORD, START));
  const ana = createRoomClient({ page: "doc", codec: tiny, clientId: "ana", fetch: host.fetch, subscribe: host.subscribe, limits: labLimits(), idleMs: 10, maxMs: 25, waitMs: 20 });
  open.push(ana);
  await ana.ready;
  await expect(ana.submit(set("r1", "c1", "open")).durable).resolves.toBe("saved");

  // Drop the room right after the save commits while host.submit is waiting.
  const pendingSubmit = host.submit("doc", set("r2", "c1", "from-agent"), { waitMs: 100 });
  await ana.flush();
  host.loseRoom("doc");
  const res = await pendingSubmit;
  expect(res.answer).toBe("ok");
  expect(res.applied).toBe(true);
  useCodec(tiny);
  expect(parse(host.file("doc").bytes).state.wb.rows.r2.cells.c1).toBe("from-agent");
});
