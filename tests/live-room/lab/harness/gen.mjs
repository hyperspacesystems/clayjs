import { newWorld, live, writer, join, userEdit, setConnected, close, roomLoss, expire, endRoom, restore, outsideWrite, retitle, restoreFromCopy, decideConflicts, quiesce, lull, attached, view, toRoom, post, waited, land, dropWire, echo, toTab, capture, answer, hostTake, deliver, step, linking, rotate, lagging, checkStep } from "./world.mjs";
import { parse } from "../core/record.mjs";
import { faultPlan } from "./host.mjs";
import { keyBetween } from "./vendor/order-keys.mjs";
import { rng, rowsInOrder, COLS } from "./lib.mjs";
import { cellsOf } from "../codec-tiny/reducer.mjs";
import { refAction } from "./lens.mjs";

const pick = (rnd, list) => (list.length ? list[Math.floor(rnd() * list.length)] : null);
const slow = (world, way, tab) => world.slow?.[way] === Number(tab.id.slice(1)) % 3;
const pickLink = (world, rnd, way, ready) => {
  const tab = pick(rnd, ready);
  return tab && slow(world, way, tab) && rnd() < 0.9 ? null : tab;
};
const byId = (world, id) => live(world).find((tab) => tab.id === id) ?? null;

const between = (left, right) => {
  try {
    return keyBetween(left, right);
  } catch {
    return left ?? right ?? keyBetween(null, null);
  }
};

const flying = (frame) => Boolean(frame.action) && !frame.noop && !frame.keep && Boolean(frame.copy || frame.take || frame.origin);
const inFlight = (world, tab) => (attached(world, tab) ? tab.tail.filter(flying) : []);
const stranded = (world, tab) => [...(attached(world, tab) ? [] : tab.tail), ...tab.held.flatMap((held) => held.frames)].filter(flying);

const HOW = ["ok", "refuse", "drop-applied", "drop-lost"];

const TEXT = ["<b>", "a&b", "&amp;", '"q"', '</td><td data-col="c9">x', "</tr>", "</script>", "<!--", "1 < 2 > 0", "&lt;", "é 表"];

