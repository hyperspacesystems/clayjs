// The ordered room client over the live-room core (src/live-room/core, generated from the lab).
// The core's tab expects a synchronous port; this client is the event loop around it. Before each
// step it reads the file and the room from the host, so the core's `read()` and `room()` answer
// what the host held just before the call, which is the lab's read at that instant. Sends go out
// as requests, and their answers come back through the core's own entry points (`deliver`,
// `answered`, `toTab`, `waited`). The transport is injected: `fetch` and `subscribe`.
import { newTab, edit as addEdit, flush as flushTab, post, answered, waited, toTab, sync, link, capture, deliver, view, attached, retry } from "./core/tab.js";
import { view as fileView, edit as fileEdit, save as fileSave, deliver as fileDeliver, refresh as fileRefresh, push as filePush } from "./core/fileonly.js";
import { parse, parsePage } from "./core/record.js";
import { useCodec } from "./core/codec.js";
import { REAL_LIMITS } from "./core/limits.js";

const silent = new Proxy({}, { get: () => () => {} });
const SETTLED = new Set(["saved", "dropped", "recovered", "kept-refused"]);
const ADMITTED = new Set(["shared", "saved"]);
const LOOP_CAP = 100_000;

// Recovery copies stay in this tab's memory until step C9 stores them on the host: an edit the
// protocol moves to a copy is kept and listed (status.copies), never dropped, but a reload loses it.
function readCopy(body) {
  if (!body || !body.includes("</script>")) return null;
  const { record, wb } = parsePage(body);
  return { ...record, preview: wb };
}

/**
 * @param {{ page: string, codec: object, clientId: string, fetch: typeof fetch,
 *   subscribe: (page: string, clientId: string, listener: (event: object) => void) => () => void,
 *   limits?: object, idleMs?: number, maxMs?: number, waitMs?: number, firstId?: number }} options
 */
