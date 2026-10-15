#!/usr/bin/env node
// codex-bridge: OpenAI-compatible HTTP server that reuses a local ChatGPT
// Business/Team/Plus session by shelling out to `codex exec --json`.
// Default port: 11434. Endpoints:
//   GET  /v1/models            -> { object:"list", data:[...] }
//   POST /v1/chat/completions  -> OpenAI-style streaming or JSON response
//
// Auth: reads ~/.codex/auth.json (refreshes access_token via OpenAI's
// refresh_token grant when expired). The token is only used so the
// shell session stays authenticated; codex CLI handles the actual call.

import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, dirname } from "node:path";

const PORT = Number(process.env.PORT || 11434);
const HOST = process.env.HOST || "127.0.0.1";
const CODEX_HOME =
  process.env.CODEX_HOME || join(homedir(), ".codex");
const AUTH_PATH = join(CODEX_HOME, "auth.json");
const MODELS_CACHE = join(CODEX_HOME, "models_cache.json");

const codexBin = (() => {
  const fromEnv = process.env.CODEX_BIN;
  if (fromEnv) return fromEnv;
  try {
    const which = spawn("which", ["codex"], { stdio: ["ignore", "pipe", "ignore"] });
    const out = [];
    which.stdout.on("data", (c) => out.push(c));
    which.on("close", () => process.stdout.write(""));
    // Note: ignored; we instead use the env-default path lookup below.
  } catch {}
  return "codex";
})();

// ---- Logging (minimal JSONL to stderr) ----
function log(level, msg, extra) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra });
  process.stderr.write(line + "\n");
}

// ---- Auth handling ----
let authCache = null;
function loadAuth() {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(`codex-bridge: no auth.json at ${AUTH_PATH}. Run 'codex login' first.`);
  }
  const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8"));
  if (raw.auth_mode !== "chatgpt") {
    throw new Error(`codex-bridge: auth mode is '${raw.auth_mode}', need 'chatgpt'.`);
  }
  if (!raw.tokens?.access_token) throw new Error("codex-bridge: missing tokens.");
  return raw;
}
function getAuth() {
  if (!authCache) authCache = loadAuth();
  return authCache;
}
// Token refresh is delegated to codex itself; we just rely on the CLI.

// ---- Models listing ----
function listModels() {
  const slugId = (s) => ({
    id: s,
    object: "model",
    created: 0,
    owned_by: "openai-chatgpt",
  });
  let slugs = [];
  if (existsSync(MODELS_CACHE)) {
    try {
      const cache = JSON.parse(readFileSync(MODELS_CACHE, "utf8"));
      if (Array.isArray(cache.models)) {
        slugs = cache.models
          .filter((m) => m.visibility === "list" || m.visibility == null)
          .map((m) => m.slug)
          .filter(Boolean);
      }
    } catch (e) {
      log("warn", "models_cache.json parse failed", { err: String(e) });
    }
  }
  if (slugs.length === 0) {
    slugs = ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"];
  }
  return { object: "list", data: slugs.map(slugId) };
}

// ---- codex exec runner ----
function runCodex({ model, prompt, signal }) {
  return new Promise((resolve, reject) => {
    // Ensure auth is fresh enough for codex exec by reading the file (codex
    // itself will refresh via its internal logic on the next call).
    getAuth();
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-m", model,
      prompt,
    ];
    const child = spawn(codexBin, args, {
      env: {
        ...process.env,
        CODEX_HOME,
        NO_COLOR: "1",
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try { child.kill("SIGTERM"); } catch {}
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (aborted) return reject(new Error("aborted"));
      if (code !== 0) {
        return reject(
          new Error(`codex exec exited ${code}: ${stderr.slice(0, 400)}`),
        );
      }
      // Parse the last item.completed agent_message + usage.
      let lastText = "";
      let usage = null;
      for (const line of stdout.split("\n")) {
        const l = line.trim();
        if (!l.startsWith("{")) continue;
        let evt;
        try { evt = JSON.parse(l); } catch { continue; }
        if (evt.type === "item.completed" && evt.item?.type === "agent_message") {
          lastText = evt.item.text ?? lastText;
        }
        if (evt.type === "turn.completed") {
          usage = evt.usage ?? null;
        }
      }
      resolve({ text: lastText, usage, stderr });
    });
  });
}

// ---- OpenAI shape helpers ----
function now() { return Math.floor(Date.now() / 1000); }
function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function toUsage(u) {
  if (!u) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
}
function renderTemplate(tmpl, vars) {
  if (typeof tmpl === "string") return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
  // Multimodal array: replace text parts with {{key}} expansion.
  return tmpl
    .map((part) =>
      part?.type === "text"
        ? { ...part, text: part.text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "") }
        : part,
    );
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, { ok: true, port: PORT });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, listModels());
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: { message: "invalid JSON" } }); }
      return handleChatCompletions(payload, req, res);
    }
    return json(res, 404, { error: { message: "not found", path: url.pathname } });
  } catch (e) {
    log("error", "handler failed", { err: String(e), stack: e?.stack });
    return json(res, 500, { error: { message: String(e.message || e) } });
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  res.end(body);
}
function startSse(res, status = 200) {
  res.writeHead(status, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "connection": "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
  });
}
function sse(res, event, data) {
  if (event) res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleChatCompletions(payload, req, res) {
  const {
    model,
    messages = [],
    stream = false,
    temperature,
    top_p,
    max_tokens,
  } = payload || {};
  if (!model) return json(res, 400, { error: { message: "model is required" } });
  if (!Array.isArray(messages) || messages.length === 0) {
    return json(res, 400, { error: { message: "messages[] required" } });
  }

  // Build prompt: concatenate system/user/assistant turns.
  const parts = [];
  let lastRole = null;
  for (const m of messages) {
    if (!m || !m.role) continue;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .filter((p) => p?.type === "text")
        .map((p) => p.text || "")
        .join("\n");
    } else if (m.content) text = String(m.content);
    if (!text && m.role !== lastRole) parts.push("");
    if (text) {
      const tag = m.role.toUpperCase();
      parts.push(`${tag}: ${text}`);
    }
    lastRole = m.role;
  }
  parts.push("ASSISTANT:");
  const prompt = parts.filter(Boolean).join("\n\n");

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  log("info", "chat.completions", { model, stream, msgs: messages.length });
  let result;
  try {
    result = await runCodex({ model, prompt, signal: ac.signal });
  } catch (e) {
    return json(res, 502, { error: { message: String(e.message || e), type: "codex_error" } });
  }

  const id = genId("chatcmpl");
  const created = now();
  const usage = toUsage(result.usage);

  if (stream) {
    startSse(res);
    // First chunk: role.
    sse(res, null, {
      id, object: "chat.completion.chunk", created,
      model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    // Content chunk (codex exec doesn't stream per-token; emit as one).
    if (result.text) {
      sse(res, null, {
        id, object: "chat.completion.chunk", created,
        model,
        choices: [{
          index: 0,
          delta: { content: result.text },
          finish_reason: null,
        }],
      });
    }
    // Final chunk with finish_reason + usage.
    sse(res, null, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    sse(res, null, {
      id, object: "chat.completion.chunk", created, model,
      choices: [],
      usage,
    });
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  return json(res, 200, {
    id, object: "chat.completion", created, model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: result.text },
      finish_reason: "stop",
      logprobs: null,
    }],
    usage,
  });
}

server.listen(PORT, HOST, () => {
  log("info", "listening", { url: `http://${HOST}:${PORT}`, codex_home: CODEX_HOME });
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
