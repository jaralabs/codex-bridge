# Changelog

All notable changes to `@jaralabs/codex-bridge` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.1] - 2026-10-19

### Fixed
- The live smoke test gave up on the first 401. A stored `auth.json` (a
  CI secret, a snapshot taken on another machine) carries an access token
  that expires, while the refresh token usually outlives it. The smoke
  test now refreshes once and retries, and says what to do when even the
  refresh token is dead.

## [0.5.0] - 2026-10-19

### Added
- `install/codex-bridge.service` + `install/install-service.sh` — the
  bridge now runs as a systemd user service: it starts at boot (linger)
  and restarts on failure, instead of only coming up when someone runs
  `devenv` or `codex-bridge start` by hand.
- `bin/codex-bridge-service` — foreground launcher for the unit. It
  resolves the Node runtime and the package at every start, so a Node or
  npm upgrade does not break the service, and it refreshes the Pi model
  list before the server comes up.
- `lib/pi-models.mjs` — writes the `chatgpt` provider into a Pi agent
  directory's `models.json`, so Pi and gentle-shell can use the same
  ChatGPT Business plan as OpenCode. Other providers in the file are
  preserved.
- `lib/reasoning.mjs` + `npm run test:reasoning` — the bridge now
  forwards the client's `reasoning_effort` to the upstream Responses API
  as `reasoning: { effort }`. Pi's thinking levels were silently dropped
  before.
- `npm run test:pi-models` — unit tests for the Pi provider generation.
- Debug headers on every chat response: `x-codex-bridge-instructions-len`,
  `x-codex-bridge-tools` and `x-codex-bridge-reasoning` report what
  actually reached the upstream API.

### Fixed
- A rejected promise inside the chat-completions handler escaped the
  route try/catch and killed the whole process. The handler is awaited
  now, so a bad request returns 500 instead of taking the bridge down.
- `npm run test:tools` required a `CODEX_BIN` stub binary from an
  architecture the bridge left behind and exited 2 everywhere. It now
  runs against a live bridge over HTTP and covers the registry, the
  registry injection, explicit tools, and the multi-turn tool loop.

## [0.4.1] - 2026-10-15

### Changed
- README and AGENTS.md rewritten to match the current architecture
  (the v0.4.0 README still described the v0.1.0 design that forwarded
  to the Codex CLI).
- GitHub Actions runners pinned to `ubuntu-24.04` to silence the Node 20
  deprecation warning. Node runtime in the workflow stays at 24.

## [0.4.0] - 2026-10-15

### Added
- `lib/auth.mjs` — extracts the OAuth token loader and refresh flow
  out of the server. The same module is reused by the boot probe and
  the live smoke test.
- `lib/resilience.mjs` — retry with exponential backoff + full jitter,
  circuit breaker, and in-memory metrics. Upstream calls are wrapped
  in `withResilience()` so transient 429/5xx errors do not bubble to
  the client.
- `lib/capabilities.mjs` — boot-time probe. Sends a minimal Responses
  API request, persists the result to
  `~/.codex/bridge_capabilities.json`, and warns on drift from the
  previous probe.
- `GET /v1/health` — exposes the in-memory resilience counters and
  circuit state for operators.
- `npm run test:resilience` — pure unit tests for the resilience
  layer (no network).
- `npm run test:smoke` — live integration test against the real
  ChatGPT API. Requires `~/.codex/auth.json` on the machine.
- Daily CI cron: runs `test:smoke` at 06:00 UTC to catch wire-shape
  drift the day OpenAI changes something.
- OpenID Connect Trusted Publishing for npm. The publish job no
  longer requires an `NPM_TOKEN` secret.

### Notes
- This release was published via the new OIDC trusted publisher. The
  `0.4.0` on npm is functionally a major upgrade over `0.3.0` (new
  transport, new plugin shape, new durability layer, new tests) but
  the on-npm `0.3.0` was strictly older, so the bump is minor.

## [0.3.0] - 2026-10-15

### Changed
- **Breaking change to the wire transport.** The bridge no longer
  shells out to `codex exec`. It speaks the OpenAI Responses API
  directly at `https://chatgpt.com/backend-api/codex/responses` using
  the OAuth session in `~/.codex/auth.json`.
- Reason: the Codex CLI rejects any ChatGPT Plus/Business model
  slug when invoked with `-m <slug>`, returning
  `'gpt-X' is not supported when using Codex with a ChatGPT account`.
  The bridge reproduces the same wire format the CLI uses internally.
- Auto-refresh of the access token via
  `https://auth.openai.com/oauth/token` when the API returns 401.
  Refreshed tokens are persisted back to `auth.json`.

### Added
- V2-compliant OpenCode plugin: registers the `chatgpt` provider, the
  default MCP servers (Doop, codegraph, codegraph-fe, angecom), and
  a permission policy that mirrors the ChatGPT Plus UX (read-only
  tools are `allow`, anything that mutates state is `ask`).
- `lib/tools-registry.mjs` and the `/v1/tools` (GET/POST/DELETE)
  endpoints. The plugin registers MCP tools on session start, and
  the server injects them into the system prompt when the request
  has no explicit `tools` array.
- `lib/plugin.ts` is the new plugin; the old `codex-bridge-models.ts`
  plugin template is removed.
- `AGENTS.md` with install instructions and architecture notes for
  OpenCode agents.
- `npm run test:tools` — persistent tests for the registry, the
  system block injection, and the multi-turn tool call/result loop.

### Notes
- Two stream-shape bugs in the OpenAI Chat Completions output were
  fixed: tool call deltas no longer carry a redundant `type` field
  (the OpenCode AI SDK schema rejects it), and the `[DONE]` sentinel
  is sent as the raw literal, not JSON-quoted.
- Three fields rejected by the upstream Responses API were removed
  from the request body: `prompt_cache_retention`, `safety_identifier`,
  and `service_tier`.

## [0.2.0] - 2026-10-13

### Added
- Initial npm publish as `@jaralabs/codex-bridge`.
- Bridge binary `codex-bridge` with `start` / `stop` / `status` /
  `sync` / `logs` subcommands.
- OpenAI-compatible HTTP server on `127.0.0.1:11434` with
  `/v1/models` and `/v1/chat/completions` (streaming and JSON).
- Forwarded chat completions to the Codex CLI using
  `codex exec --json --enable tools --tools <tmp>`.

## [0.1.0] - 2026-10-13

### Added
- Initial commit. `codex-bridge` is an OpenAI-compatible HTTP server
  that reuses a local ChatGPT Business / Team / Plus session by
  shelling out to `codex exec --json`. Ships with a model-sync
  helper that pulls the model list from `~/.codex/models_cache.json`
  into `opencode.jsonc`.

[0.4.1]: https://github.com/jaralabs/codex-bridge/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/jaralabs/codex-bridge/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/jaralabs/codex-bridge/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jaralabs/codex-bridge/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jaralabs/codex-bridge/releases/tag/v0.1.0
