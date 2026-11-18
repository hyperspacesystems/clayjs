import { cp, symlink } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL("../../..", import.meta.url).pathname);
const FILES = ["build.js", "package.json", "packed-contract.json", "THIRD-PARTY-NOTICES.md"];

// A test box downloads the pinned Chrome into scripts/chrome-for-testing/.chrome-for-testing
// (about 400 MB). No build reads it, and a copy in every temp site filled slow box disks.
const notBrowser = (from) => !from.split(path.sep).includes(".chrome-for-testing");

// Lays out the package in a temp site the way build.js expects it: the top-level files, the
// named folders, and a link to node_modules.
export async function copyPackage(to, dirs) {
  for (const name of FILES) await cp(path.join(ROOT, name), path.join(to, name));
  for (const name of dirs) await cp(path.join(ROOT, name), path.join(to, name), { recursive: true, filter: notBrowser });
  await symlink(path.join(ROOT, "node_modules"), path.join(to, "node_modules"), "dir");
}
