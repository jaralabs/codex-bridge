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

// ---- 4. Rewrite the provider block, or insert a new one if missing ----
//
// Two cases:
//   (a) `provider.<name>` already exists: rebuild just that block in place,
//       preserving the rest of the file (comments, formatting, sibling keys).
//   (b) `provider.<name>` is absent: append a minimal `provider` object
//       containing only this provider, without disturbing existing keys.
//
// For (b) we use a custom dumper (`dump`) at the top-level prefix so the
// inserted block matches the file's indent style.

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

function detectIndent(src) {
  const m = src.match(/^[ \t]+(?=[^\s])/m);
  if (!m) return "  ";
  const prefix = m[0];
  if (prefix.includes("\t")) return "\t";
  return " ".repeat(prefix.length);
}
const indent = detectIndent(raw);

// Indent step (best-effort; assume 2 if we can't tell).
function dump(obj, prefix, step = "  ") {
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
      lines.push(`${innerPrefix}${JSON.stringify(k)}: ${dump(v, innerPrefix, step)}${comma}`);
    } else {
      lines.push(`${innerPrefix}${JSON.stringify(k)}: ${JSON.stringify(v)}${comma}`);
    }
  }
  lines.push(`${prefix}}`);
  return lines.join("\n");
}

// Append a brand-new top-level `provider` block containing only the requested
// provider. Does not touch existing sibling keys.
//
// Strategy:
//   1. If the file has an empty `provider: {}`, fill it in.
//   2. Otherwise, find the last TOP-LEVEL key line (e.g. `"mcp":`) and place
//      `provider: { ... }` directly after its matching `}`, using the same
//      indent prefix as that top-level key.
function insertProvider(rawText, providerName, providerObj) {
  let body = rawText.replace(/\s+$/, "");
  const fileLE = body.includes("\r\n") ? "\r\n" : "\n";

  // 1. Empty provider block?
  const emptyProviderRE = new RegExp(`(^|\\n)([ \\t]*)"provider"\\s*:\\s*\\{\\s*\\}\\s*\\n?`);
  if (emptyProviderRE.test(body)) {
    const m = emptyProviderRE.exec(body);
    const topIndent = m[2];
    const wrapped = {};
    wrapped[providerName] = providerObj;
    const block = dump(wrapped, topIndent);
    return body.replace(emptyProviderRE, `$1${topIndent}"provider": ${block}\n`);
  }

  // 2. Find the last top-level key (one whose closing `}` is followed by
  //    the final root `}`). We pick it by walking top-level keys backwards.
  //    Each top-level key starts at column indent and ends at the matching
  //    `}`.
  const lines = body.split("\n");
  // Find every top-level key (those whose leading whitespace is the smallest
  // amount on the line). Empirically, the file uses 2-space indent so
  // top-level lines start with 0 spaces (root) or 2 spaces.
  const rootDepthIndent = "  ";
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const m = ln.match(/^(\s*)\"([^\"]+)\"\s*:\s*\{/);
    if (!m) continue;
    if (m[1] === "") continue; // this is the root `{`
    if (m[1] !== rootDepthIndent) continue; // nested, not top level
    last = { line: i, indent: m[1], key: m[2] };
  }
  if (!last) {
    console.error("sync-cache: could not locate any top-level key to insert after");
    return null;
  }

  // Walk from `last.line` forward to find the matching `}` of that key. We
  // count nested braces.
  let depth = 0;
  let endIdx = -1;
  let inS = false;
  let q = "";
  for (let i = last.line; i < lines.length; i++) {
    for (let j = 0; j < lines[i].length; j++) {
      const c = lines[i][j];
      if (inS) {
        if (c === "\\") { j++; continue; }
        if (c === q) inS = false;
        continue;
      }
      if (c === '"' || c === "'") { inS = true; q = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    if (endIdx >= 0) break;
  }
  if (endIdx < 0) {
    console.error("sync-cache: could not find closing brace of last top-level key");
    return null;
  }

  // Rebuild file with the new block inserted after `endIdx`. We MUST add
  // a comma to the previous `}` (which is currently the last sibling of
  // the root) and emit `"provider": { ... }` without a trailing comma
  // because the root `}` will close it.
  const wrapped = {};
  wrapped[providerName] = providerObj;
  const block = dump(wrapped, rootDepthIndent);
  const newLines = lines.slice(0, endIdx + 1);
  // Append a comma to the previous `}` line so the upcoming `"provider":`
  // line is a legal sibling.
  const prev = newLines[newLines.length - 1];
  if (prev !== undefined && prev.includes("}") && !prev.trimEnd().endsWith(",")) {
    newLines[newLines.length - 1] = prev.replace(/}\s*$/, "},");
  }
  newLines.push(`${rootDepthIndent}"provider": ${block}`);
  const tailLines = lines.slice(endIdx + 1);
  newLines.push(...tailLines);
  return newLines.join(fileLE);
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
  const replacement = dump(preserved, outerIndent);

  // Make it match the file's line endings style by normalizing.
  const fileLE = rawText.includes("\r\n") ? "\r\n" : "\n";
  const replacementLE = replacement.replace(/\n/g, fileLE);

  return rawText.slice(0, startBrace) + replacementLE + rawText.slice(endBrace + 1);
}

const nextCfg = JSON.parse(JSON.stringify(cfg));
if (!nextCfg.provider) nextCfg.provider = {};
if (!nextCfg.provider[PROVIDER]) {
  // Case (b): create a minimal provider object from scratch.
  nextCfg.provider[PROVIDER] = {
    npm: "@ai-sdk/openai-compatible",
    name: "ChatGPT Business (codex-bridge)",
    options: { baseURL: "http://127.0.0.1:11434/v1" },
    models: desired,
  };
} else {
  nextCfg.provider[PROVIDER].models = desired;
  // Touch `.options` only if missing — don't overwrite user config.
  if (!nextCfg.provider[PROVIDER].options?.baseURL) {
    nextCfg.provider[PROVIDER].options = { baseURL: "http://127.0.0.1:11434/v1" };
  }
}

const existingProvider = cfg.provider?.[PROVIDER] || null;
let newRaw;
if (existingProvider) {
  newRaw = replaceProvider(raw, PROVIDER, nextCfg.provider[PROVIDER]);
  if (newRaw == null) {
    console.error(`sync-cache: provider '${PROVIDER}' not found in config`);
    process.exit(1);
  }
} else {
  // Append a `provider: { <name>: {...} }` block to the root object.
  newRaw = insertProvider(raw, PROVIDER, nextCfg.provider[PROVIDER]);
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