export const MOVES = {
  value(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : pick(rnd, live(world));
    if (!tab) return null;
    const row = args ? args[1] : pick(rnd, rowsInOrder(view(tab)));
    const col = args ? args[2] : pick(rnd, COLS);
    if (!row) return null;
    const value = args?.[3] ?? `v${++world.values}`;
    userEdit(world, tab, { t: "set", row, col, value });
    return [tab.id, row, col, value];
  },

  text(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : pick(rnd, live(world));
    if (!tab) return null;
    const row = args ? args[1] : pick(rnd, rowsInOrder(view(tab)));
    const col = args ? args[2] : pick(rnd, COLS);
    if (!row) return null;
    const value = args?.[3] ?? `${pick(rnd, TEXT)}${++world.values}`;
    userEdit(world, tab, { t: "set", row, col, value });
    return [tab.id, row, col, value];
  },

  clear(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : pick(rnd, live(world));
    if (!tab) return null;
    const wb = view(tab);
    const filled = rowsInOrder(wb).flatMap((row) => Object.keys(wb.rows[row].cells).map((col) => [row, col]));
    const [row, col] = args ? args.slice(1) : pick(rnd, filled) ?? [];
    if (!row) return null;
    userEdit(world, tab, { t: "set", row, col, value: "" });
    return [tab.id, row, col];
  },

  paste(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : pick(rnd, live(world));
    if (!tab) return null;
    const rows = rowsInOrder(view(tab));
    if (!rows.length) return null;
    let cells = args?.[1];
    if (!cells) {
      const x = rnd();
      const count = x < 0.7 ? 2 + Math.floor(rnd() * 5) : x < 0.94 ? 7 + Math.floor(rnd() * 30) : 60 + Math.floor(rnd() * 60);
      const taken = new Set();
      cells = [];
      for (let i = 0; i < count; i++) {
        const row = pick(rnd, rows);
        const col = count <= 6 ? pick(rnd, COLS) : `k${Math.floor(rnd() * 40)}`;
        if (taken.has(`${row}/${col}`)) continue;
        taken.add(`${row}/${col}`);
        cells.push([row, col, `v${++world.values}`]);
      }
    }
    const id = userEdit(world, tab, { t: "paste", cells });
    return [tab.id, id ? `${cells.length} cells` : `${cells.length} cells, over the action cap`];
  },

  insert(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : pick(rnd, live(world));
    if (!tab) return null;
    const wb = view(tab);
    const rows = rowsInOrder(wb);
    const row = args ? args[1] : `n${++world.rows}`;
    let pos = args?.[2];
    if (!pos) {
      const at = Math.floor(rnd() * (rows.length + 1));
      pos = between(at > 0 ? wb.rows[rows[at - 1]].pos : null, at < rows.length ? wb.rows[rows[at]].pos : null);
    }
    userEdit(world, tab, { t: "ins", row, pos, cells: {} });
    return [tab.id, row, pos];
  },

  remove(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : pick(rnd, live(world));
    if (!tab) return null;
    const rows = rowsInOrder(view(tab));
    const row = args ? args[1] : rows.length > 1 ? pick(rnd, rows) : null;
    if (!row || !rows.includes(row)) return null;
    userEdit(world, tab, { t: "del", row });
    return [tab.id, row];
  },

  out(world, rnd, args) {
    const ready = live(world).filter((tab) => tab.connected && tab.out.length && world.room);
    const tab = args ? byId(world, args[0]) : world.slow ? pickLink(world, rnd, "up", ready) : pick(rnd, ready);
    if (!tab || !toRoom(world, tab)) return null;
    return [tab.id];
  },

  post(world, rnd, args) {
    const ready = live(world).filter((tab) => tab.connected && tab.out.length);
    const tab = args ? byId(world, args[0]) : world.slow ? pickLink(world, rnd, "up", ready) : pick(rnd, ready);
    if (!tab || !post(world, tab)) return null;
    return [tab.id];
  },

  land(world, rnd) {
    if (!world.wire.length) return null;
    const at = world.mode === "scrambled" ? Math.floor(rnd() * world.wire.length) : 0;
    const who = world.wire[at].tab.id;
    land(world, at);
    return [who];
  },

  "land-lost"(world, rnd) {
    if (!world.wire.length) return null;
    const at = world.mode === "scrambled" ? Math.floor(rnd() * world.wire.length) : 0;
    const who = world.wire[at].tab.id;
    land(world, at, true);
    return [who];
  },

  drop(world, rnd) {
    if (!world.wire.length) return null;
    const at = Math.floor(rnd() * world.wire.length);
    const who = world.wire[at].tab.id;
    dropWire(world, at);
    return [who];
  },

  echo(world, rnd) {
    if (!world.wire.length) return null;
    const at = Math.floor(rnd() * world.wire.length);
    echo(world, at);
    return [world.wire[at].tab.id];
  },

  "wait-out"(world, rnd) {
    const ready = live(world).filter((tab) => tab.connected && tab.flight.size);
    const tab = pick(rnd, ready);
    if (!tab || !waited(world, tab)) return null;
    return [tab.id];
  },

  into(world, rnd, args) {
    const ready = live(world).filter((tab) => tab.connected && attached(world, tab) && lagging(world, tab));
    const tab = args ? byId(world, args[0]) : world.slow ? pickLink(world, rnd, "down", ready) : pick(rnd, ready);
    if (!tab || !toTab(world, tab)) return null;
    return [tab.id];
  },

  connection(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : pick(rnd, live(world));
    if (!tab) return null;
    const on = args ? args[1] === "on" : !tab.connected;
    setConnected(world, tab, on);
    return [tab.id, on ? "on" : "off"];
  },

  checkpoint(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : rnd() < 0.8 ? writer(world) : pick(rnd, live(world).filter((one) => one.connected));
    if (!tab) return null;
    if (args ? args[1] === "flush" : rnd() < 0.6) {
      while (toRoom(world, tab));
      while (toTab(world, tab));
    }
    return capture(world, tab) ? [tab.id] : null;
  },

  answer(world, rnd, args) {
    if (!world.inflight.length) return null;
    const at = args ? args[1] ?? 0 : world.mode === "scrambled" ? Math.floor(rnd() * world.inflight.length) : 0;
    const x = rnd();
    const how = args ? args[0] : x < 0.7 ? "ok" : x < 0.85 ? "refuse" : x < 0.93 ? "drop-applied" : "drop-lost";
    if (!HOW.includes(how)) throw new Error(`unknown answer ${how}`);
    const { tab } = world.inflight[at];
    if (!answer(world, how, at)) return null;
    return [how, at, tab.id];
  },

  host(world, rnd, args) {
    if (!world.inflight.length) return null;
    const at = args ? args[1] ?? 0 : world.mode === "scrambled" ? Math.floor(rnd() * world.inflight.length) : 0;
    const x = rnd();
    const how = args ? args[0] : x < 0.86 ? "ok" : x < 0.93 ? "refuse" : "lost";
    const { tab } = world.inflight[at];
    if (how === "refuse") answer(world, "refuse", at);
    else hostTake(world, at, how === "lost");
    return [how, at, tab.id];
  },

  deliver(world, rnd, args) {
    if (!world.answers.length) return null;
    const at = args ? args[1] ?? 0 : Math.floor(rnd() * world.answers.length);
    const lost = args ? args[0] === "lost" : rnd() < 0.1;
    const { tab } = world.answers[at];
    deliver(world, at, lost);
    return [lost ? "lost" : "ok", at, tab.id];
  },

  step(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : pickLink(world, rnd, "down", live(world).filter(linking));
    if (!tab || !step(world, tab)) return null;
    return [tab.id];
  },

  expire(world) {
    return expire(world) ? [] : null;
  },

  outside(world, rnd, args) {
    const kind = args ? args[0] : rnd() < 0.5 ? "agent" : "upload";
    const at = args ? args[1] : kind === "agent" ? "live" : Math.floor(rnd() * world.host.versions.length);
    const source = at === "live" ? world.host : world.host.versions[at];
    if (!source) return null;
    const row = args ? args[2] : pick(rnd, rowsInOrder(parse(source.body).state.wb));
    if (!row) return null;
    const col = args ? args[3] : pick(rnd, COLS);
    const value = args?.[4] ?? `o${++world.values}`;
    outsideWrite(world, kind, at, { t: "set", row, col, value });
    return [kind, at, row, col, value];
  },

  lull(world) {
    return lull(world) ? [] : null;
  },

  join(world, rnd, args) {
    if (!args && live(world).length >= 5) return null;
    return [join(world).id];
  },

  close(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : pick(rnd, live(world));
    if (!tab || (!args && live(world).length < 2)) return null;
    close(world, tab);
    return [tab.id];
  },

  leave(world, rnd, args) {
    const busy = live(world).filter((tab) => tab.io || world.answers.some((answered) => answered.tab === tab));
    const tab = args ? byId(world, args[0]) : pick(rnd, busy);
    if (!tab || (!args && live(world).length < 2)) return null;
    close(world, tab);
    return [tab.id];
  },

  "end-room"(world, rnd, args) {
    const tabs = live(world);
    if (tabs.length !== 1) return null;
    const save = args ? args[0] === "save" : rnd() < 0.5;
    endRoom(world, tabs[0], save);
    return [save ? "save" : "no-save"];
  },

  "room-loss"(world) {
    return roomLoss(world) ? [] : null;
  },

  strand(world, rnd) {
    const holders = live(world).filter((tab) => inFlight(world, tab).length);
    if (!holders.length) return null;
    const stays = rnd() < 0.25 ? pick(rnd, holders) : null;
    for (const tab of holders) if (tab !== stays && tab.connected) setConnected(world, tab, false);
    roomLoss(world);
    return [holders.map((tab) => tab.id).join("+"), stays ? stays.id : "none"];
  },

  cross(world, rnd) {
    const frame = pick(rnd, live(world).flatMap((tab) => stranded(world, tab)));
    if (!frame) return null;
    const tab = pick(rnd, live(world).filter((one) => !stranded(world, one).some((held) => held.e === frame.e)));
    const action = refAction(frame.action);
    const [row, col] = action.t === "del" ? [action.row, pick(rnd, COLS)] : pick(rnd, cellsOf(action)) ?? [];
    if (!tab || !row || !view(tab).rows[row]) return null;
    const value = `v${++world.values}`;
    userEdit(world, tab, { t: "set", row, col, value });
    if (!tab.connected && rnd() < 0.8) setConnected(world, tab, true);
    const calm = tab.connected && rnd() < 0.8 && lull(world);
    return [tab.id, row, col, value, calm ? "saved" : "sent"];
  },

  "come-back"(world, rnd) {
    const tab = pick(rnd, live(world).filter((one) => !one.connected && stranded(world, one).length));
    if (!tab) return null;
    setConnected(world, tab, true);
    return [tab.id];
  },

  restore(world, rnd, args) {
    const at = args ? args[0] : Math.floor(rnd() * world.host.versions.length);
    return restore(world, at) ? [at] : null;
  },

  "restore-copy"(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : pick(rnd, live(world));
    const copy = args ? { id: args[1] } : pick(rnd, rnd() < 0.6 ? world.host.recoveries.slice(-2) : world.host.recoveries);
    return tab && copy && restoreFromCopy(world, tab, copy.id) ? [tab.id, copy.id] : null;
  },

  decide(world, rnd, args) {
    const open = (tab) => tab.notices.filter((notice) => notice.kind === "restored" && notice.conflicts.length);
    const tab = args ? byId(world, args[0]) : pick(rnd, live(world).filter((one) => !one.job && open(one).length));
    if (!tab) return null;
    const notice = args ? open(tab).find((one) => one.job === args[1]) : rnd() < 0.7 ? open(tab).at(-1) : pick(rnd, open(tab));
    if (!notice) return null;
    const sure = Math.floor(rnd() * notice.conflicts.length);
    const picks = args ? args[2] : notice.conflicts.filter((_, at) => at === sure || rnd() < 0.5).map(({ e }) => [e, rnd() < 0.5 ? "take" : "keep"]);
    return decideConflicts(world, tab, notice.job, picks) ? [tab.id, notice.job, picks] : null;
  },

  title(world) {
    return retitle(world, "step") ? [] : null;
  },

  "title-raw"(world) {
    return retitle(world, "raw") ? [] : null;
  },

  rotate(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : writer(world);
    return rotate(world, tab) ? [tab.id] : null;
  },

  renew(world, rnd, args) {
    const tab = args ? byId(world, args[0]) : pick(rnd, live(world).filter((one) => one.connected && attached(world, one) && !one.io));
    return rotate(world, tab) ? [tab.id] : null;
  },

  solo(world, rnd, args) {
    const stays = args ? byId(world, args[0]) : pick(rnd, live(world));
    if (!stays) return null;
    for (const tab of live(world)) setConnected(world, tab, tab === stays);
    return [stays.id];
  },
};

