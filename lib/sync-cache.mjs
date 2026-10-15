#!/usr/bin/env node
// sync-cache.mjs: merge the codex models cache into opencode.jsonc so the
// `provider.chatgpt.models` block stays in sync with the user's ChatGPT
// plan. Idempotent: prints "unchanged" if the file wouldn't change.
//
// Usage:
//   node sync-cache.mjs [--config <path>] [--codex-home <path>] [--provider <name>] [--write|--no-write]
//
// Default config:   ~/.config/opencode/opencode.jsonc
// Default codex home: ~/.codex
// Default provider name: chatgpt

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return fallback;
}
function hasFlag(name) { return args.includes(`--${name}`); }

const CONFIG_PATH = flag("config", join(homedir(), ".config", "opencode", "opencode.jsonc"));
const CODEX_HOME = flag("codex-home", join(homedir(), ".codex"));
const PROVIDER = flag("provider", "chatgpt");
const DO_WRITE = !hasFlag("no-write");
const CACHE_PATH = join(CODEX_HOME, "models_cache.json");

// ---- 1. Load models from codex cache ----
if (!existsSync(CACHE_PATH)) {
  console.error(`sync-cache: no models_cache.json at ${CACHE_PATH}`);
  process.exit(0); // not an error: codex hasn't been run yet
}

const cache = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
if (!Array.isArray(cache.models)) {
  console.error("sync-cache: cache.models is not an array");
  process.exit(0);
}

// Visibility gate: include models that are list-able. Some are hidden / review-only.
const VISIBLE = ["list", "default", null, undefined];
const slugs = cache.models
  .filter((m) => VISIBLE.includes(m.visibility))
  .filter((m) => m.supported_in_api !== false) // skip codex-auto-review etc.
  .map((m) => m.slug)
  .filter(Boolean);

// Stable order: priority first, then slug.
slugs.sort((a, b) => {
  const ma = cache.models.find((x) => x.slug === a) || {};
  const mb = cache.models.find((x) => x.slug === b) || {};
  return (ma.priority ?? 999) - (mb.priority ?? 999) || a.localeCompare(b);
});

if (slugs.length === 0) {
  console.error("sync-cache: no usable slugs in cache");
  process.exit(0);
}

// ---- 2. Build the desired models block ----
const desired = {};
for (const slug of slugs) {
  desired[slug] = {
    name: `${slug} (Business)`,
    limit: { context: 272000, output: 128000 },
    modalities: { input: ["text", "image"], output: ["text"] },
  };
}

// ---- 3. Compare with current file ----
if (!existsSync(CONFIG_PATH)) {
  console.error(`sync-cache: no config at ${CONFIG_PATH}`);
  process.exit(1);
}
const raw = readFileSync(CONFIG_PATH, "utf8");

// Detect JSONC by stripping comments + trailing commas before JSON.parse.
// We don't rewrite the file as JSON; we only do textual surgery for the
// provider.<name>.models block. Keeps comments and surrounding formatting.
function stripJsonc(src) {
  let out = "";
  let i = 0;
  let inStr = false;
  let quote = "";
  while (i < src.length) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < src.length) { out += src[i + 1]; i += 2; continue; }
      if (c === quote) inStr = false;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; out += c; i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

const pure = stripJsonc(raw);
const cfg = JSON.parse(pure);

const current = cfg.provider?.[PROVIDER] || null;
const currentModels = current?.models || {};
const currentSlugs = Object.keys(currentModels);

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  for (const x of a) if (!sb.has(x)) return false;
  return true;
}

if (sameSet(currentSlugs, slugs)) {
  console.log(JSON.stringify({ status: "unchanged", count: slugs.length, path: CONFIG_PATH }));
  process.exit(0);
}

// ---- 4. Rewrite only the provider block in the file ----
// We rebuild the file by:
//   - re-serializing a minimal copy
//   - splicing the new block back into the original JSONC at the exact
//     position of `provider.chatgpt.models`
// Easier alternative: keep everything else verbatim and replace the models
// block via a regex-friendly region. We do it by:
//   1. compute the slice boundaries of `provider.chatgpt` in the JSONC
//   2. replace it with the rebuilt block
//
// For safety with the formatting quirks of JSONC we always preserve the
// indent style of the existing file by sampling indentation from the line
// containing `provider`.

function detectIndent(src) {
  const m = src.match(/^[ \t]+(?=[^\s])/m);
  if (!m) return "  ";
  const prefix = m[0];
  if (prefix.includes("\t")) return "\t";
  return " ".repeat(prefix.length);
}
const indent = detectIndent(raw);

