import { planted } from "../core/planted.mjs";
import { W, trimLedger } from "../core/ledger.mjs";
import { act } from "../core/codec.mjs";
import { codecAction, refDoc } from "./lens.mjs";
import { newHost, get, put, write, keepVersion, verdict, marked, keepDecision, fetchDecision, keepRecovery, fetchRecovery, readRecovery, keepRemovals } from "./host.mjs";
import { newRoom, newInstance, dropConnection, rejoin, admit } from "../core/room.mjs";
import { labLimits } from "../core/limits.mjs";
import { serialize, parse, DOC } from "../core/record.mjs";
import { newTab, attached, view as codecView, edit, restoreCopy, decide, flush, toRoom, post, answered, waited, toTab, receive, sync, read, link, nudgeAll, capture, deliver, rotate, retry, nextCommit, nextGen, storeRemovals } from "../core/tab.mjs";
import { establishing, openOn, fileAccepted, sameTables } from "../core/host.mjs";
import { newOracle, checkStep, checkEnd } from "./oracle.mjs";
import { tinyWorkbook } from "./lib.mjs";

export const view = (tab) => refDoc(codecView(tab));

export { attached, toRoom, post, waited, toTab, receive, sync, read, link, capture, deliver, rotate, flush, checkStep };

export function newWorld(options = {}) {
  const world = {
    host: newHost(options.workbook ?? tinyWorkbook()),
    room: null,
    tabs: [],
    ids: 0,
    nonce: 0,
    commits: 0,
    copies: 0,
    values: 0,
    rows: 0,
    inflight: [],
    wire: [],
    answers: [],
    instances: 0,
    split: Boolean(options.split),
    retain: Boolean(options.retain),
    outside: options.outside ?? "open",
    slow: options.slow ?? null,
    mode: options.mode === "scrambled" ? "scrambled" : "ordered",
    limits: labLimits({ ledgerCap: options.ledgerCap, ...options.limits }),
    rnd: Math.random,
    accepted: 0,
    returned: { judged: 0, kept: 0, open: 0, counted: 0, carried: 0 },
    removals: Boolean(options.removals),
    hostMade: Boolean(options.hostMade),
    titles: 0,
    lulls: { all: 0, away: 0, owing: 0 },
    refused: 0,
    losses: 0,
    expired: 0,
    patches: 0,
    restores: 0,
    moves: [],
    effective: 0,
    shown: [],
    note: options.note ?? (() => {}),
  };
  world.oracle = newOracle(world);
  world.observer = world.oracle;
  world.port = hostPort(world);
  return world;
}

function hostPort(world) {
  return {
    read: () => get(world.host),
    etag: () => world.host.etag,
    verdict: (e) => verdict(world.host, e),
    marked: (e, kind) => marked(world.host, e, kind),
    decisions: () => world.host.decisions,
    keepDecision: (mark) => keepDecision(world.host, mark),
    fetchDecision: (mark) => fetchDecision(world.host, mark),
    keepRecovery: (copy) => keepRecovery(world.host, copy),
    fetchRecovery: (id) => fetchRecovery(world.host, id),
    readRecovery: (id) => readRecovery(world.host, id),
    removals: () => world.host.removals,
    keepRemovals: (entries) => keepRemovals(world.host, entries),
    send: (tab, io) => world.inflight.push({ tab, io }),
    post: (tab, frame) => world.wire.push({ tab, frame }),
    takeAnswer: (at) => world.answers.splice(at, 1)[0],
    room: () => world.room,
    setRoom: (room) => {
      world.room = room;
    },
    onFull: (who) => {
      const tab = world.tabs.find((one) => one.id === who);
      if (tab.alive && attached(world, tab)) tab.throttled = true;
    },
    onSpace: () => {
      for (const tab of live(world)) retry(world, tab);
    },
    scrambled: () => world.mode === "scrambled",
    pick: (count) => Math.floor(world.rnd() * count),
    tabs: () => world.tabs,
    next: (counter) => ++world[counter],
  };
}

export function hostTake(world, at = 0, lost = false) {
  const [sent] = world.inflight.splice(at, 1);
  if (!sent) return false;
  let status = 0;
  let built = null;
  const before = get(world.host);
  if (sent.io.ask && (sent.io.etag === world.host.etag || sent.io.etag === "*")) {
    if (!world.room) world.room = newInstance(world);
    built = establishing(world, get(world.host));
  }
  if (built && planted("host-opens-before-write")) openOn(world, built.record, world.host.etag, built.state);
  if (!lost) {
    const body = built ? built.body : typeof sent.io.body === "function" ? sent.io.body() : sent.io.body;
    status = body === undefined ? 412 : put(world.host, body, sent.io.etag, sent.io.kind).status;
    if (status === 200) {
      world.accepted++;
      world.oracle.onAccept(world, body, sent.io.kind);
      storeRemovals(world, sent.tab, sent.io.removals ?? []);
      if (world.hostMade) fileAccepted(world, get(world.host), before);
    }
  }
  world.answers.push({ ...sent, status });
  return true;
}

