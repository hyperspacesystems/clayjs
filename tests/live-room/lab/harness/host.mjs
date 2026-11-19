import { planted } from "../core/planted.mjs";
import { DOC, serialize, parse, page, parsePage } from "../core/record.mjs";
import { newState } from "../core/ledger.mjs";
import { clone } from "../core/lib.mjs";
import { CLOSING } from "../core/recover.mjs";
import { useCodec } from "../core/codec.mjs";
import { labCodec, codecDoc } from "./lens.mjs";

useCodec(labCodec);

export const FIRST_GEN = "0.00000000";
export const FIRST_COMMIT = "c00000000000";

export function newHost(wb) {
  const record = { v: 2, doc: DOC, gen: FIRST_GEN, epoch: 0, commit: FIRST_COMMIT, parent: null, through: 0 };
  const body = serialize(record, newState(codecDoc(clone(wb))));
  return { etag: "e0", writes: 0, title: "", body, versions: [{ kind: "initial", commit: FIRST_COMMIT, body }], recoveries: [], decisions: [], removals: [], copyWrites: 0, copyFaults: 0, markWrites: 0, markFaults: 0, removalSaves: 0, faults: null, deaf: null, deafMark: null };
}

export const get = (host) => ({ etag: host.etag, ...parse(host.body) });

const TITLE = /<title>[^<]*<\/title>/;

export const withTitle = (body, title) => (title ? `<!doctype html><title>${title}</title>${body.replace(TITLE, "").slice("<!doctype html>".length)}` : body.replace(TITLE, ""));

export function write(host, body, kind) {
  body = withTitle(body, host.title);
  host.body = body;
  host.etag = `e${++host.writes}`;
  host.versions.push({ kind, commit: parse(body).record.commit, body });
  return host.etag;
}

export function put(host, body, ifMatch, kind) {
  if (ifMatch !== host.etag && ifMatch !== "*" && !planted("unconditional-save")) return { status: 412, etag: host.etag };
  return { status: 200, etag: write(host, body, kind) };
}

export function keepVersion(host, body, kind) {
  const { record, state } = parse(body);
  const stored = kind === "backup" && planted("backup-empty-bytes") ? serialize(record, { ...state, wb: codecDoc({ rows: {} }) }) : body;
  host.versions.push({ kind, commit: record.commit, body: stored });
}

export const FAULTS = ["drop", "blank", "torn", "deaf"];

export const faultPlan = (rnd, rate, run) => ({ rnd, rate, run, streak: 0 });

function nextFault(host) {
  const plan = host.faults;
  if (!plan) return null;
  if (Array.isArray(plan)) return plan.shift() ?? null;
  if (plan.streak >= plan.run || plan.rnd() >= plan.rate) {
    plan.streak = 0;
    return null;
  }
  plan.streak++;
  return FAULTS[Math.floor(plan.rnd() * FAULTS.length)];
}

const damaged = (body, fault) => (fault === "blank" ? page({ ...parsePage(body).record, edits: [] }, codecDoc({ rows: {} })) : fault === "torn" ? body.slice(0, body.length >> 1) : body);

export function keepRecovery(host, copy) {
  const fault = nextFault(host);
  host.copyWrites++;
  if (fault) host.copyFaults++;
  if (fault === "drop") return;
  const kept = { ...copy, body: damaged(copy.body, fault) };
  const at = host.recoveries.findIndex((one) => one.id === copy.id);
  if (at < 0) host.recoveries.push(kept);
  else host.recoveries[at] = kept;
  if (fault === "deaf") host.deaf = copy.id;
}

const stored = (host, id) => host.recoveries.find((copy) => copy.id === id)?.body ?? null;

export function fetchRecovery(host, id) {
  if (host.deaf !== id) return stored(host, id);
  host.deaf = null;
  return null;
}

const markKey = ({ copy, e, kind }) => `${copy}/${e}/${kind}`;

export function keepDecision(host, mark) {
  const fault = nextFault(host);
  host.markWrites++;
  if (fault) host.markFaults++;
  if (fault && fault !== "deaf") return;
  if (!host.decisions.some((one) => markKey(one) === markKey(mark))) host.decisions.push({ copy: mark.copy, e: mark.e, kind: mark.kind });
  if (fault === "deaf") host.deafMark = markKey(mark);
}

export function fetchDecision(host, mark) {
  if (host.deafMark === markKey(mark)) {
    host.deafMark = null;
    return false;
  }
  return host.decisions.some((one) => markKey(one) === markKey(mark));
}

const removalKey = ({ by, at }) => `${by}@${at.join("#")}`;

export function keepRemovals(host, entries) {
  if (entries.length) host.removalSaves++;
  for (const { copy, by, at, cells } of entries) if (!host.removals.some((one) => removalKey(one) === removalKey({ by, at }))) host.removals.push({ copy, by, at, cells });
}

export const marked = (host, e, kind) => host.decisions.some((mark) => mark.e === e && mark.kind === kind);

export function verdict(host, e) {
  const marks = host.decisions.filter((mark) => mark.e === e);
  for (const kind of [...CLOSING, "open", "refused"]) {
    const found = marks.find((mark) => mark.kind === kind);
    if (found) return found;
  }
  return null;
}

export function readRecovery(host, id) {
  const body = stored(host, id);
  if (body === null || !body.includes("</script>")) return null;
  const { record, wb } = parsePage(body);
  return { ...record, preview: wb };
}
