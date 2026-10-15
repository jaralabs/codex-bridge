# @jaralabs/codex-bridge

> Use your ChatGPT Business / Team / Plus subscription from OpenCode instead of paying for the OpenAI API.

`codex-bridge` runs an OpenAI-compatible HTTP server on `127.0.0.1:11434` that
forwards chat-completion requests to the [OpenAI Codex CLI][codex]. Because
the Codex CLI reuses the local ChatGPT OAuth session in `~/.codex/auth.json`,
your OpenCode prompts consume your subscription credits — not the OpenAI API
balance.

[codex]: https://github.com/openai/codex

## Why

If you have a ChatGPT Business / Team / Plus plan, the OpenAI API and the
ChatGPT web subscription are billed separately. You can use Codex CLI / web
App today with the subscription. `codex-bridge` exposes the same models over
an OpenAI-compatible HTTP surface so OpenCode (and any other OpenAI client
like Claude Code, Cline, aider) can use them without an API key.

## Install

```bash
npm install -g @jaralabs/codex-bridge
```

Requires Node 18 or newer and the OpenAI Codex CLI installed and logged in
once with `codex login` on a machine with the ChatGPT Business / Team / Plus
session.

## Wire it into OpenCode

Add a `chatgpt` provider to `~/.config/opencode/opencode.jsonc`:

```json
{
  "provider": {
    "chatgpt": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "ChatGPT Business (codex-bridge)",
      "options": {
        "baseURL": "http://127.0.0.1:11434/v1"
      },
      "models": {
        "gpt-6.1-sol": {
          "name": "GPT-6.1 Sol (Business)",
          "limit": { "context": 272000, "output": 128000 },
          "modalities": { "input": ["text", "image"], "output": ["text"] }
        }
      }
    }
  }
}
```

The exact model list depends on what your plan exposes. `codex-bridge start`
syncs the model list from `~/.codex/models_cache.json` (refreshed by Codex
whenever it talks to ChatGPT) and rewrites the `provider.chatgpt.models`
block to match. Re-run `codex-bridge start` after any plan change.

## Usage

```bash
codex-bridge start    # sync models + start HTTP server in background
codex-bridge status   # is it up?
codex-bridge sync     # only sync model list (no server)
codex-bridge logs     # tail the server log
codex-bridge stop     # kill the server
```

In another terminal:

```bash
opencode run --model=chatgpt/gpt-6.1-sol "say hi"
```

## How it works

```
┌──────────┐        HTTP (OpenAI-compatible)        ┌────────────────┐
│ OpenCode │ ──────────────────────────────────────▶ │ codex-bridge   │
│          │ ◀────────────────────────────────────── │ 127.0.0.1:11434│
└──────────┘                                         └────────────────┘
                                                          │
                                       spawns             ▼
                                                  ┌─────────────────┐
                                                  │ codex exec      │
                                                  │ (uses ChatGPT   │
                                                  │  OAuth session) │
                                                  └─────────────────┘
```

The bridge has zero state of its own. It just maps an OpenAI-style HTTP
request into a Codex CLI invocation and pipes the result back. Codex handles
auth, plan routing, and rate limits.

## License

MIT.
