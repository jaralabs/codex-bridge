// codex-bridge OpenCode plugin.
//
// Goals:
//   1. Register the chatgpt provider pointing at the local bridge
//      (http://127.0.0.1:11434/v1), pulling the live model list from
//      ~/.codex/models_cache.json.
//   2. Register MCP servers (Doop, codegraph, etc.) so they show up in
//      OpenCode's tool list when the user picks a ChatGPT model.
//   3. Inject a permission policy (V2 schema) that mirrors ChatGPT Plus:
//      every MCP tool is `ask`, read-only built-in tools are `allow`.
//
// Install: copy this file to ~/.config/opencode/plugins/codex-bridge.ts
// (or symlink). The bridge does NOT auto-install; that is the user's call.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const CODEX_HOME = process.env.CODEX_HOME || join(process.env.HOME || "/tmp", ".codex")
const CACHE = join(CODEX_HOME, "models_cache.json")
const PROVIDER_ID = "chatgpt"
const BRIDGE_BASE = process.env.CODEX_BRIDGE_BASE || "http://127.0.0.1:11434/v1"

const VISIBLE = new Set(["list", "default", null, undefined])

// MCP servers we always want available, even if the user has not added
// them via `opencode mcp add`. The user can disable any of these by
// setting the matching env var to "1":
//   CODEX_BRIDGE_DISABLE_DOOP=1
//   CODEX_BRIDGE_DISABLE_CODEGRAPH=1
//   CODEX_BRIDGE_DISABLE_CODEGRAPH_FE=1
//   CODEX_BRIDGE_DISABLE_ANGECOM=1
function defaultMcpServers(): Record<string, any> {
  const out: Record<string, any> = {}
  if (process.env.CODEX_BRIDGE_DISABLE_DOOP !== "1") {
    const cmd = process.env.DOOP_MCP_COMMAND || "npx"
    const args = (process.env.DOOP_MCP_ARGS || "-y @arqora/doop-mcp").split(" ")
    out["doop"] = { type: "local", command: [cmd, ...args] }
  }
  if (process.env.CODEX_BRIDGE_DISABLE_CODEGRAPH !== "1") {
    out["codegraph"] = { type: "local", command: ["codegraph", "mcp"] }
  }
  if (process.env.CODEX_BRIDGE_DISABLE_CODEGRAPH_FE !== "1") {
    out["codegraph-fe"] = { type: "local", command: ["codegraph-fe", "mcp"] }
  }
  if (process.env.CODEX_BRIDGE_DISABLE_ANGECOM !== "1") {
    // The angecom MCP lives outside this repo; only register it if the
    // user has it on disk. This keeps the plugin usable from any cwd.
    const home = process.env.HOME || "/tmp"
    const candidate = join(home, "workspace/angecom/angecom-mcp/dist/index.js")
    if (existsSync(candidate)) {
      out["angecom"] = {
        type: "local",
        command: ["node", candidate],
        cwd: join(home, "workspace/angecom/angecom-mcp"),
      }
    }
  }
  return out
}

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

// V2 permission schema: an array of { action, resource, effect } rules.
// Order matters: the last matching rule wins, so we put broad allow
// rules first, then explicit ask rules for state-changing tools, and
// finally a global "ask" catch-all so anything not listed still prompts.
//
// Read-only tools are allow-listed (Plus UX: reads run silently).
// Anything that mutates state or hits the network prompts the user.
function basePermissionRules(): any[] {
  return [
    // --- Read-only allow rules (built-in) ---
    { action: "read", resource: "*", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "list_mcp_resources", resource: "*", effect: "allow" },
    { action: "read_mcp_resource", resource: "*", effect: "allow" },

    // --- MCP read-only tools (Doop and codegraph both expose several
    //     of these; the <server>_<tool> action pattern matches them). ---
    // We list them explicitly so the saved-approval flow can record
    // each tool separately instead of one broad rule.
    { action: "doop_list_canvases", resource: "*", effect: "allow" },
    { action: "doop_get_guidelines", resource: "*", effect: "allow" },
    { action: "doop_get_reference", resource: "*", effect: "allow" },
    { action: "doop_get_comments", resource: "*", effect: "allow" },
    { action: "doop_get_frame", resource: "*", effect: "allow" },
    { action: "doop_get_frame_screenshot", resource: "*", effect: "allow" },
    { action: "doop_get_linear_issue", resource: "*", effect: "allow" },
    { action: "codegraph_codegraph_explore", resource: "*", effect: "allow" },
    { action: "codegraph-fe_codegraph_explore", resource: "*", effect: "allow" },
    { action: "angecom_confluence_list_folder", resource: "*", effect: "allow" },
    { action: "angecom_jira_get_issue", resource: "*", effect: "allow" },
    { action: "angecom_jira_get_transitions", resource: "*", effect: "allow" },
    { action: "angecom_jira_list_attachments", resource: "*", effect: "allow" },
    { action: "angecom_list_workspaces", resource: "*", effect: "allow" },
    { action: "angecom_list_mcp_resources", resource: "*", effect: "allow" },
    { action: "opencode_list_mcp_resources", resource: "*", effect: "allow" },
    { action: "opencode_read_mcp_resource", resource: "*", effect: "allow" },

    // --- Anything state-changing defaults to ask (Plus behavior). ---
    { action: "*", resource: "*", effect: "ask" },
  ]
}

function mergePermissions(current: any): any[] {
  const base = basePermissionRules()
  if (!Array.isArray(current)) return base
  // User-defined rules win. We keep the base array as a fallback and
  // append the user rules, so the user's specific "allow" overrides
  // our "ask" catch-all at the bottom.
  return [...base, ...current]
}

const CodexBridgePlugin = {
  id: "codex-bridge",
  async setup(_ctx: unknown) {
    return {
      config: async (cfg: any) => {
        // --- Provider ---
        if (!cfg.provider) cfg.provider = {}
        if (!cfg.provider[PROVIDER_ID]) {
          cfg.provider[PROVIDER_ID] = {
            npm: "@ai-sdk/openai-compatible",
            name: "ChatGPT Business (codex-bridge)",
            options: { baseURL: BRIDGE_BASE },
            models: {},
          }
        }
        const slugs = readCache()
        if (slugs.length > 0) {
          mergeModels(cfg.provider[PROVIDER_ID], slugs)
        }

        // --- MCP servers ---
        if (!cfg.mcp) cfg.mcp = {}
        if (!cfg.mcp.servers) cfg.mcp.servers = {}
        const defaults = defaultMcpServers()
        for (const [name, def] of Object.entries(defaults)) {
          if (!cfg.mcp.servers[name]) cfg.mcp.servers[name] = def
        }

        // --- Permission policy (V2 schema) ---
        cfg.permissions = mergePermissions(cfg.permissions)
      },
      event: async ({ event }: { event: { type?: string } }) => {
        if (event?.type === "session.created") {
          // No-op: on-disk config is already kept fresh by lib/sync-cache.mjs.
        }
      },
    }
  },
}

export default CodexBridgePlugin
export { CodexBridgePlugin }
