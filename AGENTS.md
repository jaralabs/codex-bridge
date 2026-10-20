# codex-bridge / agent notes

> **Disclaimer.** This project is not affiliated with, endorsed by, or
> sponsored by OpenAI. It reuses the OAuth session in
> `~/.codex/auth.json` (written by the official Codex CLI) and speaks the
> same upstream endpoint (`chatgpt.com/backend-api/codex/responses`) the
> CLI itself uses. The endpoint is not part of any published OpenAI API
> and can change without notice. Use it for your own account; do not sell
> it or redistribute access.

This file tells an OpenCode agent (or a human) how the bridge is wired so
that OpenCode behaves as if ChatGPT Plus were running natively.

## What is here

- `lib/server.mjs` — HTTP server. Endpoints:
  - `GET  /v1/models` — list the ChatGPT Plus models from
    `~/.codex/models_cache.json`.
  - `POST /v1/chat/completions` — OpenAI-compatible chat completions,
    streaming or JSON. Translates Chat Completions into the OpenAI
    Responses API wire format. Multi-turn tool calls round-trip via
    `function_call_output` items.
  - `GET  /v1/tools` / `POST /v1/tools` / `DELETE /v1/tools` — registry
    of MCP tool metadata the bridge advertises to the model.
  - `GET  /v1/health` — resilience metrics: requests, successes,
    failures, retries, circuit state.
  - `GET  /healthz` — liveness probe.
- `lib/auth.mjs` — load and refresh the OAuth tokens in
  `~/.codex/auth.json`. Caches for 30s and refreshes via
  `https://auth.openai.com/oauth/token` when the API returns 401.
- `lib/resilience.mjs` — retry with exponential backoff + full jitter,
  circuit breaker, and in-memory metrics. Wraps the upstream
  `fetch` in `withResilience()`.
- `lib/capabilities.mjs` — boot-time probe. Sends a minimal Responses
  API request, persists the result to
  `~/.codex/bridge_capabilities.json`, and warns on drift from the
  previous probe.
- `lib/tools-registry.mjs` — in-memory MCP tool registry. The OpenCode
  plugin registers tools here on session start, and the server
  injects them into the system prompt when the request has no
  explicit `tools` array.
- `lib/reasoning.mjs` — maps a client `reasoning_effort` onto the
  efforts the upstream Responses API accepts (`none`, `minimal`, `low`,
  `medium`, `high`, `xhigh`, `max`). Unknown values are dropped, so a
  level the upstream rejects never reaches it.
- `lib/pi-models.mjs` — generates the `chatgpt` provider block for a Pi
  agent directory's `models.json`, derived from the Codex model cache.
  Other providers in the file are preserved.
- `lib/plugin.ts` — OpenCode plugin. Registers the `chatgpt` provider,
  default MCP servers (Doop, codegraph, codegraph-fe, angecom), and a
  V2 permission policy that mirrors the ChatGPT Plus UX.
- `lib/sync-cache.mjs` — pulls the model list from
  `~/.codex/models_cache.json` into `opencode.jsonc`.
- `bin/codex-bridge` — CLI: `start`, `stop`, `status`, `sync`, `logs`.
- `bin/codex-bridge-service` — foreground launcher for the systemd
  unit. Resolves the Node runtime and the package at every start, writes
  the PID file the CLI uses, and refreshes the Pi model list before the
  server comes up.
- `install/codex-bridge.service` — systemd user unit template.
- `install/install-service.sh` — installs the wrapper and the unit,
  enables the service, turns on linger, and waits for the port to
  answer. `uninstall` removes both.

## Run it as a service

```bash
install/install-service.sh            # install + enable + start
systemctl --user status codex-bridge  # is it up?
journalctl --user -u codex-bridge -f  # tail the logs
install/install-service.sh uninstall  # remove it
```

The CLI still works against a systemd-managed instance: `status` and
`stop` treat the port as the source of truth, not the PID file.

## Wire it into Pi

```bash
node lib/pi-models.mjs   # write <agent-dir>/models.json
codex-bridge sync        # same, plus the OpenCode model list
```

Pi picks the provider up as `chatgpt/<model>`. The service runs the same
sync at every start, so the model list follows the Codex cache.

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
`doop`, `codegraph`, `codegraph-fe`, and `angecom` (if present) under
`cfg.mcp.servers` (skip any with `CODEX_BRIDGE_DISABLE_<NAME>=1`), and
seeds `cfg.permissions` with the V2 array shape:

```jsonc
[
  { "action": "read", "resource": "*", "effect": "allow" },
  { "action": "glob", "resource": "*", "effect": "allow" },
  { "action": "doop_get_frame", "resource": "*", "effect": "allow" },
  // ... more allow rules for read-only MCP tools
  { "action": "*", "resource": "*", "effect": "ask" }
]
```

The last rule (wildcard `ask`) catches anything not explicitly
allow-listed. State-changing tools (`edit`, `write`, `bash`, `update_frame`,
`append_frame_html`, etc.) fall through and prompt the user in the TUI.

Environment variables the plugin honors:

- `CODEX_BRIDGE_BASE` — base URL for the provider (default
  `http://127.0.0.1:11434/v1`).
- `CODEX_BRIDGE_DISABLE_DOOP=1` — skip Doop registration.
- `CODEX_BRIDGE_DISABLE_CODEGRAPH=1` — skip codegraph registration.
- `CODEX_BRIDGE_DISABLE_CODEGRAPH_FE=1` — skip codegraph-fe registration.
- `CODEX_BRIDGE_DISABLE_ANGECOM=1` — skip angecom registration.
- `DOOP_MCP_COMMAND` / `DOOP_MCP_ARGS` — override the Doop stdio command.

## Tool-call flow

1. OpenCode sends `POST /v1/chat/completions` with `messages` and
   optionally `tools=[...]`.
2. The server translates Chat Completions into the OpenAI Responses API
   wire format. If `tools` is missing, the registered MCP tools are
   rendered into a Plus-style system block describing what the model
   can call.
3. The server POSTs to `chatgpt.com/backend-api/codex/responses` with
   the current access token. The response is an SSE stream of
   `response.output_text.delta` /
   `response.function_call_arguments.delta` / `response.completed`
   events.
4. The server returns OpenAI-style chunks: `delta.content` for text
   and `delta.tool_calls[]` for tool calls. Each tool call has an
   OpenAI-shaped `tool_call_id` so the AI SDK can match it on the
   follow-up.
5. OpenCode runs the tool against the real MCP server and sends a
   follow-up request with `role: "tool"` messages. The server
   translates those into `function_call_output` items and re-issues.
6. Loop until the model returns no more tool calls.

## Tests

```bash
npm test                 # smoke (server up, /healthz, /v1/models, chat)
npm run test:tools       # tool transport, registry, multi-turn loop
npm run test:resilience  # retry, circuit breaker, metrics (pure unit)
npm run test:reasoning   # reasoning-effort mapping (pure unit)
npm run test:pi-models   # Pi provider generation (pure unit)
npm run test:smoke       # live integration test against the real ChatGPT
                         # API (requires ~/.codex/auth.json)
```

`npm test` and `npm run test:tools` need a running bridge and a real
ChatGPT session. `test:tools` talks to the bridge over HTTP; point it at
another instance with `BASE=http://host:port`.

The resilience and smoke tests run in CI. The daily cron runs `test:smoke`
to detect wire-shape drift the day OpenAI changes something.