function renderModelsBlock(models, baseIndent) {
  const lines = ["{"];
  const keys = Object.keys(models);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const m = models[k];
    const last = i === keys.length - 1;
    lines.push(`${baseIndent}"${k}": {`);
    lines.push(`${baseIndent}  "name": ${JSON.stringify(m.name)},`);
    lines.push(`${baseIndent}  "limit": { "context": ${m.limit.context}, "output": ${m.limit.output} },`);
    lines.push(`${baseIndent}  "modalities": { "input": ${JSON.stringify(m.modalities.input)}, "output": ${JSON.stringify(m.modalities.output)} }`);
    lines.push(`${baseIndent}}${last ? "" : ","}`);
  }
  lines.push(`${baseIndent.slice(0, baseIndent.length - (baseIndent.length > 2 ? 2 : baseIndent.length))}}`);
  return lines.join("\n");
}

function replaceProvider(rawText, providerName, newProviderObj) {
  // Find the provider's key at whatever indent level it's at.
  // We capture the leading indent so the replacement is inserted with the
  // matching outer indent. Inner indents are derived as outerIndent + step.
  const re = new RegExp(`(^|\\n)([ \\t]*)"${providerName}"\\s*:\\s*\\{`);
  const m = re.exec(rawText);
  if (!m) return null;
  const outerIndent = m[2];
  const step = "  "; // assume 2-space step; sample below if we find better evidence

  // Walk braces from the opening `{` of this provider object.
  const startBrace = m.index + m[0].length - 1; // points to '{'
  let depth = 0;
  let i = startBrace;
  let inStr = false, quote = "";
  while (i < rawText.length) {
    const c = rawText[i];
    if (inStr) {
      if (c === "\\") { i += 2; continue; }
      if (c === quote) inStr = false;
      i++; continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; i++; continue; }
    // skip line comments loosely (we don't try to be perfect here, JSONC comments
    // inside strings are rare and we only insert at this exact scope).
    if (c === "/" && rawText[i + 1] === "/") {
      while (i < rawText.length && rawText[i] !== "\n") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { i++; break; } }
    i++;
  }
  const endBrace = i - 1;
  // Now we own rawText.slice(startBrace, i) — the provider object body.

  // Build a fresh provider object that preserves baseURL/options but replaces models.
  const preserved = { ...newProviderObj };
  preserved.models = newProviderObj.models;

  // Render the new provider block with stable JSON (no comments inside)
  // using indent sized as outerIndent + step. We rebuild with a custom dumper
  // so each line carries the correct prefix.
  function dump(obj, prefix) {
    const lines = [];
    const innerPrefix = prefix + step;
    const keys = Object.keys(obj);
    if (keys.length === 0) return "{}";
    lines.push("{");
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const v = obj[k];
      const last = i === keys.length - 1;
      const comma = last ? "" : ",";
      if (v && typeof v === "object" && !Array.isArray(v)) {
        lines.push(`${innerPrefix}${JSON.stringify(k)}: ${dump(v, innerPrefix)}${comma}`);
      } else {
        lines.push(`${innerPrefix}${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`);
      }
    }
    lines.push(`${prefix}}`);
    return lines.join("\n");
  }
  const replacement = dump(preserved, outerIndent);

  // Make it match the file's line endings style by normalizing.
  const fileLE = rawText.includes("\r\n") ? "\r\n" : "\n";
  const replacementLE = replacement.replace(/\n/g, fileLE);

  return rawText.slice(0, startBrace) + replacementLE + rawText.slice(endBrace + 1);
}

const nextCfg = JSON.parse(JSON.stringify(cfg));
if (!nextCfg.provider) nextCfg.provider = {};
if (!nextCfg.provider[PROVIDER]) nextCfg.provider[PROVIDER] = {};
nextCfg.provider[PROVIDER].models = desired;

// Touch `.options` only if missing — don't overwrite user config.
if (cfg.provider?.[PROVIDER]?.options?.baseURL) {
  nextCfg.provider[PROVIDER].options = cfg.provider[PROVIDER].options;
}

const newRaw = replaceProvider(raw, PROVIDER, nextCfg.provider[PROVIDER]);
if (newRaw == null) {
  console.error(`sync-cache: provider '${PROVIDER}' not found in config`);
  process.exit(1);
}

// Validate the new file as JSONC-roundtrip.
try {
  JSON.parse(stripJsonc(newRaw));
} catch (e) {
  console.error("sync-cache: generated file is invalid JSONC:", e.message);
  process.exit(2);
}

if (!DO_WRITE) {
  console.log(JSON.stringify({ status: "dry-run", added: slugs.length, removed: currentSlugs.length }));
  process.exit(0);
}

writeFileSync(CONFIG_PATH, newRaw, "utf8");
console.log(JSON.stringify({
  status: "written",
  path: CONFIG_PATH,
  before: currentSlugs.length,
  after: slugs.length,
  added: slugs.filter((s) => !currentSlugs.includes(s)),
  removed: currentSlugs.filter((s) => !slugs.includes(s)),
}));
