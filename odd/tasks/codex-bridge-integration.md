# codex-bridge: autostart, Pi wiring, live tool tests

Make `codex-bridge` usable as a first-class provider inside Pi / gentle-shell:
a real autostart (not only the manual `devenv` path), a working tool-transport
test suite, and provider wiring that exposes the `chatgpt/*` models to Pi.

## Specs

- S1: "Borralo o sobrescribe el punto 1" — `npm run test:tools` must run against
  the real bridge over HTTP and pass. The current script requires a
  `CODEX_BIN` stub binary and exits with code 2 without it.
- S2: "deberiamos tener un autostart" — the bridge starts automatically without
  the user running `devenv` or `codex-bridge start`, and stays up (restarts on
  failure).
- S3: "ademas deberiamos configurarlo para poder usarlo aca en gentle-shell" —
  the `chatgpt/*` models are selectable as a provider inside Pi / gentle-shell.
- S4: "Ah el autostart esta de manera manual cuando corro devenv" — the manual
  autostart path is `~/scripts/devenv`, which calls `codex-bridge start`. That
  path must keep working after the automatic autostart lands.

## Tasks

| ID | Spec | Route | Commit |
|---|---|---|---|
| T1 | S3 | inline — `lib/reasoning.mjs`, `lib/server.mjs`, unit test | `1d0b605` feat(reasoning): forward reasoning_effort to the Responses API |
| T2 | S1 | inline — `test/test-tools.mjs` rewritten against the live bridge | `ebb951e` test(tools): exercise the tool transport against the live bridge |
| T3 | S2, S4 | inline — `bin/codex-bridge-service`, `install/codex-bridge.service`, `install/install-service.sh` | `aacfaa0` feat(service): run the bridge as a systemd user service |
| T4 | S3 | inline — `lib/pi-models.mjs`, `models.json` for the Pi agent dirs | `6f87e14` feat(pi): expose the bridge as a Pi provider |
| T5 | S2, S3 | inline — README, AGENTS.md, CHANGELOG.md | `docs: document the autostart and the Pi provider wiring` |

Supporting commits: `a7674cf` (handler crash fix + debug headers),
`fb6ca5c` (reasoning mapping: `off` -> `none`, `minimal` kept).

### Slice boundary

The first slice closed at `ebb951e` (477 authored lines) and the second at
`6f87e14` (990 lines). The second slice overran the ~400-line budget because
the Pi wiring needed the bridge code, the generator and its tests together;
the remainder moved to the docs slice.

## Log

- L1: "Vale, veo que tengo algo en integrations que se llama codex-bridge es un
  bridge que tenemos para usar la cuenta de codex business / enterprise de la
  empresa en estas herramientas como open code, gentle-shell y demas, podemos ver
  si funciona?"
- L2: "Borralo o sobrescribe el punto 1, deberiamos tener un autostart, ademas
  deberiamos configurarlo para poder usarlo aca en gentle-shell"
- L3: "Ah el autostart esta de manera manual cuando corro devenv"
- L4: "Vale hagamos commits y publiquemos no?"
- L5: "Esta fallando el smoke por que?" — the CI smoke job failed with
  `token_expired`: the access token inside the `CODEX_AUTH_JSON` secret is
  stale. The smoke test never refreshed, so a 401 ended the run even when
  the refresh token was still good. Fixed in 0.5.1: the smoke test
  refreshes once and retries, and prints how to replace a dead secret.
  The secret itself still has to be re-uploaded when its refresh token
  dies: `gh secret set CODEX_AUTH_JSON < ~/.codex/auth.json`.

### Evidence (L1)

Live check on 2026-10-19 against the running instance (pid 1811433,
`127.0.0.1:11434`, global install 0.4.6 identical to repo HEAD `d9e376c`):

- `GET /healthz` -> `{"ok":true,"port":11434}`
- `GET /v1/health` -> circuit closed, 0 failures
- `GET /v1/models` -> 7 models (`gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`,
  `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`)
- `POST /v1/chat/completions` (JSON + stream) -> HTTP 200
- tool call -> `finish_reason: tool_calls`; follow-up with `role:"tool"` ->
  `finish_reason: stop`
- `npm test` ALL GREEN, `npm run test:resilience` ALL GREEN
- `npm run test:tools` -> exits 2, "Set CODEX_BIN to a stub binary"
- OpenCode lists all 7 `chatgpt/*` models; the plugin symlink is in place at
  `~/.config/opencode/plugins/codex-bridge.ts`
- No autostart exists outside `~/scripts/devenv` (no systemd unit, no shell hook)
- Pi / gentle-shell has no `models.json`, so the bridge is not reachable from Pi

### Decisions

- The upstream `chatgpt.com/backend-api/codex/responses` endpoint accepts
  `reasoning: {effort}` and echoes it back (verified live with a direct
  request). The bridge drops `reasoning_effort` today, so Pi thinking levels
  would be silently lost — hence T1.
- Pi's `openai-completions` API sends `reasoning_effort`, `stream_options`,
  `tools`, and `max_completion_tokens`. The bridge already tolerates
  everything except `reasoning_effort`.
- The upstream accepts the efforts `none`, `minimal`, `low`, `medium`,
  `high`, `xhigh` and `max`, and rejects `ultra` (which the Codex cache
  lists). The bridge filters unknown efforts instead of forwarding them.
- The systemd unit runs a wrapper instead of the server directly: the Node
  runtime and the package live in versioned directories, and a hardcoded
  path breaks on the next upgrade.
- The wrapper lives in `~/.local/bin`, not in the workspace checkout, so the
  service does not depend on a mounted workspace at boot.
- The manual autostart (`~/scripts/devenv` -> `codex-bridge start`) keeps
  working: `start` sees the port already serving and reports it.
- The Pi model list is generated from `~/.codex/models_cache.json` and
  written at every service start, so it follows the Codex session.

### Evidence (L2, L3)

- `npm run test:tools` -> ALL GREEN against the running service (registry,
  injection, explicit tools, multi-turn loop, streamed tool call).
- `npm test`, `npm run test:resilience`, `npm run test:reasoning`,
  `npm run test:pi-models` -> ALL GREEN.
- `systemctl --user status codex-bridge.service` -> active, enabled;
  `loginctl show-user $USER --property=Linger` -> `Linger=yes`.
- Crash recovery: `kill -9` of the main PID -> the unit restarted and the
  port answered again.
- `pi --list-models` -> the 7 `chatgpt/*` models with their context
  windows.
- `pi -p --model chatgpt/gpt-6-luna "Reply with exactly: PI_BRIDGE_OK"` ->
  `PI_BRIDGE_OK`.
- `pi -p --model chatgpt/gpt-6-luna "Use the bash tool to run: echo
  HELLO_FROM_TOOL"` -> `HELLO_FROM_TOOL` (tool call round-trip through Pi).
- `opencode models` still lists the 7 `chatgpt/*` models.
