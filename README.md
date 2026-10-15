# @jaralabs/codex-bridge

> Use your ChatGPT Business / Team / Plus subscription from OpenCode instead
> of paying for the OpenAI API.

`codex-bridge` runs an OpenAI-compatible HTTP server on `127.0.0.1:11434` that
forwards chat-completion requests to the ChatGPT Responses API
(`https://chatgpt.com/backend-api/codex/responses`) using the OAuth session in
`~/.codex/auth.json`. Your OpenCode prompts consume your subscription credits
— not the OpenAI API balance.

The bridge is a thin, durable proxy:

* No dependency on the Codex CLI at runtime. (The CLI rejects ChatGPT Plus
  models when invoked directly; the bridge speaks the same wire format
  itself.)
* Auto-refreshes the access token via `https://auth.openai.com/oauth/token`
  when the API returns 401, and persists the new tokens to `auth.json`.
* Wraps every upstream call in retry-with-jitter and a circuit breaker, so
  transient 429/5xx errors do not bubble to OpenCode.
* Probes the upstream API at boot and persists the wire shape to
  `~/.codex/bridge_capabilities.json`. A drift on the next boot (model
  rename, missing event, status flip) is logged as a warning.
* Exposes `/v1/health` for in-process resilience metrics (requests, retries,
  circuit state).

## Why

If you have a ChatGPT Business / Team / Plus plan, the OpenAI API and the
ChatGPT web subscription are billed separately. You can use the Codex CLI /
web App today with the subscription. `codex-bridge` exposes the same models
over an OpenAI-compatible HTTP surface so OpenCode (and any other OpenAI
client like Claude Code, Cline, aider) can use them without an API key.

## Install

```bash
npm install -g @jaralabs/codex-bridge
```

Requires:

* Node.js 20 or newer.
* The OpenAI Codex CLI installed and logged in **once** with `codex login`
  on a machine with the ChatGPT Business / Team / Plus session. The bridge
  reads `~/.codex/auth.json` for the OAuth tokens. After the first login,
  the CLI is no longer required at runtime.

## Wire it into OpenCode

There are two pieces: the bridge running on `127.0.0.1:11434`, and the
OpenCode plugin that registers the `chatgpt` provider plus the default MCP
servers.

### 1. Run the bridge

```bash
codex-bridge start    # sync models + start HTTP server in background
codex-bridge status   # is it up?
codex-bridge logs     # tail the server log
codex-bridge stop     # kill the server
```

Other useful commands:

```bash
codex-bridge sync     # only sync the model list (no server)
```

### 2. Install the OpenCode plugin

Copy or symlink `lib/plugin.ts` to `~/.config/opencode/plugins/codex-bridge.ts`:

```bash
mkdir -p ~/.config/opencode/plugins
ln -s "$(npm root -g)/@jaralabs/codex-bridge/lib/plugin.ts" \
       ~/.config/opencode/plugins/codex-bridge.ts
```

The plugin:

* Registers the `chatgpt` provider pointing at `http://127.0.0.1:11434/v1`.
* Adds the live model list from `~/.codex/models_cache.json`.
* Registers the default MCP servers (Doop, codegraph, codegraph-fe, angecom).
  Disable per-instance with `CODEX_BRIDGE_DISABLE_<NAME>=1`.
* Seeds a V2 permission policy: read-only tools are `allow`, anything that
  mutates state is `ask`, mirroring the ChatGPT Plus UX.

Restart OpenCode after installing the plugin so it picks it up.

### 3. Pick a model

In OpenCode, choose one of the `chatgpt/*` models from the picker and chat
normally. Tool calls (Doop, codegraph, etc.) round-trip through the bridge
and trigger the OpenCode approval prompt when the policy says `ask`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/v1/models` | List the ChatGPT Plus models available in your plan |
| `POST` | `/v1/chat/completions` | OpenAI-style chat completions (streaming or JSON) |
| `GET` | `/v1/tools` | List registered MCP tools the bridge will advertise to the model |
| `POST` | `/v1/tools` | Register a list of MCP tools (used by the OpenCode plugin on session start) |
| `DELETE` | `/v1/tools` | Clear the registry |
| `GET` | `/v1/health` | Resilience metrics: requests, successes, failures, retries, circuit state |
| `GET` | `/healthz` | Liveness probe (always returns `{ ok: true }`) |

## Tool-call flow

1. OpenCode sends `POST /v1/chat/completions` with `messages` and optionally
   `tools=[]`.
2. The bridge translates Chat Completions into the OpenAI Responses API wire
   format. If `tools` is missing, the registered MCP tools are rendered into
   a Plus-style system block describing what the model can call.
3. The bridge POSTs to `chatgpt.com/backend-api/codex/responses` with the
   current access token. The response is an SSE stream of
   `response.output_text.delta` / `response.function_call_arguments.delta` /
   `response.completed` events.
4. The bridge streams OpenAI-style chunks back: `delta.content` for text and
   `delta.tool_calls[]` for tool calls. Tool calls carry an OpenAI-shaped
   `tool_call_id` so the AI SDK can match them on the next round-trip.
5. OpenCode runs the tool against the real MCP server and sends a follow-up
   request with `role: "tool"` messages. The bridge translates those into
   `function_call_output` items and re-issues.
6. Loop until the model returns no more tool calls.

## Tests

```bash
npm test              # smoke (server up, /healthz, /v1/models, chat)
npm run test:tools    # tool transport, registry, multi-turn loop
npm run test:resilience  # retry, circuit breaker, metrics (pure unit)
npm run test:smoke    # live integration test against the real ChatGPT API
                       # (requires ~/.codex/auth.json on the machine)
```

The `test:smoke` script is what the GitHub Actions daily cron runs to catch
wire-shape drift the day OpenAI changes something. Set
`CODEX_BRIDGE_SKIP_LIVE=1` to skip the network call in air-gapped CI.

## CI

The GitHub Actions workflow at `.github/workflows/publish.yml` has three
jobs:

* **test**: resilience unit tests, type-check the OpenCode plugin, and
  `node --check` every ESM source file.
* **smoke**: writes `CODEX_AUTH_JSON` to `~/.codex/auth.json` and runs
  `test:smoke.mjs` against the real ChatGPT API. Runs on push to main and
  on a daily cron. Skipped silently when the secret is missing, so a
  private repo without the secret can still build.
* **publish**: on push to main, bumps the package to npm via **OpenID
  Connect Trusted Publishing** (no NPM_TOKEN secret). The trusted publisher
  is configured on the package itself
  (`https://www.npmjs.com/package/@jaralabs/codex-bridge` → Settings →
  Trusted Publishers → `jaralabs/codex-bridge` / `publish.yml`).

The publish step only uploads a new version when `package.json`'s version
differs from the latest on npm, so doc and test commits on main are no-ops.

## How it works

```
┌──────────┐        HTTP (OpenAI-compatible)        ┌────────────────┐
│ OpenCode │ ──────────────────────────────────────▶ │ codex-bridge   │
│  + MCP   │ ◀────────────────────────────────────── │ 127.0.0.1:11434│
└──────────┘                                         └────────────────┘
                                                          │
                                       HTTPS + OAuth       ▼
                                                  ┌─────────────────┐
                                                  │ chatgpt.com/    │
                                                  │ backend-api/    │
                                                  │ codex/responses │
                                                  └─────────────────┘
```

## License

MIT.
