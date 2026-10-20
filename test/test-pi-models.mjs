#!/usr/bin/env node
// Unit tests for the Pi models.json generator.
//
// Pure unit: no network, no Pi process. It checks the provider block
// Pi needs and that an existing models.json keeps its other providers.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadModels, buildProvider, mergeModelsJson } from "../lib/pi-models.mjs";

let failed = 0;
function check(name, ok, extra) {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failed++;
  console.log(`[${tag}] ${name}`, extra ?? "");
}

// --- The provider block Pi needs ---
const models = [
  { id: "gpt-6-luna", name: "gpt-6-luna (Business)", reasoning: true, contextWindow: 272000, maxTokens: 128000 },
];
const provider = buildProvider(models);

check("provider points at the bridge", provider.baseUrl === "http://127.0.0.1:11434/v1", provider.baseUrl);
check("provider uses the OpenAI-compatible API", provider.api === "openai-completions");
check("provider has a placeholder api key", typeof provider.apiKey === "string" && provider.apiKey.length > 0);
check("provider declares reasoning support", provider.compat.supportsReasoningEffort === true);
check("provider disables store", provider.compat.supportsStore === false);
check("provider carries the models", provider.models.length === 1);

// --- Thinking levels map onto efforts the upstream accepts ---
const levelMap = provider.models[0].thinkingLevelMap;
check("off maps to none", levelMap.off === "none");
check("minimal maps to minimal", levelMap.minimal === "minimal");
check("max maps to max", levelMap.max === "max");
check("no level maps to ultra", !Object.values(levelMap).includes("ultra"));

// --- Merging keeps the rest of the document ---
const existing = {
  $schema: "https://pi.dev/schemas/models.schema.json",
  providers: {
    ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "qwen" }] },
  },
};
const merged = mergeModelsJson(existing, provider);
check("existing providers survive", !!merged.providers.ollama && merged.providers.ollama.models[0].id === "qwen");
check("the bridge provider is added", !!merged.providers.chatgpt);
check("the schema field survives", merged.$schema === existing.$schema);

// --- Merging into an empty document works too ---
const fresh = mergeModelsJson(null, provider);
check("an empty document still gets providers", !!fresh.providers.chatgpt);
check("an empty document has no leftovers", Object.keys(fresh.providers).length === 1);

// --- The model list comes from the Codex cache ---
const cacheDir = mkdtempSync(join(tmpdir(), "codex-bridge-pi-"));
try {
  writeFileSync(
    join(cacheDir, "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "gpt-6-luna", visibility: "list", supported_in_api: true, context_window: 272000 },
        { slug: "gpt-6.1-sol", visibility: "list", supported_in_api: true, context_window: 500000 },
        { slug: "hidden-model", visibility: "hidden", supported_in_api: true },
        { slug: "review-only", visibility: "list", supported_in_api: false },
      ],
    })
  );
  const loaded = loadModels(cacheDir);
  check("only visible, API-supported models are exposed", loaded.length === 2, loaded.map((m) => m.id).join(","));
  check("the context window comes from the cache", loaded.find((m) => m.id === "gpt-6.1-sol").contextWindow === 500000);
  check("every model declares a context window", loaded.every((m) => m.contextWindow > 0));
  check("every model declares an output limit", loaded.every((m) => m.maxTokens > 0));
  check("costs are zero (subscription, not API)", loaded.every((m) => m.cost.input === 0 && m.cost.output === 0));
} finally {
  rmSync(cacheDir, { recursive: true, force: true });
}

// --- A missing cache yields no models instead of crashing ---
check("a missing cache yields no models", loadModels("/nonexistent/codex/home").length === 0);

if (failed > 0) {
  console.error(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nALL GREEN");
