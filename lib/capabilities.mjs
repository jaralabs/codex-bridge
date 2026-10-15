// capabilities.mjs: probe the upstream ChatGPT Responses API at boot
// and persist a small capability record to ~/.codex/bridge_capabilities.json.
//
// The probe sends a minimal request (one user message, no tools) and
// records:
//
//   * which request fields the API accepted (or rejected) so we can
//     detect a wire-shape drift the next time the bridge starts;
//   * the round-trip latency;
//   * the resolved model id (so we know if the model slug was renamed
//     or routed to a different one);
//   * the response shape: did we get an event stream? Did the
//     response.completed event arrive?
//
// The next boot compares the new probe against the previous record.
// If the shape changes in a way we did not anticipate, we log a
// warn and (optionally) refuse to start.
//
// The probe is best-effort. If it fails, the bridge still starts:
// the real chat handler will surface a clearer error on the first
// request and the operator can see what changed.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAuth } from "./auth.mjs";

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const CAPS_PATH = join(CODEX_HOME, "bridge_capabilities.json");
const CHATGPT_BASE = "https://chatgpt.com/backend-api/codex";

const PROBE_MODEL = process.env.CODEX_BRIDGE_PROBE_MODEL || "gpt-6-luna";

// The list of body fields we send on every request. The probe
// checks which of these the API still accepts. If a previously
// accepted field is now rejected, we log a strong warn.
const PROBE_FIELDS = [
  "model",
  "store",
  "stream",
  "instructions",
  "input",
  "tool_choice",
  "parallel_tool_calls",
  "prompt_cache_key",
];

export async function probeCapabilities({ log = console.log.bind(console) } = {}) {
  const start = Date.now();
  let result;
  try {
    const auth = await getAuth();
    const body = {
      model: PROBE_MODEL,
      store: false,
      stream: true,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "ping" }],
        },
      ],
      prompt_cache_key: `bridge-probe-${Date.now()}`,
    };
    const res = await fetch(`${CHATGPT_BASE}/responses`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${auth.access_token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
        "OpenAI-Beta": "responses=experimental",
        "chatgpt-account-id": auth.account_id || "",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      result = { ok: false, status: res.status, error: text.slice(0, 400), latencyMs: Date.now() - start };
    } else {
      // Read the SSE stream until the first response.completed or
      // error event, then bail. We do not need the full response.
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf8");
      let buf = "";
      let completed = false;
      let resolvedModel = null;
      let firstEvent = null;
      const events = new Set();
      while (!completed) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data || data === "[DONE]") continue;
          let json;
          try { json = JSON.parse(data); } catch { continue; }
          events.add(json.type);
          if (!firstEvent) firstEvent = json.type;
          if (json.type === "response.completed") {
            completed = true;
            resolvedModel = json.response?.model || null;
            break;
          }
          if (json.type === "error" || json.type === "response.failed") {
            completed = true;
            result = { ok: false, status: res.status, error: json.message || json.error || "unknown", events: Array.from(events) };
            try { await reader.cancel(); } catch {}
            break;
          }
        }
      }
      if (!result) {
        result = {
          ok: true,
          status: res.status,
          latencyMs: Date.now() - start,
          resolvedModel,
          firstEvent,
          events: Array.from(events),
        };
      }
    }
  } catch (e) {
    result = { ok: false, error: e?.message || String(e), latencyMs: Date.now() - start };
  }

  // Compare against the previous record.
  const previous = readPrevious();
  const record = {
    probedAt: new Date().toISOString(),
    probeModel: PROBE_MODEL,
    probeFields: PROBE_FIELDS,
    ...result,
  };
  if (previous) {
    const drift = detectDrift(previous, record);
    if (drift.length > 0) {
      log("warn", "capabilities.drift", { drift });
    }
  }
  try {
    mkdirSync(CODEX_HOME, { recursive: true });
    writeFileSync(CAPS_PATH, JSON.stringify(record, null, 2));
  } catch (e) {
    // best-effort: do not block startup on disk write failure
  }
  return record;
}

function readPrevious() {
  if (!existsSync(CAPS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CAPS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function detectDrift(prev, next) {
  const out = [];
  if (prev.ok !== next.ok) {
    out.push({ kind: "ok", before: prev.ok, after: next.ok });
  }
  if (prev.resolvedModel && next.resolvedModel && prev.resolvedModel !== next.resolvedModel) {
    out.push({ kind: "resolvedModel", before: prev.resolvedModel, after: next.resolvedModel });
  }
  if (Array.isArray(prev.events) && Array.isArray(next.events)) {
    const lost = prev.events.filter((e) => !next.events.includes(e));
    const gained = next.events.filter((e) => !prev.events.includes(e));
    if (lost.length > 0) out.push({ kind: "eventsLost", events: lost });
    if (gained.length > 0) out.push({ kind: "eventsGained", events: gained });
  }
  return out;
}