export function createRoomClient({ page, codec, clientId, fetch, subscribe, limits = REAL_LIMITS, idleMs = 2000, maxMs = 8000, waitMs = 10000, firstId = Math.floor(Math.random() * 2 ** 40) }) {
  const tab = newTab(clientId);
  const copies = new Map();
  const timers = new Set();
  let lastEstablish = -Infinity;
  let held = null;
  let flushing = false;
  const whenSaved = [];
  const answers = [];
  const handles = new Map();
  const listeners = new Set();
  const counters = {};
  const query = `page=${encodeURIComponent(page)}`;
  let file = null;
  let mirror = null;
  let chain = Promise.resolve();
  let batch = null;
  let idleTimer = null;
  let maxTimer = null;
  let waitTimer = null;
  let closed = false;
  let failure = null;
  let unsubscribe = () => {};

  const port = {
    read: () => file,
    room: () => mirror,
    setRoom: (room) => {
      mirror = room;
    },
    next: (counter) => (counters[counter] = (counters[counter] ?? firstId) + 1),
    tabs: () => [tab],
    verdict: () => null,
    marked: () => false,
    keepDecision: () => {},
    fetchDecision: () => false,
    keepRecovery: ({ id, body }) => copies.set(id, body),
    fetchRecovery: (id) => copies.get(id) ?? null,
    readRecovery: (id) => readCopy(copies.get(id)),
    removals: () => [],
    keepRemovals: () => {},
    send: (_, io) => send(io),
    post: (_, frame) => queue(frame),
    takeAnswer: (at) => answers.splice(at, 1)[0],
    scrambled: () => false,
    pick: () => 0,
    onFull: () => {},
    onSpace: () => {},
  };
  const env = { hostMade: true, removals: false, split: false, limits, observer: silent, port };

  function pump(work) {
    chain = chain
      .then(() => (closed ? undefined : (useCodec(codec), work())))
      .catch((error) => {
        failure = error;
        emit({ type: "error", error });
      });
    return chain;
  }

  // The file first, then the room: a room read after the file is never older than it, and a room
  // newer than the file (a save landed between the reads) makes the core ask for the file again.
  async function refresh() {
    const got = await fetch(`/_/file?${query}`);
    if (!got.ok) throw new Error(`the host did not answer the file read (${got.status})`);
    file = { etag: got.headers.get("etag"), ...parse(await got.text()) };
    const joined = await fetch(`/_/sync/room?${query}&client-id=${encodeURIComponent(clientId)}`);
    if (!joined.ok) throw new Error(`the host did not answer the room read (${joined.status})`);
    const room = await joined.json();
    if (!mirror || mirror.id !== room.id || mirror.gen !== room.gen) mirror = { id: room.id, gen: room.gen, base: room.base, log: [], floor: room.floor };
    else {
      if (room.base) mirror.base = room.base;
      mirror.floor = room.floor;
    }
    room.tail.forEach((frame, i) => {
      mirror.log[room.floor + i] ??= frame;
    });
  }

  // Everything the tab can do now, after the outside event that woke it.
  function drive() {
    if (closed) return;
    // An establish held back for want of an edit is moot once another tab opened a room: answer it
    // as refused, so the core reads the room and attaches.
    if (held && mirror?.gen) {
      const io = held;
      held = null;
      answers.push({ tab, io, status: 412 });
      deliver(env, answers.length - 1, false);
    }
    if (!attached(env, tab) || tab.fetched || tab.wake) sync(env, tab);
    for (let tries = 0; tab.fetched && tries < 8; tries++) link(env, tab);
    let turns = 0;
    while (toTab(env, tab)) if (++turns > LOOP_CAP) throw new Error("the room client stopped: the room log did not advance");
    flushTab(env, tab);
    while (post(env, tab)) if (++turns > 2 * LOOP_CAP) throw new Error("the room client stopped: frames did not drain");
    report();
    plan();
  }

  // A file older than the room leaves the tab asking for the file again: read again a few times,
  // then wait, so the tab never stays unattached until some later event.
  async function settle() {
    for (let round = 0; ; round++) {
      drive();
      if (closed || !tab.fetched) return;
      if (round === 2) return armWait();
      await refresh();
    }
  }

  const step = () =>
    pump(async () => {
      await refresh();
      await settle();
    });

  // At most one establish per waitMs: a refused establish leads straight to another inside
  // `deliver`, and without the pause a host that cannot hold the room would get thousands a second.
  // A room starts with the first edit, not the first open (plan 09 section 2.3): a tab with no
  // unsettled edit holds its establish until it has one, so a person who only looks changes nothing.
  const editing = () => [...tab.edits.values()].some((one) => !SETTLED.has(one.state));
  function send(io) {
    const establish = Boolean(io.ask);
    if (establish && !editing()) {
      held = io;
      return;
    }
    const path = establish ? `/_/sync/room?${query}&op=establish` : `/_/save?${query}`;
    const go = () => {
      timers.delete(timer);
      if (closed) return;
      const body = establish ? undefined : typeof io.body === "function" ? io.body() : io.body;
      fetch(path, { method: "POST", headers: { "if-match": io.etag }, body }).then(
        (answer) => land(io, answer.status, false),
        () => land(io, 0, true),
      );
    };
    const pause = establish ? Math.max(0, lastEstablish + waitMs - Date.now()) : 0;
    if (establish) lastEstablish = Date.now() + pause;
    const timer = pause ? setTimeout(go, pause) : null;
    if (timer) timers.add(timer);
    else go();
  }

  function land(io, status, lost) {
    pump(async () => {
      await refresh();
      answers.push({ tab, io, status });
      deliver(env, answers.length - 1, lost);
      await settle();
    });
  }

  function queue(frame) {
    if (batch) return batch.push(frame);
    batch = [frame];
    queueMicrotask(() => {
      const frames = batch;
      batch = null;
      if (closed) return;
      fetch(`/_/sync/room?${query}&client-id=${encodeURIComponent(clientId)}`, { method: "POST", body: JSON.stringify({ frames }) })
        .then((answer) => (answer.ok ? answer.json() : Promise.reject(new Error(`frames answered ${answer.status}`))))
        .then(
          ({ answers: results }) =>
            pump(async () => {
              await refresh();
              frames.forEach((one, i) => answered(env, tab, one, results[i]));
              // Every frame refused for an old room, or for a room that forgot this tab (its stream
              // ended while the frames were on the way): read the room again after a pause, which
              // joins again and sends what is unanswered, instead of sending at once and flooding.
              if (attached(env, tab) && results.every((result) => result === "stale" || result === "closed")) {
                report();
                clearTimeout(waitTimer);
                if (!closed) waitTimer = setTimeout(step, waitMs);
              } else await settle();
            }),
          () => armWait(),
        );
    });
  }

  function armWait() {
    if (closed) return;
    clearTimeout(waitTimer);
    waitTimer = setTimeout(
      () =>
        pump(async () => {
          await refresh();
          waited(env, tab);
          await settle();
        }),
      waitMs,
    );
  }

  function hear(event) {
    pump(async () => {
      if (event.type === "room" && event.frame.to !== undefined) {
        if (event.frame.k === "full") tab.throttled = true;
        if (event.frame.k === "space") retry(env, tab);
      } else if (event.type === "room" && mirror && event.gen === mirror.gen && event.at >= 0) {
        mirror.log[event.at] = event.frame;
        if (event.frame.k === "receipt") mirror.base = { commit: event.frame.commit, etag: event.frame.etag, through: event.frame.through };
      } else {
        await refresh();
      }
      await settle();
    });
  }

  // The save loop: a save when edits pause for idleMs, and at the latest maxMs after the first
  // unsaved one. Every save is a conditional write, so a second writer is refused, never merged.
  const unsaved = () => Boolean(tab.state) && tab.a > (tab.base?.through ?? 0);
  function plan() {
    if (closed || !unsaved()) {
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      idleTimer = maxTimer = null;
      if (closed || ![...tab.edits.values()].some((one) => one.state === "pending")) {
        flushing = false;
        whenSaved.splice(0).forEach((resolve) => resolve());
      }
      return;
    }
    clearTimeout(idleTimer);
    // A flush saves as soon as there is something admitted to save and no save on the way.
    idleTimer = setTimeout(save, flushing && !tab.io ? 0 : idleMs);
    maxTimer ??= setTimeout(save, maxMs);
  }
  function save() {
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    idleTimer = maxTimer = null;
    pump(async () => {
      await refresh();
      capture(env, tab);
      await settle();
    });
  }

  function report() {
    for (const [id, one] of tab.edits) {
      const handle = handles.get(id);
      if (!handle || handle.state === one.state) continue;
      handle.state = one.state;
      if (ADMITTED.has(one.state) || SETTLED.has(one.state)) handle.admit(one.state);
      if (SETTLED.has(one.state)) handle.settle(one.state);
    }
    emit({ type: "change" });
  }

  function emit(event) {
    for (const listener of listeners) listener(event);
  }

  const ready = pump(async () => {
    unsubscribe = subscribe(page, clientId, hear);
    await refresh();
    await settle();
  });

  return {
    ready,
    get status() {
      const states = [...tab.edits.values()].map((one) => one.state);
      return {
        mode: "ordered",
        connected: !closed,
        pending: states.filter((state) => state === "pending").length,
        unsaved: states.filter((state) => state === "shared").length,
        unknownSave: Boolean(tab.unknown),
        generation: tab.gen,
        through: tab.base?.through ?? null,
        copies: copies.size,
        error: failure,
      };
    },
    // The action is recorded with what the author saw, before any other task can change the view.
    submit(action) {
      if (!tab.state) throw new Error("clay.liveRoom: wait for room.ready before submitting an edit");
      const id = addEdit(env, tab, action, view(tab));
      if (!id) return null;
      const handle = { state: "pending" };
      handle.admitted = new Promise((resolve) => (handle.admit = resolve));
      handle.durable = new Promise((resolve) => (handle.settle = resolve));
      handles.set(id, handle);
      if (held) {
        const io = held;
        held = null;
        send(io);
      }
      step();
      return { id, admitted: handle.admitted, durable: handle.durable };
    },
    // Waits for the edits that exist now and for the file to hold everything this tab has seen
    // admitted (a coworker's edit included), and says what happened to each of this tab's edits.
    // After close, an edit not settled resolves with its last state ("pending" or "shared").
    async flush() {
      const ids = [...handles.keys()];
      flushing = true;
      const saved = new Promise((resolve) => whenSaved.push(resolve));
      save();
      const states = await Promise.all(ids.map((id) => handles.get(id).durable));
      await saved;
      return Object.fromEntries(ids.map((id, i) => [id, states[i]]));
    },
    view: () => view(tab),
    notices: () => tab.notices,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      clearTimeout(waitTimer);
      for (const timer of timers) clearTimeout(timer);
      await chain;
      await unsubscribe();
      for (const handle of handles.values()) {
        handle.admit?.(handle.state);
        handle.settle(handle.state);
      }
      whenSaved.splice(0).forEach((resolve) => resolve());
    },
  };
}

