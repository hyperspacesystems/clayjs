import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
test("round 14 capture ancestry across restart", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("./round14-lineage.mjs", import.meta.url))], { env: { ...process.env, NODE_OPTIONS: "" } });
});