const V1 = [
  ["value", 30],
  ["insert", 6],
  ["remove", 4],
  ["out", 40],
  ["into", 48],
  ["connection", 8],
  ["checkpoint", 12],
  ["answer", 12],
  ["join", 4],
  ["close", 4],
  ["end-room", 4],
  ["room-loss", 3],
  ["restore", 2],
  ["rotate", 1],
];

const CORE = ["value", "out", "into", "checkpoint", "host", "deliver", "step", "post", "land"];

const V3 = [
  ["value", 26],
  ["text", 3],
  ["clear", 2],
  ["insert", 5],
  ["remove", 3],
  ["paste", 5],
  ["out", 40],
  ["into", 48],
  ["connection", 6],
  ["checkpoint", 12],
  ["host", 12],
  ["deliver", 14],
  ["step", 12],
  ["answer", 3],
  ["join", 3],
  ["close", 3],
  ["leave", 4],
  ["end-room", 2],
  ["room-loss", 2],
  ["restore", 1],
  ["rotate", 1],
  ["renew", 2],
  ["expire", 2],
  ["outside", 1],
  ["lull", 2],
];

const EDITS = ["value", "text", "clear", "insert", "remove", "paste"];
const UPSETS = ["connection", "join", "close", "end-room", "room-loss", "restore", "outside", "expire"];
const calmFactor = (name) => (EDITS.includes(name) ? 0.05 : UPSETS.includes(name) ? 0.15 : 1);