// File-only mode (a host that announces `ordered-file`): no room, every save a conditional write
// of the whole file, over the generated file-only core.
export function createFileClient({ page, codec, clientId, fetch, subscribe, limits = REAL_LIMITS, idleMs = 2000, maxMs = 8000, firstId = Math.floor(Math.random() * 2 ** 40) }) {
  const copies = new Map();
  const tab = { id: clientId, alive: true, client: clientId, clients: new Set([clientId]), born: null, n: 0, base: null, pending: [], io: null, unknown: null, unstored: [], judged: new Map(), edits: new Map(), notices: [] };
  const answers = [];
  const pushes = [];
  const handles = new Map();
  const listeners = new Set();
  const counters = {};
  const query = `page=${encodeURIComponent(page)}`;
  let file = null;
  let chain = Promise.resolve();
  let idleTimer = null;
  let maxTimer = null;
  let closed = false;
  let failure = null;
  let unsubscribe = () => {};

  const port = {
    read: () => file,
    etag: () => file?.etag ?? null,
    next: (counter) => (counters[counter] = (counters[counter] ?? firstId) + 1),
    keepRecovery: ({ id, body }) => copies.set(id, body),
    fetchRecovery: (id) => copies.get(id) ?? null,
    send: (_, io) => send(io),
    takeAnswer: (at) => answers.splice(at, 1)[0],
    takePush: () => pushes.shift() ?? null,
  };
  const env = { limits, observer: silent, port };

  function pump(work) {
    chain = chain
      .then(() => (closed ? undefined : (useCodec(codec), work())))
      .catch((error) => {
        failure = error;
        emit({ type: "error", error });
      });
    return chain;
  }

  async function readFile() {
    const got = await fetch(`/_/file?${query}`);
    if (!got.ok) throw new Error(`the host did not answer the file read (${got.status})`);
    const body = await got.text();
    file = { etag: got.headers.get("etag"), ...parse(body) };
    return { etag: file.etag, body };
  }

  function send(io) {
    fetch(`/_/save?${query}`, { method: "POST", headers: { "if-match": io.etag }, body: io.body }).then(
      async (answer) => land(io, answer.status, answer.ok ? (await answer.json()).etag : null, false),
      () => land(io, 0, null, true),
    );
  }

  function land(io, status, etag, lost) {
    pump(async () => {
      await readFile();
      answers.push({ tab, io, status, etag });
      fileDeliver(env, answers.length - 1, lost);
      after();
    });
  }

  function hear(event) {
    if (event.type !== "file") return;
    pump(async () => {
      const { etag, body } = await readFile();
      pushes.push({ tab, etag, body });
      filePush(env, tab);
      after();
    });
  }

  function after() {
    report();
    if (closed || !tab.pending.length) {
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      idleTimer = maxTimer = null;
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(save, idleMs);
    maxTimer ??= setTimeout(save, maxMs);
  }

  function save() {
    clearTimeout(idleTimer);
    clearTimeout(maxTimer);
    idleTimer = maxTimer = null;
    pump(async () => {
      await readFile();
      fileSave(env, tab);
      report();
    });
  }

  function report() {
    for (const [id, one] of tab.edits) {
      const handle = handles.get(id);
      if (!handle || handle.state === one.state) continue;
      handle.state = one.state;
      if (SETTLED.has(one.state)) handle.settle(one.state);
    }
    emit({ type: "change" });
  }

  function emit(event) {
    for (const listener of listeners) listener(event);
  }

  const ready = pump(async () => {
    unsubscribe = subscribe(page, clientId, hear);
    await readFile();
    fileRefresh(env, tab);
  });

  return {
    ready,
    get status() {
      const states = [...tab.edits.values()].map((one) => one.state);
      return { mode: "file", connected: !closed, pending: states.filter((state) => state === "pending").length, unsaved: 0, unknownSave: Boolean(tab.unknown), generation: tab.base?.record.gen ?? null, through: null, copies: copies.size, error: failure };
    },
    submit(action) {
      if (!tab.base) throw new Error("clay.liveRoom: wait for room.ready before submitting an edit");
      const id = fileEdit(env, tab, action);
      const handle = { state: "pending" };
      handle.admitted = Promise.resolve("local");
      handle.durable = new Promise((resolve) => (handle.settle = resolve));
      handles.set(id, handle);
      after();
      return { id, admitted: handle.admitted, durable: handle.durable };
    },
    async flush() {
      const ids = [...handles.keys()];
      save();
      const states = await Promise.all(ids.map((id) => handles.get(id).durable));
      return Object.fromEntries(ids.map((id, i) => [id, states[i]]));
    },
    view: () => fileView(tab),
    notices: () => tab.notices,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      closed = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      await chain;
      await unsubscribe();
      for (const handle of handles.values()) handle.settle(handle.state);
    },
  };
}

// The mode is fixed for the page load: room mode on a host that announces `ordered-room`, file-only
// mode on one that announces `ordered-file`, and neither otherwise (the edits stay in the tab).
export async function connect(options) {
  const answer = await options.fetch("/_/announce");
  const { extensions = [] } = answer.ok ? await answer.json() : {};
  if (extensions.includes("ordered-room")) return createRoomClient(options);
  if (extensions.includes("ordered-file")) return createFileClient(options);
  return null;
}
