#!/usr/bin/env node
// pi-models.mjs: write the codex-bridge provider into a Pi agent
// directory's models.json.
//
// Pi reads `<agent-dir>/models.json` for "compatible endpoints": an
// OpenAI-compatible base URL plus the models it exposes. The bridge is
// exactly that, so the same ChatGPT Business plan that OpenCode uses
// becomes a provider inside Pi / gentle-shell.
//
// The model list is derived from `~/.codex/models_cache.json`, so it
// follows whatever the Codex CLI logged in with. Existing content in
// models.json is preserved: only the `chatgpt` provider block is
// replaced.
//
// Usage:
//   node lib/pi-models.mjs [--agent-dir <dir>] [--codex-home <dir>] [--print] [--no-write]
//
// With no --agent-dir the script writes to every agent directory it can
// find: $PI_CODING_AGENT_DIR, $GENTLE_PI_AGENT_HOME and ~/.pi/agent.

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_ID = "chatgpt";
const PROVIDER_NAME = "ChatGPT Business (codex-bridge)";
const DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1";
const DEFAULT_CONTEXT_WINDOW = 272000;
const DEFAULT_MAX_TOKENS = 128000;

// The upstream Responses API accepts these efforts and rejects
// everything else, including the "ultra" level the Codex cache lists.
const THINKING_LEVEL_MAP = {
  off: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return fallback;
}
function hasFlag(name) { return args.includes(`--${name}`); }

const CODEX_HOME = flag("codex-home", join(homedir(), ".codex"));
const CACHE_PATH = join(CODEX_HOME, "models_cache.json");
const PRINT_ONLY = hasFlag("--print");
const DO_WRITE = !hasFlag("--no-write");

function defaultAgentDirs() {
  const dirs = [];
  for (const dir of [
    process.env.PI_CODING_AGENT_DIR,
    process.env.GENTLE_PI_AGENT_HOME,
    // The agent directory gentle-shell provisions for itself. It is
    // listed explicitly because the systemd unit does not inherit the
    // environment of an interactive gentle-shell session.
    join(homedir(), ".gentle-shell", "agent"),
    join(homedir(), ".pi", "agent"),
  ]) {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

/** Models the bridge exposes, derived from the Codex model cache. */
export function loadModels(codexHome = CODEX_HOME) {
  const cachePath = join(codexHome, "models_cache.json");
  if (!existsSync(cachePath)) return [];
  let cache;
  try {
    cache = JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(cache.models)) return [];

  const visible = ["list", "default", null, undefined];
  return cache.models
    .filter((m) => visible.includes(m.visibility ?? null))
    .filter((m) => m.supported_in_api !== false)
    .filter((m) => m.slug)
    .map((m) => ({
      id: m.slug,
      name: `${m.slug} (Business)`,
      api: "openai-completions",
      reasoning: true,
      thinkingLevelMap: { ...THINKING_LEVEL_MAP },
      input: ["text", "image"],
      contextWindow: m.context_window || DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The provider block Pi needs to talk to the bridge. */
export function buildProvider(models, baseUrl = DEFAULT_BASE_URL) {
  return {
    name: PROVIDER_NAME,
    baseUrl,
    api: "openai-completions",
    // The bridge authenticates with the local OAuth session, not with a
    // key. A placeholder satisfies Pi's credential check.
    apiKey: "codex-bridge",
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: true,
      supportsFinishReason: true,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
    // Every model gets the same thinking-level mapping, whatever the
    // caller passed in.
    models: models.map((m) => ({ ...m, thinkingLevelMap: { ...THINKING_LEVEL_MAP, ...(m.thinkingLevelMap || {}) } })),
  };
}

/** Merge the bridge provider into an existing models.json document. */
export function mergeModelsJson(existing, provider) {
  const doc = existing && typeof existing === "object" ? existing : {};
  doc.providers = doc.providers && typeof doc.providers === "object" ? doc.providers : {};
  doc.providers[PROVIDER_ID] = provider;
  return doc;
}

/** Write models.json into one agent directory. Returns a status string. */
export function writeAgentDir(agentDir, provider) {
  const path = join(agentDir, "models.json");
  let existing = null;
  if (existsSync(path)) {
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`${path} is not valid JSON: ${e.message}`);
    }
  }
  const doc = mergeModelsJson(existing, provider);
  const next = `${JSON.stringify(doc, null, 2)}\n`;
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (next === current) return "unchanged";
  if (DO_WRITE) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(path, next);
  }
  return DO_WRITE ? "written" : "would write";
}

function main() {
  const models = loadModels(CODEX_HOME);
  if (models.length === 0) {
    console.error(`pi-models: no usable models in ${CACHE_PATH}`);
    process.exit(0);
  }
  const provider = buildProvider(models);

  if (PRINT_ONLY) {
    console.log(JSON.stringify({ providers: { [PROVIDER_ID]: provider } }, null, 2));
    return;
  }

  const dirs = hasFlag("--agent-dir") ? [flag("--agent-dir")] : defaultAgentDirs();
  for (const dir of dirs) {
    try {
      const status = writeAgentDir(dir, provider);
      console.log(`pi-models: ${status} ${join(dir, "models.json")}`);
    } catch (e) {
      console.error(`pi-models: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

// Run the CLI only when this file is the entry point. Compare real
// paths: the package is often reached through a symlink (mise keeps
// `lts` pointing at the active version), and `import.meta.url` reports
// the resolved path.
function isEntryPoint() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main();
}