const HELD = { "room-loss": 2, connection: 2.5, join: 2, close: 1.5, checkpoint: 0.4, host: 0.6, deliver: 0.7, restore: 0.4, outside: 0.4, expire: 0.4 };

const BACK = { close: 0.3, leave: 0.3, "end-room": 0.3, restore: 3, outside: 0.5 };

export const PROFILES = {
  v1: V1,
  v2: [...V1, ["paste", 5]],
  v3: V3,
  v4: V3.map(([name, weight]) => [name, weight * (HELD[name] ?? 1)]),
  v5: [...V3.map(([name, weight]) => [name, weight * (HELD[name] ?? 1)]), ["restore-copy", 4]],
  v6: [...V3.map(([name, weight]) => [name, weight * (HELD[name] ?? 1)]), ["restore-copy", 20]],
  v7: [...V3, ["restore-copy", 20], ["decide", 30]],
  v8: [...V3, ["restore-copy", 24], ["decide", 30], ["strand", 50], ["cross", 80], ["come-back", 3]].map(([name, weight]) => [name, weight * (BACK[name] ?? 1)]),
  v9: [...V3.map(([name, weight]) => [name === "out" ? "post" : name, name === "paste" ? weight * 2 : weight]), ["restore-copy", 24], ["decide", 30], ["strand", 50], ["cross", 80], ["come-back", 3], ["land", 36], ["land-lost", 4], ["drop", 3], ["echo", 3], ["wait-out", 5]].map(([name, weight]) => [name, weight * (BACK[name] ?? 1)]),
};

