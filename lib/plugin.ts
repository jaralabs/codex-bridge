// codex-bridge OpenCode plugin template.
//
// Install: copy this file to ~/.config/opencode/plugins/codex-bridge-models.ts
//   or run `codex-bridge install-plugin` (TODO).
//
// Why a plugin: opencode 2.x doesn't hot-reload provider models when opencode.jsonc
// changes on disk for short-lived CLI invocations like `opencode run`. In a
// long-lived TUI server, opencode does reload, and the plugin on `session.created`
// is purely belt-and-suspenders.
//
// The plugin reads ~/.codex/models_cache.json and writes the resulting model list
// into cfg.provider.chatgpt.models. On TUI restart the change will already be
// present in opencode.jsonc thanks to lib/sync-cache.mjs running from
// `codex-bridge start`, so this hook is mostly a no-op.

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const CODEX_HOME = process.env.CODEX_HOME || join(process.env.HOME || "/tmp", ".codex")
const CACHE = join(CODEX_HOME, "models_cache.json")
const PROVIDER_ID = "chatgpt"

const VISIBLE = new Set(["list", "default", null, undefined])

function readCache(): string[] {
  if (!existsSync(CACHE)) return []
  try {
    const cache = JSON.parse(readFileSync(CACHE, "utf8"))
    if (!Array.isArray(cache.models)) return []
    return cache.models
      .filter((m: any) => VISIBLE.has(m.visibility ?? null))
      .filter((m: any) => m.supported_in_api !== false)
      .map((m: any) => m.slug)
      .filter((s: unknown): s is string => typeof s === "string" && s.length > 0)
      .sort()
  } catch {
    return []
  }
}

function buildModels(slugs: string[]): Record<string, any> {
  const out: Record<string, any> = {}
  for (const slug of slugs) {
    out[slug] = {
      name: `${slug} (Business)`,
      limit: { context: 272000, output: 128000 },
      modalities: { input: ["text", "image"], output: ["text"] },
    }
  }
  return out
}

function mergeModels(provider: any, slugs: string[]): void {
  if (!provider) return
  const desired = buildModels(slugs)
  const current = (provider.models ?? {}) as Record<string, unknown>
  let same = Object.keys(current).length === slugs.length
  if (same) {
    const curSet = new Set(Object.keys(current))
    for (const s of slugs) if (!curSet.has(s)) { same = false; break }
  }
  if (!same) provider.models = desired
}

const CodexBridgeModelsPlugin = {
  id: "codex-bridge-models",
  async setup(_ctx: unknown) {
    return {
      config: async (cfg: any) => {
        const slugs = readCache()
        if (slugs.length === 0) return
        if (!cfg.provider) cfg.provider = {}
        if (!cfg.provider[PROVIDER_ID]) {
          cfg.provider[PROVIDER_ID] = {
            npm: "@ai-sdk/openai-compatible",
            name: "ChatGPT Business (codex-bridge)",
            options: { baseURL: "http://127.0.0.1:11434/v1" },
            models: {},
          }
        }
        mergeModels(cfg.provider[PROVIDER_ID], slugs)
      },
      event: async ({ event }: { event: { type?: string } }) => {
        if (event?.type === "session.created") {
          // Optional: re-sync at session start. The on-disk JSON file is already
          // kept up to date by lib/sync-cache.mjs when codex-bridge start runs.
        }
      },
    }
  },
}

export default CodexBridgeModelsPlugin
export { CodexBridgeModelsPlugin }
