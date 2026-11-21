// The reference host: the whole host port of plan 09 section 2.1 over the ordered room
// registry, in memory. The htmlclay and hyperclay lanes copy it. Clients reach it through
// `host.fetch` (a fetch with the same answers a real host gives) and `host.subscribe` (the
// event stream), so tests drive it with no network. Faults are switched on per request.
import { randomInt } from "node:crypto";
import { createOrderedRooms } from "../../../src/server/rooms/index.js";
import { outsideFold } from "../../../src/live-room/core/fileonly.js";
import { resolved } from "../../../src/live-room/core/ledger.js";
import { parse } from "../../../src/live-room/core/record.js";
import { useCodec } from "../../../src/live-room/core/codec.js";
import { REAL_LIMITS } from "../../../src/live-room/core/limits.js";

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function createReferenceHost({ codecs, codec, room = true, keep = true, rooms: options = {} }) {
  // A room that frees memory tells the tabs of every other room that they may send again.
  const rooms = createOrderedRooms({ codecs, ...options, onSpace: (key) => broadcast(key, [{ to: "*", k: "space" }]) });
  const counters = {};
  const fileEnv = { limits: options.limits ?? REAL_LIMITS, port: { next: (counter) => (counters[counter] = (counters[counter] ?? (options.newId ?? (() => randomInt(2 ** 40)))()) + 1) } };
  const docs = new Map();
  const faults = [];
  let etags = 0;

  function doc(key) {
    const found = docs.get(key);
    if (!found) throw Object.assign(new Error(`no document ${key}`), { status: 404 });
    return found;
  }

  // One lock per document: the establishing commit, every save, the host's own commit and
  // every outside write run one at a time, each with the fileAccepted call that follows it.
  function locked(key, work) {
    const entry = doc(key);
    const run = entry.lock.then(work);
    entry.lock = run.catch(() => {});
    return run;
  }

  function broadcast(key, send) {
    const entry = docs.get(key);
    if (!entry) return;
    const live = rooms.get(key);
    const log = live?.log ?? [];
    for (const frame of send) {
      const at = frame.to === undefined ? log.lastIndexOf(frame) : -1;
      const wire = JSON.parse(JSON.stringify(frame));
      for (const [clientId, listener] of entry.listeners) {
        if (frame.to !== undefined && frame.to !== "*" && frame.to !== clientId) continue;
        listener({ type: "room", gen: live?.gen ?? null, at, frame: wire });
      }
    }
  }

  function push(key) {
    const entry = docs.get(key);
    for (const listener of entry.listeners.values()) listener({ type: "file", etag: entry.etag });
  }

  // A write the host accepted: on disk first, then the registry hears of it, then the tabs.
  function accept(key, bytes, kind) {
    const entry = doc(key);
    entry.bytes = bytes;
    entry.etag = `"e${++etags}"`;
    entry.versions.push({ kind, etag: entry.etag, bytes });
    if (!room) {
      push(key);
      return { answer: "none", send: [] };
    }
    const told = rooms.fileAccepted(key, { bytes, etag: entry.etag });
    broadcast(key, told.send);
    return told;
  }

  async function finalSave(key) {
    await locked(key, () => {
      const live = rooms.get(key);
      const own = live && rooms.render(live);
      // If-Match: the commit builds on the bytes the registry last heard of. On a host where
      // another program can write the file, a moved ETag means no final save (the room stays dirty
      // and is kept), never an overwrite.
      if (own && own.ifMatch === doc(key).etag) accept(key, own.bytes, "final");
    });
  }

  async function save(key, request) {
    return locked(key, () => {
      const entry = doc(key);
      const match = request.headers.get("if-match");
      if (match !== entry.etag) return json(412, { etag: entry.etag });
      return request.text().then((bytes) => {
        if (room && rooms.ends(key, bytes)) return json(409, { etag: entry.etag, error: "this save is not the room's next commit" });
        accept(key, bytes, "save");
        return json(200, { etag: entry.etag });
      });
    });
  }

  async function establish(key, request) {
    if (!room) return json(404, { error: "no room on this host" });
    return locked(key, () => {
      const entry = doc(key);
      if (request.headers.get("if-match") !== entry.etag) return json(412, { etag: entry.etag });
      const built = rooms.establish(key, { bytes: entry.bytes, etag: entry.etag, codec });
      if (!built) return json(503, { error: "the host cannot hold this room now" });
      accept(key, built.bytes, "establish");
      rooms.open(key, { bytes: entry.bytes, etag: entry.etag });
      push(key);
      return json(200, { etag: entry.etag });
    });
  }

  function join(key, clientId) {
    if (!room) return json(404, { error: "no room on this host" });
    const instance = rooms.instance(key, codec);
    if (!instance) return json(503, { error: "the host cannot hold this room now" });
    const attached = instance.gen ? rooms.attach(instance, clientId, clientId) : null;
    if (instance.gen && !attached) return json(400, { error: "the room cannot attach this client id" });
    return json(200, { id: instance.id, ...(attached ?? { gen: null, base: null, tail: [] }), floor: instance.floor ?? 0 });
  }

  async function frames(key, clientId, request) {
    if (!room) return json(404, { error: "no room on this host" });
    const { frames: batch } = await request.json();
    const answer = await locked(key, () => admitAll(key, clientId, batch));
    // Frames that arrive after the last stream closed (a tab closed with a request on the way)
    // get the final save the leave would have made.
    if (!doc(key).listeners.size) await finalSave(key);
    return answer;
  }

  function admitAll(key, clientId, batch) {
    const answers = [];
    for (const frame of batch) {
      const live = rooms.get(key);
      if (!live) {
        answers.push("closed");
        continue;
      }
      const { answer, send } = rooms.frame(live, clientId, frame);
      answers.push(answer);
      broadcast(key, send);
    }
    return json(200, { answers });
  }

  // Recovery copies (plan 09 section 2.8, announced as `recovery-copies`): private to the
  // document, created once. The same bytes again for a known id answer the stored copy; different
  // bytes are refused. One copy up to 6 MiB, 32 MiB per document.
  const COPY_LIMIT = 6 * 1024 * 1024;
  const DOC_COPY_LIMIT = 32 * 1024 * 1024;
  async function copies(key, id, request) {
    const entry = doc(key);
    if (!id && request.method === "GET") return json(200, { copies: [...entry.copies.values()].map(({ id: one, time, size, done }) => ({ id: one, time, size, done })) });
    if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return json(400, { error: "a copy id is letters, digits, _ and -" });
    if (request.method === "GET") {
      const found = entry.copies.get(id);
      return found ? new Response(found.bytes, { status: 200, headers: { "content-type": "text/html" } }) : json(404, { error: "no such copy" });
    }
    if (request.method === "PUT") {
      // The body is read before the id is looked up, so the look up and the create happen in one
      // turn: of two writes racing for one id, exactly one creates it.
      const bytes = await request.text();
      const found = entry.copies.get(id);
      if (found) return found.bytes === bytes ? json(200, { id, size: found.size }) : json(409, { error: "a different copy is stored under this id" });
      const size = Buffer.byteLength(bytes);
      const used = [...entry.copies.values()].reduce((sum, one) => sum + one.size, 0);
      if (size > COPY_LIMIT || used + size > DOC_COPY_LIMIT) return json(413, { error: "the copy does not fit" });
      entry.copies.set(id, { id, bytes, size, time: Date.now(), done: [] });
      return json(201, { id, size });
    }
    return json(405, { error: "copies are read with GET and stored with PUT" });
  }

  async function copyDone(key, id, request) {
    const found = doc(key).copies.get(id);
    if (!found) return json(404, { error: "no such copy" });
    const { e, kind } = await request.json().catch(() => ({}));
    if (typeof e !== "string" || typeof kind !== "string") return json(400, { error: "a decision mark is { e, kind }" });
    if (!found.done.some((one) => one.e === e && one.kind === kind)) found.done.push({ e, kind, at: Date.now() });
    return json(200, { id, done: found.done });
  }

  // The outside write step: a version restore, an agent's write, an upload of an older copy.
  async function outside(key, bytes, kind) {
    return locked(key, () => {
      const entry = doc(key);
      if (!room) {
        useCodec(codecs[codec]);
        const { body } = outsideFold(fileEnv, parse(bytes), parse(entry.bytes));
        accept(key, body, kind);
        return { etag: entry.etag };
      }
      const step = rooms.outsideWrite(key, { bytes, current: entry.bytes, codec, keep, kind });
      if (!step) throw new Error("the outside write step could not read the file");
      if (step.backup) entry.versions.push({ kind: "backup", etag: null, bytes: step.backup });
      accept(key, step.bytes, kind);
      push(key);
      return { etag: entry.etag, backup: Boolean(step.backup) };
    });
  }

  // A host client's action (an agent cell patch while people edit, plan 09 section 2.9): admits
  // the action in the open room, broadcasts it, waits up to `waitMs` for a tab's commit covering
  // `seq`, then falls back to `finalSave` so the caller hears "ok" only after it is on disk.
  async function submit(key, action, { waitMs = 150 } = {}) {
    const admitted = await locked(key, () => {
      const live = rooms.get(key);
      if (!live) return { answer: "closed", applied: false, seq: null, id: null, gen: null };
      const res = rooms.submit(live, action);
      broadcast(key, res.send);
      return { answer: res.answer, applied: res.applied, seq: res.seq, id: res.id, gen: live.gen };
    });
    if (admitted.answer !== "ok") return { ...admitted, etag: doc(key).etag };
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      const live = rooms.get(key);
      if (!live || live.gen !== admitted.gen) break;
      if (live.base.through >= admitted.seq) return { ...admitted, etag: doc(key).etag };
      await new Promise((r) => setTimeout(r, 5));
    }
    const live = rooms.get(key);
    if (live && live.gen === admitted.gen && live.base.through < admitted.seq) await finalSave(key);
    const after = rooms.get(key);
    if (after && after.gen === admitted.gen && after.base.through >= admitted.seq) {
      return { ...admitted, etag: doc(key).etag };
    }
    // Room closed or moved before our commit landed: check whether the file ledger resolved our id.
    useCodec(codecs[codec]);
    const file = parse(doc(key).bytes);
    const sep = admitted.id.lastIndexOf(":");
    const client = sep > 0 ? admitted.id.slice(0, sep) : admitted.id;
    const num = Number(admitted.id.slice(sep + 1));
    const durable = resolved(file.state, client) >= num;
    return { ...admitted, answer: durable ? "ok" : "lost", applied: durable, etag: doc(key).etag };
  }

  async function route(request) {
    const url = new URL(request.url);
    const key = url.searchParams.get("page");
    const clientId = url.searchParams.get("client-id");
    if (request.method === "GET" && url.pathname === "/_/file") {
      const entry = doc(key);
      return new Response(entry.bytes, { status: 200, headers: { etag: entry.etag, "content-type": "text/html" } });
    }
    if (request.method === "POST" && url.pathname === "/_/save") return save(key, request);
    if (url.pathname === "/_/sync/room") {
      if (request.method === "GET") return join(key, clientId);
      if (url.searchParams.get("op") === "establish") return establish(key, request);
      return frames(key, clientId, request);
    }
    const done = url.pathname.match(/^\/_\/copies\/([^/]+)\/done$/);
    if (done && request.method === "POST") return copyDone(key, done[1], request);
    const copy = url.pathname.match(/^\/_\/copies(?:\/([^/]+))?$/);
    if (copy) return copies(key, copy[1], request);
    if (request.method === "GET" && url.pathname === "/_/meta") return json(200, { spec: 1, extensions: [room ? "ordered-room" : "ordered-file", "recovery-copies"] });
    return json(404, { error: "no route" });
  }

  // fetch(url, init): faults act here, around the host. "drop" loses the request before the host
  // sees it, "lose" lets the host act and loses the answer, "twice" delivers the request twice
  // and answers the second, "unknown" lets the host act and answers 503 (hyperclay's save-unknown:
  // the file was written but its sync failed), "move" has another writer change the file just before the request
  // (through the outside write step; by default bytes outside the tables, a title), so its ETag
  // no longer matches. "torn" and "blank" cut or empty the answer's body (a read back that does not
  // match).
  async function fetch(url, init = {}) {
    const request = new Request(new URL(url, "http://host.test"), init);
    const fault = faults.findIndex((one) => one.matches(request));
    const [{ kind, change } = {}] = fault >= 0 ? faults.splice(fault, 1) : [];
    if (kind === "drop") throw new TypeError("fetch failed: the request was dropped");
    if (kind === "move") {
      const key = new URL(request.url).searchParams.get("page");
      const { bytes } = doc(key);
      await outside(key, change ? change(bytes) : bytes.replace("<!doctype html>", `<!doctype html><title>t${etags}</title>`), "move");
    }
    try {
      if (kind === "twice") await route(request.clone());
      const answer = await route(request);
      if (kind === "lose") throw new TypeError("fetch failed: the answer was lost");
      if (kind === "unknown") return json(503, { error: "save-unknown" });
      if (kind === "torn") return new Response((await answer.text()).slice(0, -40), { status: answer.status, headers: answer.headers });
      if (kind === "blank") return new Response("", { status: answer.status, headers: answer.headers });
      return answer;
    } catch (error) {
      if (error.status) return json(error.status, { error: error.message });
      throw error;
    }
  }

  return {
    rooms,
    fetch,
    put(key, bytes) {
      docs.set(key, { bytes, etag: `"e${++etags}"`, versions: [], copies: new Map(), listeners: new Map(), lock: Promise.resolve() });
      docs.get(key).versions.push({ kind: "put", etag: docs.get(key).etag, bytes });
    },
    file: (key) => ({ bytes: doc(key).bytes, etag: doc(key).etag }),
    versions: (key) => doc(key).versions,
    outside,
    submit,
    fault(kind, matches = () => true, change = null) {
      faults.push({ kind, matches, change });
    },
    // The event stream of one client. Closing it is the connection ending: the room forgets the
    // client's stages, and when the last client leaves a dirty room the host makes its own commit.
    subscribe(key, clientId, listener) {
      doc(key).listeners.set(clientId, listener);
      return async () => {
        // A reconnect that opened a new stream before the old one closed keeps the new one.
        const entry = docs.get(key);
        if (entry?.listeners.get(clientId) !== listener) return;
        entry.listeners.delete(clientId);
        if (!room) return;
        const live = rooms.get(key);
        if (!live) return;
        const left = rooms.leave(live, clientId);
        broadcast(key, left.send);
        if (left.empty && left.dirty) await finalSave(key);
      };
    },
    loseRoom(key) {
      return rooms.drop(key);
    },
  };
}