PROFILES.v10 = [...PROFILES.v9, ["title", 6], ["title-raw", 6]];

export const PROFILE = "v3";

const TRAITS = ["v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10"];
const WIDE = ["v5", "v6", "v7", "v8", "v9", "v10"];

export function traitsOf(seed, profile = PROFILE) {
  const weights = PROFILES[profile];
  if (!weights) throw new Error(`unknown profile ${profile}`);
  if (!TRAITS.includes(profile)) return { weights, world: {} };
  const held = profile !== "v3";
  const rnd = rng((seed ^ 0x7a17c3) >>> 0);
  const split = rnd() < 0.5;
  const retain = rnd() < 0.5;
  const outside = rnd() < 0.5 ? "open" : "drop";
  const ledgerCap = (held ? [160, 120, 120] : [undefined, undefined, undefined, 160, 120])[Math.floor(rnd() * (held ? 3 : 5))];
  const calm = rnd() < 0.25 && !held;
  const lane = () => [null, 0, 1, 2][Math.floor(rnd() * 4)];
  const slow = { up: lane(), down: lane() };
  const scaled = weights.map(([name, weight]) => {
    const factor = pick(rnd, CORE.includes(name) ? [0.4, 1, 1, 2.5] : held ? [0.5, 1, 1, 2] : [0, 0.3, 1, 1, 1, 3, 6]);
    return [name, name === "step" && !split ? 0 : weight * factor * (calm ? calmFactor(name) : 1)];
  });
  const faults = held && rnd() < 0.3 ? [pick(rnd, ["drop", "blank"])] : null;
  const wide = WIDE.includes(profile) && rnd() < 0.6 ? { rate: pick(rnd, [0.1, 0.3, 0.6, 1]), run: pick(rnd, [1, 3, 8]) } : null;
  return { weights: scaled, world: { split, retain, outside, ledgerCap, slow, calm, ...(profile === "v10" ? { hostMade: true } : {}) }, faults, wide };
}

function nextMove(rnd, without, weights) {
  const table = without.length ? weights.filter(([name]) => !without.includes(name)) : weights;
  let x = rnd() * table.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [name, weight] of table) {
    x -= weight;
    if (x < 0) return name;
  }
  return table.at(-1)[0];
}

