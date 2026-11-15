/**
 * @jest-environment node
 */
import * as esbuild from "esbuild";
import { createFeatureLoader } from "../../src/lib/editor-feature-loader.js";
import { createFeatureLoader as pageCreateFeatureLoader } from "../../src/page/feature-loader.js";

/**
 * The feature loader every editor shares. src/page/feature-loader.js, the path it had
 * when only the page used it, still exports this same function, and each loader keeps
 * its own fetches and its own installed features: two editors that ask for the same
 * feature never see each other's.
 *
 * Its lifecycle, each step held open by a promise the test settles: a preparation
 * fetches without installing, a failed fetch is reported once and fetched again on the
 * next ask, a caller's abort ends only its own wait, and a disposed loader installs
 * nothing that lands late and disposes what an install already under way returns. A
 * waiter is handed that disposed feature, so whether a command may still run is the
 * caller's own check. No page module, feature module or vendored library comes with
 * the shared module.
 */

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// One editor's side of a loader: its own gate on the fetch, and a record of what it
// fetched, installed, disposed and reported.
const ownerOf = (name) => {
  const owner = { gate: deferred(), loads: [], installed: [], disposed: [], reports: [] };
  owner.loader = createFeatureLoader({
    load: (id) => {
      owner.loads.push(id);
      return owner.gate.promise.then(() => ({ createFeature: () => ({ id, owner: name, dispose: () => owner.disposed.push(id) }) }));
    },
    install: (id, mod) => {
      const feature = mod.createFeature();
      owner.installed.push(feature);
      return feature;
    },
    reportError: (error) => owner.reports.push(error),
  });
  return owner;
};

test("the page path exports the shared loader itself", () => {
  expect(pageCreateFeatureLoader).toBe(createFeatureLoader);
});

test("a loader never hands out a feature another loader installed", async () => {
  const first = ownerOf("first");
  const second = ownerOf("second");
  first.gate.resolve();
  second.gate.resolve();

  const a = await first.loader.ensure("table");
  const b = await second.loader.ensure("table");

  expect([a.owner, b.owner]).toEqual(["first", "second"]);
  expect(first.loads).toEqual(["table"]);
  expect(second.loads).toEqual(["table"]);
  expect(first.installed).toEqual([a]);
  expect(second.installed).toEqual([b]);

  first.loader.dispose();
  expect(first.disposed).toEqual(["table"]);
  expect(second.disposed).toEqual([]);
  expect(second.loader.has("table")).toBe(true);
  expect(await second.loader.ensure("table")).toBe(b);
  expect([...first.reports, ...second.reports]).toEqual([]);
});

test("two loaders with the same feature on the wire each use their own fetch", async () => {
  const first = ownerOf("first");
  const second = ownerOf("second");

  first.loader.prepare("table");
  const forSecond = second.loader.ensure("table");
  const forFirst = first.loader.ensure("table");
  expect(first.loads).toEqual(["table"]);
  expect(second.loads).toEqual(["table"]);

  second.gate.resolve();
  const b = await forSecond;
  expect(b.owner).toBe("second");
  expect(first.loader.has("table")).toBe(false);

  first.gate.resolve();
  const a = await forFirst;
  expect(a.owner).toBe("first");
  expect(first.installed).toEqual([a]);
  expect(second.installed).toEqual([b]);
  expect([...first.reports, ...second.reports]).toEqual([]);
});

const ROOT = new URL("../../", import.meta.url).pathname;
const SHARED = "src/lib/editor-feature-loader.js";
const DISPOSED = "page: feature loader disposed before table";

// A loader over the test's own fetch and install, with a record of every call it makes.
const recording = ({ load, install = (_id, mod) => mod.createFeature() }) => {
  const calls = { loads: [], installs: [], reports: [] };
  const loader = createFeatureLoader({
    load: (id) => { calls.loads.push(id); return load(id, calls.loads.length); },
    install: (id, mod) => { calls.installs.push(id); return install(id, mod); },
    reportError: (error, id) => calls.reports.push([error, id]),
  });
  return { loader, calls };
};

// A feature that listens on its owner until it is disposed, the way an installed
// feature holds listeners on an editor.
const listening = (owner, heard) => {
  const onPing = () => heard.push("ping");
  owner.addEventListener("ping", onPing);
  const feature = { disposals: 0, dispose: () => { feature.disposals += 1; owner.removeEventListener("ping", onPing); } };
  return feature;
};

async function graphOf(entry) {
  const result = await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    write: false,
    metafile: true,
    external: ["https://*"],
    logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs);
}

// What the shared loader must never bring with it, by the kind of module. One line per
// kind a graph holds, so a failure names the kind and one file of it.
const FORBIDDEN = {
  "a page module": /^src\/page\//,
  "a vendored library": /^src\/vendor\//,
  "ProseMirror": /prosemirror/i,
  "Yjs": /yjs|ybind/i,
  "a chart module": /chart/i,
  "a feature module": /\/features\//,
};
const forbiddenIn = (inputs) => Object.entries(FORBIDDEN)
  .map(([kind, pattern]) => [kind, inputs.filter((file) => pattern.test(file))])
  .filter(([, files]) => files.length)
  .map(([kind, files]) => `${kind}: ${files.length}, the first is ${files[0]}`);

