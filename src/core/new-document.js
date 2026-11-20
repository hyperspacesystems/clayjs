import { engine, applyData, blankData } from "../vendor/hyper-html-api-data.vendor.js";
import { finalizeControlForSave } from "../vendor/control-serialize.vendor.js";
import { TAB_LOCAL_ROOT_ATTRS, stripRouteAttrs } from "../lib/root-attrs.js";
import { cleanSaveCopy } from "../lib/region-policy.js";
import { stripCopyContent } from "./copy-content.js";
import { downloadHtml, documentName, portableHtml } from "./download.js";

/**
 * New blank document: this document with its data emptied, as a new file.
 *
 * The page's `api` rules name its data, so a blank copy is the page with blankData
 * applied, starting values (`<script type="application/json" clay-new-document>`)
 * winning. Copy content (`clay="no-copy"`) is cut from the HTML string first, as every
 * copy does. A page whose rules do not cover everything (a Block page's article and
 * store) blanks the rest in a `clay:newdocument` listener, which gets the detached copy.
 * The live page is never touched.
 */

const STARTING = 'script[type="application/json"][clay-new-document]';
const CONTROLS = 'input:not([type="password"]):not([type="file"]), textarea, select';
const FAILED = "Couldn't make a new document. Try again.";

export const hasRules = (doc = document) => Boolean(doc.querySelector('script[data-rules-name~="api"]'));

function startingValues(doc) {
  const tag = doc.querySelector(STARTING);
  if (!tag) return {};
  try {
    const value = JSON.parse(tag.textContent);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  console.warn("clayjs: the clay-new-document tag does not hold a JSON object, so every value starts blank");
  return {};
}

async function currentHtml() {
  if (typeof window.clay?.getHTML === "function" && (!window.clay?.isDraftMode || !/^https?:$/.test(location.protocol))) {
    return window.clay.getHTML();
  }
  const response = await fetch(location.href, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Clay-Source": "1" },
  });
  if (!response.ok) throw new Error(`the page answered ${response.status}`);
  return response.text();
}

function cleanDocument(doc) {
  const root = doc.documentElement;
  if (!root) return;
  cleanSaveCopy(root);
  for (const name of TAB_LOCAL_ROOT_ATTRS) root.removeAttribute(name);
  stripRouteAttrs(root);
}

function writableRules(rules) {
  const active = {};
  for (const [key, rule] of Object.entries(rules)) {
    const codec = engine.codecOf ? engine.codecOf(rule) : null;
    if (codec && !engine.codecs.get(codec.name)) continue;
    active[key] = rule;
  }
  return active;
}

function serialize(doc) {
  const doctype = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}>\n` : "";
  return doctype + doc.documentElement.outerHTML;
}

export async function build() {
  const html = stripCopyContent(await currentHtml());
  const doc = new DOMParser().parseFromString(html, "text/html");
  cleanDocument(doc);
  const found = engine.findRulesIn(doc, "api");
  if (!found?.rules) throw Object.assign(new Error("This page has no api rules tag."), { code: "no_rules" });
  const rules = writableRules(found.rules);
  if (Object.keys(rules).length > 0) {
    applyData(doc, blankData(rules), rules);
    const starting = startingValues(doc);
    if (Object.keys(starting).some((key) => Object.prototype.hasOwnProperty.call(rules, key))) {
      applyData(doc, blankData(rules, starting), rules);
    }
  }
  document.dispatchEvent(new CustomEvent("clay:newdocument", { detail: { document: doc } }));
  for (const control of doc.querySelectorAll(CONTROLS)) finalizeControlForSave(control);
  return serialize(doc);
}

async function hostAction() {
  if (!/^https?:$/.test(location.protocol)) return null;
  try {
    const { hostActions } = await import("./host-meta.js");
    return (await hostActions()).newDocument ?? null;
  } catch {
    return null;
  }
}

export async function create() {
  let html;
  try {
    html = await build();
  } catch (error) {
    console.error("clayjs: could not build the new document", error);
    return { ok: false, message: FAILED };
  }
  const action = await hostAction();
  if (action?.post) {
    let body = null;
    try {
      const response = await fetch(action.post, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "text/html;charset=utf-8", "Document-URL": location.href },
        body: html,
      });
      body = await response.json().catch(() => null);
      if (response.ok && body?.ok !== false && typeof body?.href === "string") return { ok: true, href: body.href };
    } catch {}
    const text = body?.msg ?? body?.message;
    return { ok: false, message: typeof text === "string" && text ? text : FAILED };
  }
  const downloaded = await downloadHtml({ html: portableHtml(html), name: `${documentName()}-new.html` });
  return downloaded ? { ok: true, downloaded: true } : { ok: false, message: FAILED };
}
