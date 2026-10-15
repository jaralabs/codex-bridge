#!/usr/bin/env node
// smoke.mjs: live integration test against the real ChatGPT Responses
// API. Run on CI daily to detect wire-shape drift early.
//
// This test makes a real HTTP call using the same auth the bridge
// uses. It does NOT require the bridge to be running; it imports
// lib/auth.mjs and lib/capabilities.mjs directly.
//
// Set CODEX_BRIDGE_SKIP_LIVE=1 to skip the network call and only
// run the local sanity checks. Useful in air-gapped CI.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAuth } from "../lib/auth.mjs";
import { probeCapabilities } from "../lib/capabilities.mjs";

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const AUTH_PATH = join(CODEX_HOME, "auth.json");
const SMOKE_MODEL = process.env.CODEX_BRIDGE_SMOKE_MODEL || "gpt-6-luna";
const CHATGPT_BASE = "https://chatgpt.com/backend-api/codex";

let failed = 0;
function check(name, ok, extra) {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failed++;
  console.log(`[${tag}] ${name}`, extra ?? "");
}

async function main() {
  if (process.env.CODEX_BRIDGE_SKIP_LIVE === "1") {
    console.log("CODEX_BRIDGE_SKIP_LIVE=1; skipping live API check.");
    return process.exit(0);
  }

  if (!existsSync(AUTH_PATH)) {
    console.error(`auth.json not found at ${AUTH_PATH}; run \`codex login\` first.`);
    return process.exit(2);
  }

  // 1. Auth
  let auth;
  try {
    auth = await getAuth();
    check("auth tokens load", !!auth.access_token);
    check("account_id present", !!auth.account_id);
  } catch (e) {
    check("auth tokens load", false, e?.message);
    return process.exit(1);
  }

  // 2. Capability probe
  const caps = await probeCapabilities({ log: () => {} });
  check("capabilities probe ok", caps.ok, JSON.stringify({ status: caps.status, err: caps.error }));
  check("capability resolvedModel set", !!caps.resolvedModel, caps.resolvedModel);
  check("capability events include response.completed",
    Array.isArray(caps.events) && caps.events.includes("response.completed"),
    JSON.stringify(caps.events));

  // 3. Minimal request that the bridge would send. The Responses API
  //    requires stream:true on the codex endpoint, so we read the SSE
  //    stream until response.completed and then assert.
  const body = {
    model: SMOKE_MODEL,
    store: false,
    stream: true,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "smoke test: reply with the word OK and nothing else" }],
      },
    ],
    prompt_cache_key: `smoke-${Date.now()}`,
  };
  const res = await fetch(`${CHATGPT_BASE}/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${auth.access_token}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      "OpenAI-Beta": "responses=experimental",
      "chatgpt-account-id": auth.account_id || "",
    },
    body: JSON.stringify(body),
  });
  check("smoke request returns 2xx", res.status >= 200 && res.status < 300, `status=${res.status}`);

  if (res.ok) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf8");
    let buf = "";
    let text = "";
    let usage = null;
    let completed = false;
    let resolvedModel = null;
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
        if (json.type === "response.output_text.delta") text += json.delta || "";
        if (json.type === "response.completed") {
          completed = true;
          resolvedModel = json.response?.model || null;
          usage = json.response?.usage || null;
        }
        if (json.type === "error") {
          completed = true;
          check("smoke response error", false, json.message || "unknown");
        }
      }
    }
    check("response text contains OK", /\bOK\b/i.test(text), JSON.stringify(text).slice(0, 80));
    check("response carries usage", usage && typeof usage.input_tokens === "number", JSON.stringify(usage));
    check("response model resolved", !!resolvedModel, resolvedModel);
  }

  console.log(failed === 0 ? "\nALL GREEN" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
