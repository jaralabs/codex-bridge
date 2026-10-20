#!/usr/bin/env node
// Tool-call tests for codex-bridge.
//
// What this covers:
//   1. /v1/tools POST registers a list, GET lists it back, DELETE clears it.
//   2. A chat request WITHOUT an explicit `tools` array injects the
//      registered tools into the system prompt (Plus-style tool
//      awareness). Observed through the `x-codex-bridge-instructions-len`
//      response header, which reports the length of the instructions
//      actually sent upstream.
//   3. A chat request WITH `tools: [...]` does NOT inject the registry
//      block (explicit tools win).
//   4. The multi-turn tool loop: a request that yields tool_calls returns
//      finish_reason=tool_calls, and a follow-up request carrying
//      role:"tool" messages yields finish_reason=stop.
//   5. The same tool call over a streamed response.
//
// This test talks to a RUNNING bridge over HTTP and uses the real
// ChatGPT session, so it needs:
//
//   * `codex-bridge start` (or the systemd user service) up, and
//   * a valid `~/.codex/auth.json`.
//
// Usage:
//   BASE=http://127.0.0.1:11434 node test/test-tools.mjs

const BASE = process.env.BASE || "http://127.0.0.1:11434";
const PREFERRED_MODEL = process.env.CODEX_BRIDGE_TEST_MODEL || "gpt-6-luna";
const TOOL_ATTEMPTS = Number(process.env.CODEX_BRIDGE_TEST_ATTEMPTS || 3);

let failed = 0;
function check(name, ok, extra) {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failed++;
  console.log(`[${tag}] ${name}`, extra ?? "");
}

async function http(pathname, opts = {}) {
  const r = await fetch(`${BASE}${pathname}`, opts);
  const ct = r.headers.get("content-type") || "";
  return {
    status: r.status,
    headers: r.headers,
    body: ct.includes("json") ? await r.json() : await r.text(),
  };
}

function postJson(pathname, payload) {
  return http(pathname, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function readSse(response) {
  const text = await response.text();
  const chunks = [];
  for (const block of text.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { chunks.push(JSON.parse(data)); } catch { /* not a JSON chunk */ }
    }
  }
  return { chunks, raw: text };
}

// --- 0. The bridge must be up ---
let models;
try {
  const health = await http("/healthz");
  if (health.status !== 200) throw new Error(`healthz returned ${health.status}`);
  models = (await http("/v1/models")).body;
} catch (e) {
  console.error(`codex-bridge is not reachable at ${BASE}: ${e.message}`);
  console.error("Start it with 'codex-bridge start' (or systemctl --user start codex-bridge) and retry.");
  process.exit(2);
}

const available = (models?.data || []).map((m) => m.id);
if (available.length === 0) {
  console.error("The bridge exposes no models; run 'codex-bridge sync' first.");
  process.exit(2);
}
const model = available.includes(PREFERRED_MODEL) ? PREFERRED_MODEL : available[0];
console.log(`Using model: ${model}\n`);

const TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city.",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
};

const REGISTRY_TOOLS = [
  { name: "doop_get_frame", server: "doop", description: "Get a frame", parameters: { type: "object" } },
  { name: "codegraph_explore", server: "codegraph", description: "Explore code", parameters: { type: "object" } },
];

// --- 1. Registry lifecycle ---
const reg = await postJson("/v1/tools", { tools: REGISTRY_TOOLS });
check("POST /v1/tools registers", reg.status === 200 && reg.body.count === 2, `count=${reg.body?.count}`);

const list = await http("/v1/tools");
check(
  "GET /v1/tools returns the registry",
  list.status === 200 && list.body.data.length === 2 && list.body.data[0].name === "doop_get_frame"
);

const cleared = await http("/v1/tools", { method: "DELETE" });
check("DELETE /v1/tools clears the registry", cleared.status === 200 && cleared.body.count === 0);

// --- 2. Injection: registry present, no explicit tools ---
const emptyRegistry = await postJson("/v1/chat/completions", {
  model,
  stream: false,
  messages: [{ role: "user", content: "Reply with the single word: OK" }],
});
const emptyLen = Number(emptyRegistry.headers.get("x-codex-bridge-instructions-len"));
check(
  "empty registry sends no instructions",
  emptyRegistry.status === 200 && emptyLen === 0,
  `instructions-len=${emptyLen}`
);

