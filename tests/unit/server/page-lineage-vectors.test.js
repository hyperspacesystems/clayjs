/**
 * @jest-environment node
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import * as Y from "../../../src/vendor/yjs.vendor.js";
import { seedPageFromArticle } from "../../../src/page/ybind/migrate.js";
import { entriesOf } from "../../../src/page/ybind/parts.js";
import { articleOf } from "../../../src/server/rooms/page-rebase.js";
import { buildVectors, fileOf } from "../../../scripts/build-page-lineage-vectors.mjs";

const FILE = new URL("../../fixtures/offline-runtime/page-lineage.json", import.meta.url);
const vectors = buildVectors();

const clientsOf = (value) => {
  const clients = new Set();
  for (const [, text] of entriesOf(value.y)) for (const c of Y.decodeStateVector(Y.encodeStateVectorFromUpdateV2(Y.fromBase64(text))).keys()) clients.add(c);
  return [...clients].sort((a, b) => a - b);
};

test("the stored vectors are exactly what the generator builds", () => {
  expect(JSON.stringify(vectors, null, 2) + "\n").toBe(readFileSync(FILE, "utf8"));
});

test("every seed entry reads the same client in the browser and on the host", () => {
  const hostDocument = new JSDOM("").window.document;
  for (const entry of vectors.seeds) {
    const file = fileOf(entry);
    const browser = seedPageFromArticle(new JSDOM(file).window.document.querySelector("article[data-blockeditor]"));
    const found = articleOf(file, hostDocument);
    expect(found).not.toBeNull();
    const host = seedPageFromArticle(found.article);
    const expected = entry.client === null ? [] : [entry.client];
    expect({ name: entry.name, browser: clientsOf(browser) }).toEqual({ name: entry.name, browser: expected });
    expect({ name: entry.name, host: clientsOf(host) }).toEqual({ name: entry.name, host: expected });
  }
});
