/** @jest-environment node */
import { afterAll, beforeAll, expect, test } from "@jest/globals";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emitChunks } from "../../scripts/build-chunks.mjs";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
let outdir;
let built;
beforeAll(async () => {
  outdir = await mkdtemp(path.join(os.tmpdir(), "clay-drafts-recovery-"));
  built = await emitChunks({ root, outdir });
}, 60000);
afterAll(async () => { await rm(outdir, { recursive: true, force: true }); });

test("the deferred recovery service does not split the session's commit module", () => {
  const outputs = Object.values(built.metafile.outputs);
  const sessions = outputs.filter((output) => output.inputs["src/plugins/visitor-drafts/session.js"]);
  expect(sessions).toHaveLength(1);
  expect(sessions[0].inputs).toHaveProperty(["src/plugins/visitor-drafts/commit.js"]);
  expect(sessions[0].inputs).toHaveProperty(["src/plugins/visitor-drafts/idb.js"]);
  const recovery = outputs.filter((output) => output.inputs["src/plugins/visitor-drafts/recovery.js"]);
  expect(recovery).toHaveLength(1);
  expect(recovery[0]).not.toBe(sessions[0]);
  expect(recovery[0].inputs).not.toHaveProperty(["src/plugins/visitor-drafts/commit.js"]);
  const serializer = Object.keys(recovery[0].inputs).filter((name) => name.startsWith("recovery-controls:") && name.endsWith("control-serialize.vendor.js"));
  expect(serializer).toHaveLength(1);
});

test("the recovery serializer resolver recognizes Windows and POSIX importer paths", async () => {
  const source = await readFile(path.join(root, "scripts/build-chunks.mjs"), "utf8");
  const body = source.slice(source.indexOf("function recoveryControlsPlugin()"), source.indexOf("function replaceOnce("));
  const plugin = new Function("path", "readFile", body + "return recoveryControlsPlugin();")(path, readFile);
  let resolve;
  plugin.setup({ initialOptions: { absWorkingDir: root }, onResolve: (_options, callback) => { resolve = callback; }, onLoad() {} });
  for (const importer of ["/app/src/plugins/visitor-drafts/recovery.js", String.raw`C:\app\src\plugins\visitor-drafts\recovery.js`]) {
    const resolved = resolve({ importer, resolveDir: path.join(root, "src/plugins/visitor-drafts"), path: "../../vendor/control-serialize.vendor.js" });
    expect(resolved).toEqual({ namespace: "recovery-controls", path: "src/vendor/control-serialize.vendor.js" });
  }
  expect(resolve({ importer: "/app/src/core/persist.js", resolveDir: root, path: "../vendor/control-serialize.vendor.js" })).toBeUndefined();
});