test("a preparation fetches without installing, and the next ensure installs from that same fetch", async () => {
  const fetched = deferred();
  const feature = { id: "table" };
  const { loader, calls } = recording({ load: () => fetched.promise });

  const preparing = loader.prepare("table");
  loader.prepare("table");
  fetched.resolve({ createFeature: () => feature });
  await preparing;
  expect(calls).toEqual({ loads: ["table"], installs: [], reports: [] });
  expect(loader.has("table")).toBe(false);

  expect(await loader.ensure("table")).toBe(feature);
  expect(calls).toEqual({ loads: ["table"], installs: ["table"], reports: [] });
  expect(loader.has("table")).toBe(true);
});

test("a failed preparation stays quiet, the ensure that takes it reports once, and the next ensure fetches again and installs once", async () => {
  const error = new Error("no network");
  const feature = { id: "table" };
  const { loader, calls } = recording({
    load: (_id, attempt) => (attempt === 1 ? Promise.reject(error) : Promise.resolve({ createFeature: () => feature })),
  });

  await expect(loader.prepare("table")).rejects.toBe(error);
  expect(calls).toEqual({ loads: ["table"], installs: [], reports: [] });

  await expect(loader.ensure("table")).rejects.toBe(error);
  expect(calls.loads).toEqual(["table"]);
  expect(calls.installs).toEqual([]);
  expect(calls.reports).toHaveLength(1);
  expect(calls.reports[0][0]).toBe(error);
  expect(calls.reports[0][1]).toBe("table");
  expect(loader.has("table")).toBe(false);

  expect(await loader.ensure("table")).toBe(feature);
  expect(calls.loads).toEqual(["table", "table"]);
  expect(calls.installs).toEqual(["table"]);
  expect(calls.reports).toHaveLength(1);
  expect(loader.has("table")).toBe(true);
});

test("a caller that aborts ends only its own wait: the caller still waiting gets the one install, and nothing is reported", async () => {
  const fetched = deferred();
  const feature = { id: "table" };
  const { loader, calls } = recording({ load: () => fetched.promise });
  const leaving = new AbortController();
  const staying = new AbortController();
  const reason = new Error("stale target");

  const aborted = loader.ensure("table", { signal: leaving.signal });
  const waiting = loader.ensure("table", { signal: staying.signal });
  leaving.abort(reason);
  await expect(aborted).rejects.toBe(reason);
  expect(calls).toEqual({ loads: ["table"], installs: [], reports: [] });

  fetched.resolve({ createFeature: () => feature });
  expect(await waiting).toBe(feature);
  expect(calls).toEqual({ loads: ["table"], installs: ["table"], reports: [] });
  expect(loader.has("table")).toBe(true);
});

test("a loader disposed before its fetch lands installs nothing, and refuses every later ask", async () => {
  const fetched = deferred();
  const owner = new EventTarget();
  const heard = [];
  const { loader, calls } = recording({ load: () => fetched.promise });

  const waiting = loader.ensure("table");
  loader.dispose();
  fetched.resolve({ createFeature: () => listening(owner, heard) });
  const landed = await waiting;

  expect(calls.installs).toEqual([]);
  expect(landed).toBe(null);
  owner.dispatchEvent(new Event("ping"));
  expect(heard).toEqual([]);
  expect(loader.has("table")).toBe(false);
  await expect(loader.ensure("table")).rejects.toThrow(DISPOSED);
  await expect(loader.prepare("table")).rejects.toThrow(DISPOSED);
  expect(calls).toEqual({ loads: ["table"], installs: [], reports: [] });
});

test("a loader disposed while an install is resolving disposes the feature that install returns, once, and keeps none", async () => {
  const installing = deferred();
  const installed = deferred();
  const owner = new EventTarget();
  const heard = [];
  const { loader, calls } = recording({
    load: () => Promise.resolve({}),
    install: () => { installing.resolve(); return installed.promise; },
  });

  const waiting = loader.ensure("table");
  await installing.promise;
  loader.dispose();
  const feature = listening(owner, heard);
  owner.dispatchEvent(new Event("ping"));
  expect(heard).toEqual(["ping"]);
  installed.resolve(feature);
  const landed = await waiting;

  expect(feature.disposals).toBe(1);
  owner.dispatchEvent(new Event("ping"));
  expect(heard).toEqual(["ping"]);
  expect(landed).toBe(feature);
  expect(loader.has("table")).toBe(false);
  loader.dispose();
  expect(feature.disposals).toBe(1);
  expect(calls).toEqual({ loads: ["table"], installs: ["table"], reports: [] });
});

test("the shared loader's module graph holds no editor, feature or vendored library, and the page editor's graph holds them all", async () => {
  const inputs = await graphOf(SHARED);
  expect(inputs.length).toBeGreaterThan(0);
  expect(inputs).toContain(SHARED);
  expect(forbiddenIn(inputs)).toEqual([]);

  const editor = await graphOf("src/page/editor.js");
  expect(editor).toContain(SHARED);
  expect(forbiddenIn(editor)).toHaveLength(Object.keys(FORBIDDEN).length);
});
