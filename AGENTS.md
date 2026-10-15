# codex-bridge / agent notes

This file tells an OpenCode agent (or a human) how to wire the bridge so
that OpenCode behaves as if ChatGPT Plus were running natively.

## What is here

- `lib/server.mjs` — HTTP server: `/v1/models`, `/v1/tools` (registry),
  `/v1/chat/completions` (OpenAI-compatible, with multi-turn tool support
  and Streamable SSE).
- `lib/tools-registry.mjs` — in-memory tool registry. The OpenCode plugin
  registers MCP tools here on session start, and the server injects them
  into the system prompt when the request has no explicit `tools` array.
- `lib/plugin.ts` — OpenCode plugin. Registers the `chatgpt` provider,
  defaults MCP servers (Doop, codegraph), and seeds the permission policy
  so MCP tools require `ask` (Plus behavior).
- `lib/sync-cache.mjs` — pulls the model list from
  `~/.codex/models_cache.json` into `opencode.jsonc`.
- `bin/codex-bridge` — CLI: `start`, `stop`, `status`, `sync`, `logs`.

## Install the plugin

Pick one:

```bash
# Option A: symlink (recommended during development)
mkdir -p ~/.config/opencode/plugins
ln -s "$(pwd)/lib/plugin.ts" ~/.config/opencode/plugins/codex-bridge.ts

# Option B: copy
cp lib/plugin.ts ~/.config/opencode/plugins/codex-bridge.ts
```

OpenCode picks up plugins from `~/.config/opencode/plugins/*.ts` on
start. After installing, restart the TUI.

## Configure the provider and MCP

The plugin writes the `chatgpt` provider into `cfg.provider`, registers
`doop`, `codegraph`, and `codegraph-fe` under `cfg.mcp.servers` (skip
any with `CODEX_BRIDGE_DISABLE_<NAME>=1`), and seeds `cfg.permission`
with `"*": "ask"` plus read-only allow rules.

Environment variables the plugin honors:

- `CODEX_BRIDGE_BASE` — base URL for the provider (default
  `http://127.0.0.1:11434/v1`).
- `CODEX_BRIDGE_DISABLE_DOOP=1` — skip Doop registration.
- `CODEX_BRIDGE_DISABLE_CODEGRAPH=1` — skip codegraph registration.
- `CODEX_BRIDGE_DISABLE_CODEGRAPH_FE=1` — skip codegraph-fe registration.
- `DOOP_MCP_COMMAND` / `DOOP_MCP_ARGS` — override the Doop stdio command.

## Tool-call flow

1. OpenCode sends `POST /v1/chat/completions` with `messages` and
   optionally `tools=[...]`.
2. If `tools` is missing, the server prepends a Plus-style system block
   listing the tools the plugin registered via `POST /v1/tools`.
3. The server invokes `codex exec --json --enable tools --tools <tmp>`.
4. If codex emits an `item.tool_call`, the server returns
   `finish_reason="tool_calls"` with `message.tool_calls` (OpenAI shape).
5. OpenCode runs the tool against the real MCP server and sends a
   follow-up request with the prior assistant message plus
   `role: "tool"` messages. The server passes those into codex on the
   next `codex exec` call.
6. Loop until the model returns no tool calls.

## Permission model

The plugin sets `permission["*"] = "ask"` so any tool the model invokes
prompts the user in the OpenCode TUI. Read-only tools (`read`, `glob`,
`grep`, `list_mcp_resources`, `read_mcp_resource`) are allow-listed to
match Plus UX. Anything the user has already configured in
`opencode.jsonc` wins.

## Tests

```bash
npm test          # smoke (server up, /healthz, /v1/models, chat)
npm run test:tools  # tool transport, registry, multi-turn loop
```

The tool tests need a stub `codex` binary on `CODEX_BIN`. See
`/tmp/opencode/stub-codex2/codex` for an example that reads scenario
from the prompt and emits JSONL events.