export function answer(world, how = "ok", at = 0) {
  if (how === "refuse") {
    const [sent] = world.inflight.splice(at, 1);
    if (!sent) return false;
    if (sent.tab.io === sent.io) sent.tab.io = null;
    world.refused++;
    return true;
  }
  if (!hostTake(world, at, how === "drop-lost")) return false;
  return deliver(world, world.answers.length - 1, how !== "ok");
}

export const live = (world) => world.tabs.filter((tab) => tab.alive);

export const writer = (world) =>
  live(world).find((tab) => tab.connected && attached(world, tab)) ?? live(world).find((tab) => tab.connected) ?? null;

export function join(world) {
  const tab = newTab(`t${++world.ids}`);
  world.tabs.push(tab);
  sync(world, tab);
  return tab;
}

export function userEdit(world, tab, action) {
  const raw = codecView(tab);
  const shown = refDoc(raw);
  const prior = world.oracle.priorOf(shown, action, tab);
  const seen = world.oracle.seenOf(shown, action);
  const id = edit(world, tab, codecAction(action), raw);
  if (id) world.oracle.onEdit(world, tab, id, action, prior, seen);
  return id;
}

function leave(world, tab) {
  const room = world.room;
  if (!room || tab.room !== room) return;
  const before = room.bytes.staged + room.bytes.waiting;
  dropConnection(room, tab.id);
  if (room.bytes.staged + room.bytes.waiting < before) for (const other of live(world)) retry(world, other);
}

export function land(world, at = 0, lost = false) {
  const [sent] = world.wire.splice(at, 1);
  if (!sent) return false;
  const result = world.room ? admit(world, world.room, sent.frame, sent.tab.id) : "closed";
  if (!lost) answered(world, sent.tab, sent.frame, result);
  return true;
}

export function dropWire(world, at = 0) {
  return world.wire.splice(at, 1).length > 0;
}

export function echo(world, at = 0) {
  const sent = world.wire[at];
  if (!sent) return false;
  world.wire.push({ ...sent });
  return true;
}

const unanswered = (world, tab) => tab.flight.size > 0 && !world.wire.some((sent) => sent.tab === tab);

export function setConnected(world, tab, on) {
  tab.connected = on;
  if (on) rejoin(world.room, tab.id);
  if (on) sync(world, tab);
  else leave(world, tab);
}

export function restoreFromCopy(world, tab, copyId) {
  return restoreCopy(world, tab, copyId);
}

export function decideConflicts(world, tab, jobId, picks) {
  return decide(world, tab, jobId, picks);
}

export function close(world, tab) {
  tab.alive = false;
  tab.connected = false;
  leave(world, tab);
}

export function roomLoss(world) {
  const room = world.room;
  if (!room) return false;
  if (room.gen) world.oracle.onRoomLoss(world, room, "lost");
  world.room = null;
  world.losses++;
  nudgeAll(world);
  return true;
}

export function expire(world) {
  const room = world.room;
  if (!room || live(world).some((tab) => tab.connected)) return false;
  const dirty = Boolean(room.gen) && (room.seq > room.base.through || get(world.host).record.through < room.seq || get(world.host).record.gen !== room.gen);
  if (dirty && !planted("expire-dirty-room")) return false;
  if (room.gen) world.oracle.onRoomLoss(world, room, "expired");
  world.room = null;
  world.expired++;
  return true;
}

export function step(world, tab) {
  if (!tab.alive || !tab.connected) return false;
  if (tab.wake) return read(world, tab);
  return link(world, tab);
}

export const linking = (tab) => tab.alive && tab.connected && (tab.wake || Boolean(tab.fetched));

