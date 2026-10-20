#!/usr/bin/env node
// codex-bridge: OpenAI-compatible HTTP server that talks to ChatGPT
// Business/Team/Plus via the OpenAI Responses API directly.
//
// Endpoints:
//   GET  /v1/health           -> { ok, ...metrics }
//   GET  /v1/models           -> { object:"list", data:[...] }
//   POST /v1/chat/completions -> OpenAI-style streaming or JSON response
//   GET  /v1/tools            -> list registered MCP tools
//   POST /v1/tools            -> register a list of tools
//   DELETE /v1/tools          -> clear registry
//
// Auth lives in lib/auth.mjs. Upstream resilience (retry, circuit
// breaker, metrics) lives in lib/resilience.mjs. Boot-time capability
// probing lives in lib/capabilities.mjs.

import http from "node:http";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { getAuth, refreshAccessToken } from "./auth.mjs";
import {
  registerTool,
  registerTools,
  listTools,
  clearTools,
  renderToolsSystemBlock,
} from "./tools-registry.mjs";
import {
  withResilience,
  metrics as resilienceMetrics,
  recordUsage,
} from "./resilience.mjs";
import { probeCapabilities } from "./capabilities.mjs";
import { resolveReasoningEffort } from "./reasoning.mjs";

const PORT = Number(process.env.PORT || 11434);
const HOST = process.env.HOST || "127.0.0.1";
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const MODELS_CACHE = join(CODEX_HOME, "models_cache.json");
const CHATGPT_BASE = "https://chatgpt.com/backend-api/codex";
const LOG_PATH = process.env.CODEX_BRIDGE_LOG || "/tmp/codex-bridge.log";

function log(level, msg, extra) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra || {}) });
  try { appendFileSync(LOG_PATH, line + "\n"); } catch {}
  if (process.env.CODEX_BRIDGE_VERBOSE) {
    process.stderr.write(line + "\n");
  }
}

// ---- models ----
function listModels() {
  if (!existsSync(MODELS_CACHE)) {
    return { object: "list", data: [] };
  }
  try {
    const cache = JSON.parse(readFileSync(MODELS_CACHE, "utf8"));
    if (!Array.isArray(cache.models)) return { object: "list", data: [] };
    const data = cache.models
      .filter((m) => ["list", "default", null, undefined].includes(m.visibility ?? null))
      .filter((m) => m.supported_in_api !== false)
      .map((m) => ({ id: m.slug, object: "model", created: 0, owned_by: "openai-chatgpt" }));
    return { object: "list", data };
  } catch (e) {
    log("warn", "listModels failed", { err: String(e) });
    return { object: "list", data: [] };
  }
}

// ---- OpenAI Chat Completions <-> Responses API translation ----

function chatToolsToResponsesTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools
    .map((t) => {
      const fn = t.function || t;
      if (!fn?.name) return null;
      return {
        type: "function",
        name: fn.name,
        description: fn.description || "",
        parameters: fn.parameters || { type: "object", properties: {} },
        strict: false,
      };
    })
    .filter(Boolean);
}