function fail(world, error, move) {
  error.world = world;
  error.moves = world.moves;
  if (move !== undefined) error.move = move;
  return error;
}

export function start(options = {}) {
  const traits = traitsOf(options.seed ?? 1, options.profile);
  const world = newWorld({ ...traits.world, ...options });
  world.rnd = rng((options.seed ?? 1) ^ 0x51ed);
  world.traits = traits.world;
  const wide = options.faults ?? traits.wide;
  if (wide) world.host.faults = faultPlan(rng(((options.seed ?? 1) ^ 0xfa017) >>> 0), wide.rate, wide.run);
  else if (traits.faults) world.host.faults = [...traits.faults];
  const { split } = world;
  world.split = false;
  join(world);
  join(world);
  while (world.inflight.length) answer(world, "ok");
  world.split = split;
  return world;
}

function play(world, next, options) {
  for (let i = 0; ; i++) {
    const move = next(i);
    if (!move) break;
    const [name, sub] = move;
    world.step = i;
    world.rnd = rng(sub);
    try {
      if (!live(world).length) join(world);
      const args = MOVES[name](world, world.rnd);
      if (args) world.effective++;
      world.moves.push([name, sub]);
      world.shown.push(args ? [name, ...args] : [name, "(nothing to do)"]);
      if (args) world.note("move", i, name, ...args);
      checkStep(world);
      options.afterMove?.(world, i);
    } catch (error) {
      if (world.moves.length === i) world.moves.push([name, sub]);
      throw fail(world, error, i);
    }
  }
  world.rnd = rng((options.end ?? options.seed ?? 1) ^ 0x9e37);
  try {
    return quiesce(world);
  } catch (error) {
    throw fail(world, error);
  }
}

export function run(seed, steps, options = {}) {
  const rnd = rng(seed);
  const world = start({ ...options, seed });
  const without = options.without ?? [];
  const weights = traitsOf(seed, options.profile).weights.filter(([, weight]) => weight > 0);
  const more = ["v3", "v4", "v9", "v10"].includes(options.profile ?? PROFILE) ? (i) => world.effective < steps && i < steps * 4 : (i) => i < steps;
  return play(world, (i) => (more(i) ? [nextMove(rnd, without, weights), Math.floor(rnd() * 4294967296)] : null), { ...options, seed });
}

export function runMoves(moves, options = {}) {
  return play(start(options), (i) => moves[i] ?? null, options);
}

export const TAILS = {
  ret: [["come-back", 8], ["cross", 10], ["strand", 6], ["lull", 6], ["decide", 8], ["restore-copy", 10], ["room-loss", 4], ["connection", 5], ["value", 14], ["insert", 3], ["remove", 4], ["paste", 3], ["clear", 2], ["out", 30], ["into", 36], ["checkpoint", 10], ["host", 8], ["deliver", 8], ["step", 4], ["join", 2], ["close", 1], ["end-room", 1], ["restore", 2], ["rotate", 2]],
  wait: [["connection", 6], ["room-loss", 7], ["rotate", 3], ["renew", 1], ["restore-copy", 14], ["lull", 5], ["value", 10], ["insert", 3], ["remove", 2], ["paste", 2], ["clear", 1], ["out", 30], ["into", 36], ["checkpoint", 10], ["host", 8], ["deliver", 8], ["step", 6], ["join", 1], ["close", 1], ["end-room", 1], ["restore", 1], ["decide", 8], ["strand", 3], ["come-back", 4]],
};

const sub = (rnd) => Math.floor(rnd() * 4294967296);

export const rowOptions = (row) => ({ mode: row.mode, profile: row.profile, seed: row.seed, limits: row.limits, faults: row.faults, removals: row.removals });

export function tailSession(seed, row, steps, tail, keep = row.moves.length) {
  const rnd = rng(seed);
  const moves = row.moves.slice(0, keep);
  if (tail === "wait") moves.push(["solo", sub(rnd)], ["lull", sub(rnd)]);
  for (let i = 0; i < steps; i++) moves.push([nextMove(rnd, [], TAILS[tail]), sub(rnd)]);
  return { row, keep, moves, options: { ...rowOptions(row), end: seed } };
}