function finalSave(world) {
  const room = world.room;
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = get(world.host);
    if (file.record.gen !== room.gen || file.record.through >= room.seq) return;
    const record = { v: 2, doc: DOC, gen: room.gen, epoch: room.epoch, commit: nextCommit(world), parent: file.record.commit, through: room.seq, room: room.id };
    const body = serialize(record, room.state);
    if (put(world.host, body, file.etag, "final").status !== 200) continue;
    const before = file;
    world.accepted++;
    world.oracle.onAccept(world, body, "final");
    if (world.hostMade && !planted("host-own-save-not-told")) fileAccepted(world, get(world.host), before);
    if (!planted("record-not-sent-with-the-final-save")) storeRemovals(world, { id: `the room of ${room.gen}` }, room.removals.filter(({ at }) => at[1] > file.record.through));
    return;
  }
}

export function endRoom(world, tab, save) {
  close(world, tab);
  if (!world.room?.gen) return;
  if (save) finalSave(world);
  if (world.retain) return;
  world.oracle.onRoomLoss(world, world.room, "ended");
  world.room = null;
}

export const restore = (world, at) => outsideWrite(world, "restore", at, null);

export function retitle(world, how) {
  const room = world.room?.gen ? world.room : null;
  const gen = get(world.host).record.gen;
  world.host.title = `t${++world.titles}`;
  if (how === "step") outsideWrite(world, "fanout", "live", null);
  else rawWrite(world, world.host.body, "raw");
  world.oracle.onOtherBytes(world, room, gen);
  return true;
}

export function rawWrite(world, body, kind) {
  const before = get(world.host);
  write(world.host, body, kind);
  if (world.hostMade) fileAccepted(world, get(world.host), before);
  nudgeAll(world);
  return true;
}

export function outsideWrite(world, kind, at, action) {
  const version = at === "live" ? world.host : world.host.versions[at];
  if (!version) return false;
  const room = world.room?.gen ? world.room : null;
  const current = get(world.host);
  const source = parse(version.body);
  const patch = action && { id: `x${++world.patches}`, action };
  if (patch && planted("outside-no-reset")) {
    act(current.state.wb, codecAction(action));
    write(world.host, serialize({ ...current.record, commit: nextCommit(world), parent: current.record.commit }, current.state), kind);
    return true;
  }
  if (patch) act(source.state.wb, codecAction(action));
  if (world.hostMade && !planted("host-equal-tables-new-gen") && sameTables(source, current)) return rawWrite(world, world.host.body, kind);
  const cut = room ? [room.gen, room.seq] : [current.record.gen, current.record.through];
  const dirty = Boolean(room) && (room.gen !== current.record.gen || room.seq > current.record.through);
  let backup = null;
  if (dirty && !planted("restore-no-backup")) {
    const record = { v: 2, doc: DOC, gen: room.gen, epoch: room.epoch, commit: nextCommit(world), parent: room.base.commit, through: room.seq, room: room.id };
    backup = serialize(record, room.state);
    keepVersion(world.host, backup, "backup");
    world.oracle.onBackup(world, record.commit, room);
  }
  const epoch = current.record.epoch + 1;
  const before = planted("restore-replays-admitted") ? {} : (room ?? current).state.seen;
  const merged = [];
  const range = {};
  for (const client of new Set([...Object.keys(source.state.seen), ...Object.keys(before)])) {
    const [low, lowAt] = source.state.seen[client] ?? [0, -1];
    const [high, highAt] = before[client] ?? [0, -1];
    merged.push([client, [Math.max(low, high), Math.max(lowAt, highAt)]]);
    range[client] = [low, high];
  }
  const folded = trimLedger(merged, Math.max(source.state.floor, (room ?? current).state.floor), world.limits.ledgerCap);
  const seen = {};
  const bounds = {};
  for (const [client, [n]] of folded.kept) {
    seen[client] = [n, epoch];
    if (range[client][1] > range[client][0]) bounds[client] = range[client];
  }
  const kept = planted("restore-keeps-lineage");
  const state = {
    wb: source.state.wb,
    seen,
    lineage: kept ? [[current.record.gen, current.record.through], ...current.state.lineage].slice(0, W) : [],
    cut: kept ? null : [...cut, bounds],
    floor: folded.floor,
  };
  const keep = world.outside === "open";
  if (keep && !world.room) world.room = newInstance(world);
  const record = { v: 2, doc: DOC, gen: nextGen(world, epoch), epoch, commit: nextCommit(world), parent: current.record.commit, through: 0, room: keep ? world.room.id : null, restored: source.record.commit };
  const body = serialize(record, state);
  world.oracle.onRestore(world, body, { source: source.record.commit, room, dirty, backup: Boolean(backup), patch });
  const etag = write(world.host, body, kind);
  world.restores++;
  world.room = keep ? newRoom(record, etag, state, world.room.id) : null;
  if (keep) world.oracle.onRoom(world, world.room);
  nudgeAll(world);
  return true;
}