function chatMessagesToResponsesInput(messages) {
  let instructions = "";
  const input = [];
  for (const m of messages) {
    if (!m || !m.role) continue;
    const role = m.role;
    if (role === "system" || role === "developer") {
      const txt = textOf(m.content);
      if (txt) instructions = (instructions ? instructions + "\n\n" : "") + txt;
      continue;
    }
    if (role === "user") {
      const txt = textOf(m.content);
      if (txt) input.push({ type: "message", role: "user", content: [{ type: "input_text", text: txt }] });
      continue;
    }
    if (role === "assistant") {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          const name = tc.function?.name || tc.name;
          const args = typeof tc.function?.arguments === "string"
            ? tc.function.arguments
            : (typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}));
          input.push({ type: "function_call", call_id: tc.id, name, arguments: args });
        }
      }
      const txt = textOf(m.content);
      if (txt) {
        input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: txt }] });
      }
      continue;
    }
    if (role === "tool") {
      const callId = m.tool_call_id || m.call_id;
      const out = textOf(m.content);
      if (callId) {
        input.push({ type: "function_call_output", call_id: callId, output: out });
      }
      continue;
    }
  }
  return { instructions, input };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (!p) return "";
        if (p.type === "text" || p.type === "input_text" || p.type === "output_text") return p.text || "";
        if (p.type === "image_url" && p.image_url?.url) return `[image: ${p.image_url.url.slice(0, 60)}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

function now() { return Math.floor(Date.now() / 1000); }
function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function toUsage(u) {
  if (!u) return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
  };
}

// ---- HTTP client to ChatGPT ----
async function callResponses({ model, instructions, input, tools, reasoningEffort, signal }) {
  const auth = await getAuth();
  const url = `${CHATGPT_BASE}/responses`;
  const body = {
    model,
    store: false,
    stream: true,
    instructions: instructions || undefined,
    input,
    tool_choice: "auto",
    parallel_tool_calls: true,
    prompt_cache_key: `codex-bridge-${Date.now()}`,
  };
  if (tools && tools.length > 0) body.tools = tools;
  // Chat Completions clients send the thinking level as `reasoning_effort`;
  // the Responses API expects `reasoning: { effort }`. Absent or
  // unsupported values leave the upstream default in place.
  const effort = resolveReasoningEffort(reasoningEffort);
  if (effort) body.reasoning = { effort };

  const headers = {
    authorization: `Bearer ${auth.access_token}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    "chatgpt-account-id": auth.account_id || "",
  };

  log("info", "responses.request", {
    model,
    instructionsLen: (instructions || "").length,
    inputItems: input.length,
    tools: (tools || []).length,
    reasoning: effort || null,
  });

  const doFetch = async () => {
    let res;
    try {
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e) {
      const err = new Error(`fetch failed: ${e?.message || e}`);
      err.code = "fetch_failed";
      err.status = 0;
      throw err;
    }
    if (res.status === 401 && auth.refresh_token) {
      log("info", "responses.401 refreshing token");
      const refreshed = await refreshAccessToken(auth.refresh_token);
      headers.authorization = `Bearer ${refreshed.access_token}`;
      res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    }
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`chatgpt ${res.status}: ${text.slice(0, 400)}`);
      err.status = res.status;
      throw err;
    }
    return res;
  };

  return withResilience("responses", doFetch, { signal });
}