await postJson("/v1/tools", { tools: REGISTRY_TOOLS });
const withRegistry = await postJson("/v1/chat/completions", {
  model,
  stream: false,
  messages: [{ role: "user", content: "Reply with the single word: OK" }],
});
const registryLen = Number(withRegistry.headers.get("x-codex-bridge-instructions-len"));
check(
  "registry tools are injected into the instructions",
  withRegistry.status === 200 && registryLen > emptyLen,
  `instructions-len=${registryLen} (empty registry: ${emptyLen})`
);

// --- 3. Explicit tools win: no registry injection ---
const explicit = await postJson("/v1/chat/completions", {
  model,
  stream: false,
  messages: [{ role: "user", content: "Reply with the single word: OK" }],
  tools: [TOOL],
});
const explicitLen = Number(explicit.headers.get("x-codex-bridge-instructions-len"));
check(
  "explicit tools suppress the registry injection",
  explicit.status === 200 && explicitLen === 0,
  `instructions-len=${explicitLen}`
);
check(
  "explicit tools are forwarded upstream",
  Number(explicit.headers.get("x-codex-bridge-tools")) === 1
);

// The registry is no longer needed for the rest of the suite.
await http("/v1/tools", { method: "DELETE" });

// --- 4. Multi-turn tool loop ---
let toolCall = null;
for (let attempt = 1; attempt <= TOOL_ATTEMPTS && !toolCall; attempt++) {
  const res = await postJson("/v1/chat/completions", {
    model,
    stream: false,
    messages: [
      {
        role: "user",
        content: "What is the weather in Paris? Use the get_weather tool to find out.",
      },
    ],
    tools: [TOOL],
  });
  const calls = res.body?.choices?.[0]?.message?.tool_calls || [];
  if (calls.length > 0) toolCall = { res, call: calls[0] };
  else if (attempt < TOOL_ATTEMPTS) console.log(`  (attempt ${attempt}: no tool call, retrying)`);
}

check("model returns a tool call", toolCall !== null);
if (toolCall) {
  const { res, call } = toolCall;
  check(
    "finish_reason is tool_calls",
    res.body.choices[0].finish_reason === "tool_calls",
    `finish_reason=${res.body.choices[0].finish_reason}`
  );
  check("tool call carries an id", typeof call.id === "string" && call.id.length > 0, call.id);
  check("tool call names the function", call.function?.name === "get_weather", call.function?.name);
  let args = null;
  try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* not JSON */ }
  check(
    "tool call arguments parse and name the city",
    args !== null && typeof args.city === "string" && args.city.length > 0,
    call.function?.arguments
  );
  check(
    "usage is reported",
    typeof res.body.usage?.prompt_tokens === "number" && res.body.usage.prompt_tokens > 0,
    JSON.stringify(res.body.usage)
  );

  // --- 5. Follow-up turn carrying the tool result ---
  const followUp = await postJson("/v1/chat/completions", {
    model,
    stream: false,
    messages: [
      {
        role: "user",
        content: "What is the weather in Paris? Use the get_weather tool to find out.",
      },
      {
        role: "assistant",
        tool_calls: [call],
      },
      {
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({ city: "Paris", temp_c: 17, sky: "cloudy" }),
      },
    ],
    // Real clients (the AI SDK, OpenCode) re-send the tool declarations on
    // the follow-up turn; without them the model has a function call it
    // cannot resolve and answers with nothing.
    tools: [TOOL],
  });
  const followText = followUp.body?.choices?.[0]?.message?.content || "";
  check(
    "follow-up turn finishes with stop",
    followUp.status === 200 && followUp.body.choices[0].finish_reason === "stop",
    `finish_reason=${followUp.body?.choices?.[0]?.finish_reason}`
  );
  check("follow-up turn returns content", followText.length > 0, JSON.stringify(followText.slice(0, 120)));

  // --- 6. The same tool call over a streamed response ---
  const streamed = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        {
          role: "user",
          content: "What is the weather in Paris? Use the get_weather tool to find out.",
        },
      ],
      tools: [TOOL],
    }),
  });
  const { chunks, raw } = await readSse(streamed);
  const toolChunks = chunks.filter((c) => c.choices?.[0]?.delta?.tool_calls?.length > 0);
  const lastChoice = [...chunks].reverse().find((c) => c.choices?.length > 0)?.choices[0];
  check("stream emits a tool_calls delta", toolChunks.length > 0);
  check(
    "stream finishes with tool_calls",
    lastChoice?.finish_reason === "tool_calls",
    `finish_reason=${lastChoice?.finish_reason}`
  );
  check("stream ends with [DONE]", raw.trimEnd().endsWith("data: [DONE]"));
}

// Leave the registry empty for the next run.
await http("/v1/tools", { method: "DELETE" });

if (failed > 0) {
  console.error(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nALL GREEN");