const MAX_DRAIN = 200000;

export function drain(world) {
  for (let steps = 0; ; steps++) {
    if (steps > MAX_DRAIN) throw new Error(`I8 stuck: frames still moving after ${MAX_DRAIN} deliveries`);
    let moved = false;
    if (world.mode === "scrambled") {
      const ready = world.wire.map((_, at) => () => land(world, at));
      for (const tab of live(world)) {
        if (unanswered(world, tab)) ready.push(() => waited(world, tab));
        if (!tab.connected || !world.room) continue;
        if (tab.out.length) ready.push(() => toRoom(world, tab));
        if (attached(world, tab) && lagging(world, tab)) ready.push(() => toTab(world, tab));
      }
      while (ready.length && !moved) moved = ready.splice(Math.floor(world.rnd() * ready.length), 1)[0]();
      if (!moved) return;
      continue;
    }
    while (land(world)) moved = true;
    for (const tab of live(world)) if (unanswered(world, tab) && waited(world, tab)) moved = true;
    for (const tab of live(world)) while (toRoom(world, tab)) moved = true;
    for (const tab of live(world)) while (toTab(world, tab)) moved = true;
    if (!moved) return;
  }
}

export const lagging = (world, tab) => tab.cursor < world.room.log.length;

const behind = (world, tab) => world.removals && tab.recordSeen !== world.host.removals.length;

const idle = (world, tab) =>
  attached(world, tab) &&
  !tab.pending.length &&
  !tab.held.length &&
  !tab.out.length &&
  !tab.flight.size &&
  !tab.io &&
  !tab.wake &&
  !tab.fetched &&
  !tab.unknown &&
  !tab.limbo.length &&
  !tab.unstored.length &&
  !tab.marks.length &&
  !behind(world, tab) &&
  tab.cursor === world.room.log.length &&
  tab.a === world.room.seq &&
  tab.base.through === world.room.seq;

export function quiet(world, everyone = true) {
  const room = world.room;
  if (!room?.gen || world.inflight.length || world.answers.length || world.wire.length) return false;
  const file = get(world.host);
  if (file.record.gen !== room.gen || file.record.through !== room.seq || room.base.through !== room.seq) return false;
  return live(world).every((tab) => (!everyone && !tab.connected) || (idle(world, tab) && !tab.job));
}

const SETTLE_ROUNDS = 80;

const durable = (world) => world.accepted + world.host.recoveries.length + world.host.decisions.length + world.host.removals.length;

export function settle(world, everyone = true) {
  if (everyone && !live(world).length) join(world);
  if (!everyone && !live(world).some((tab) => tab.connected)) return world;
  let stored = durable(world);
  for (let round = 0, since = 0; since < SETTLE_ROUNDS && round < SETTLE_ROUNDS * 40; round++, since++) {
    if (durable(world) !== stored) since = 0;
    stored = durable(world);
    if (everyone) for (const tab of live(world)) if (!tab.connected) setConnected(world, tab, true);
    while (world.inflight.length || world.answers.length) world.inflight.length ? hostTake(world) : deliver(world);
    for (const tab of live(world)) if (tab.connected && !linking(tab) && (!attached(world, tab) || tab.unknown || tab.unstored.length || tab.marks.length || behind(world, tab) || (idle(world, tab) && !planted("no-idle-check")))) sync(world, tab);
    for (let turns = 0; turns < 8 && live(world).some(linking); turns++) for (const tab of live(world)) if (linking(tab)) step(world, tab);
    for (const tab of live(world)) if (tab.job && tab.connected) flush(world, tab);
    drain(world);
    capture(world, writer(world));
    if (quiet(world, everyone)) return world;
  }
  throw new Error(`I8 stuck: the ${everyone ? "session" : "connected tabs"} did not settle`);
}

function joinNow(world) {
  const tab = join(world);
  for (let turns = 0; turns < 8 && linking(tab); turns++) step(world, tab);
  return tab;
}

const owes = (tab) => tab.held.length > 0 || tab.pending.length > 0 || tab.marks.length > 0 || Boolean(tab.job) || tab.unstored.length > 0 || tab.limbo.length > 0;

export function lull(world) {
  if (!live(world).some((tab) => tab.connected)) return false;
  settle(world, false);
  const away = live(world).filter((tab) => !tab.connected);
  world.lulls.all++;
  if (away.length) world.lulls.away++;
  if (away.some(owes)) world.lulls.owing++;
  return true;
}

export function quiesce(world) {
  settle(world);
  checkEnd(world, joinNow);
  return world;
}