// Parse SSE stream from Responses API.
async function readSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf8");
  let buf = "";
  let text = "";
  const toolCalls = new Map();
  let usage = null;
  let currentItem = null;

  function ensureCall(id, name) {
    if (!toolCalls.has(id)) toolCalls.set(id, { id, name: name || "", arguments: "" });
    return toolCalls.get(id);
  }

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim();
      }
      if (!data) continue;
      if (data === "[DONE]") continue;
      let json;
      try { json = JSON.parse(data); } catch { continue; }
      const t = json.type || event;
      switch (t) {
        case "response.output_item.added": {
          const item = json.item || {};
          currentItem = { type: item.type, id: item.id, call_id: item.call_id, name: item.name, content_index: 0 };
          if (item.type === "function_call") {
            ensureCall(item.call_id, item.name);
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const id = json.call_id || currentItem?.call_id;
          if (id) {
            const call = ensureCall(id, currentItem?.name || json.name);
            call.arguments += json.delta || "";
          }
          break;
        }
        case "response.function_call_arguments.done": {
          const id = json.call_id || currentItem?.call_id;
          if (id && typeof json.arguments === "string") {
            const call = ensureCall(id, currentItem?.name || json.name);
            call.arguments = json.arguments;
          }
          break;
        }
        case "response.output_text.delta": {
          text += json.delta || "";
          break;
        }
        case "response.completed": {
          const r = json.response || {};
          if (r.usage) usage = r.usage;
          if (!text && Array.isArray(r.output)) {
            for (const item of r.output) {
              if (item.type === "message") {
                for (const part of item.content || []) {
                  if (part.type === "output_text" && part.text) text += part.text;
                }
              }
            }
          }
          break;
        }
        default:
          break;
      }
    }
  }
  return { text, toolCalls: Array.from(toolCalls.values()), usage };
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, { ok: true, port: PORT });
    }
    if (req.method === "GET" && url.pathname === "/v1/health") {
      return json(res, 200, {
        ok: true,
        port: PORT,
        uptime: process.uptime(),
        ...resilienceMetrics(),
      });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, listModels());
    }
    if (req.method === "GET" && url.pathname === "/v1/tools") {
      return json(res, 200, { object: "list", data: listTools() });
    }
    if (req.method === "POST" && url.pathname === "/v1/tools") {
      const body = await readBody(req);
      let payload;
      try { payload = JSON.parse(body); } catch { return json(res, 400, { error: { message: "invalid JSON" } }); }
      if (Array.isArray(payload)) registerTools(payload);
      else if (Array.isArray(payload?.tools)) registerTools(payload.tools);
      else return json(res, 400, { error: { message: "expected array or { tools: [...] }" } });
      return json(res, 200, { object: "list", data: listTools(), count: listTools().length });
    }
    if (req.method === "DELETE" && url.pathname === "/v1/tools") {
      clearTools();
      return json(res, 200, { object: "list", data: [], count: 0 });
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
    tools,
    reasoning_effort,
    reasoning,
  } = payload || {};
  if (!model) return json(res, 400, { error: { message: "model is required" } });
  if (!Array.isArray(messages) || messages.length === 0) {
    return json(res, 400, { error: { message: "messages[] required" } });
  }

  const ac = new AbortController();
  req.on("close", () => ac.abort());

  const responsesTools = chatToolsToResponsesTools(tools);
  let { instructions, input } = chatMessagesToResponsesInput(messages);
  if (!(responsesTools && responsesTools.length > 0)) {
    const block = renderToolsSystemBlock();
    if (block) {
      instructions = instructions ? `${instructions}\n\n${block}` : block;
    }
  }

  log("info", "chat.completions", { model, stream, msgs: messages.length, toolCount: (tools || []).length });

  let result;
  try {
    const upstream = await callResponses({
      model,
      instructions,
      input,
      tools: responsesTools,
      reasoningEffort: reasoning_effort ?? reasoning?.effort,
      signal: ac.signal,
    });
    result = await readSse(upstream);
  } catch (e) {
    const status = e?.status || 502;
    const body = {
      error: {
        message: String(e.message || e),
        type: e?.code || "upstream_error",
      },
    };
    if (status === 503 && e?.code === "circuit_open") {
      return json(res, 503, { ...body, error: { ...body.error, message: "bridge: circuit open, upstream unavailable" } });
    }
    return json(res, status === 401 ? 502 : status, body);
  }

  const id = genId("chatcmpl");
  const created = now();
  const usage = toUsage(result.usage);
  // Sum the token usage of this successful turn into the in-memory
  // counters that /v1/health exposes. We record once per turn (here,
  // after the upstream Responses API returned a `response.completed`
  // event with a `usage` block), so streaming and JSON responses are
  // counted identically. Multi-turn tool-call loops in the same
  // request accumulate multiple `recordUsage` calls.
  if (result.usage) recordUsage(result.usage);
  const hasToolCalls = result.toolCalls && result.toolCalls.length > 0;
  const finishReason = hasToolCalls ? "tool_calls" : "stop";
  const message = { role: "assistant", content: result.text || "" };
  if (hasToolCalls) {
    message.tool_calls = result.toolCalls.map((c, i) => ({
      index: i,
      id: c.id,
      function: { name: c.name, arguments: c.arguments || "" },
    }));
  }

  if (stream) {
    startSse(res);
    sse(res, null, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    if (result.text) {
      sse(res, null, {
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }],
      });
    }
    if (hasToolCalls) {
      for (let i = 0; i < result.toolCalls.length; i++) {
        const c = result.toolCalls[i];
        sse(res, null, {
          id, object: "chat.completion.chunk", created, model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: i,
                id: c.id,
                function: { name: c.name, arguments: c.arguments || "" },
              }],
            },
            finish_reason: null,
          }],
        });
      }
    }
    sse(res, null, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    });
    sse(res, null, { id, object: "chat.completion.chunk", created, model, choices: [], usage });
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  return json(res, 200, {
    id, object: "chat.completion", created, model,
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage,
  });
}

// ---- boot ----
async function boot() {
  try {
    const caps = await probeCapabilities({ log: (level, msg, extra) => log(level, msg, extra) });
    log("info", "capabilities", { ok: caps.ok, resolvedModel: caps.resolvedModel, events: caps.events, latencyMs: caps.latencyMs });
  } catch (e) {
    log("warn", "probe failed; starting anyway", { err: String(e) });
  }
  server.listen(PORT, HOST, () => {
    log("info", "listening", { url: `http://${HOST}:${PORT}`, codex_home: CODEX_HOME });
    process.stderr.write(`codex-bridge listening on http://${HOST}:${PORT}\n`);
  });
}

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));

boot();
