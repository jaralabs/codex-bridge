#!/usr/bin/env node
// Smoke test for codex-bridge: /healthz, /v1/models, /v1/chat/completions
// (both JSON and streaming modes). Run AFTER `npm start` is up.

const BASE = process.env.BASE || "http://127.0.0.1:11434";

async function http(pathname, opts = {}) {
  const url = `${BASE}${pathname}`;
  const r = await fetch(url, opts);
  const ct = r.headers.get("content-type") || "";
  return { status: r.status, ct, body: ct.includes("json") ? await r.json() : await r.text() };
}

let failed = 0;
function check(name, ok, extra) {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failed++;
  console.log(`[${tag}] ${name}`, extra ?? "");
}

const h = await http("/healthz");
check("GET /healthz", h.status === 200 && h.body.ok === true, h.body);

const m = await http("/v1/models");
check("GET /v1/models", m.status === 200 && Array.isArray(m.body.data) && m.body.data.length > 0,
  `models=${m.body.data?.map((x) => x.id).join(",")}`);

const pickModel = m.body.data[0].id;
console.log(`Using model: ${pickModel}`);

// JSON mode
const j = await http("/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: pickModel,
    messages: [{ role: "user", content: "respond with one word only: ok" }],
    stream: false,
  }),
});
check(
  "POST /v1/chat/completions JSON",
  j.status === 200 && j.body.choices?.[0]?.message?.content,
  `text=${JSON.stringify(j.body.choices?.[0]?.message?.content)} usage=${JSON.stringify(j.body.usage)}`,
);

// Streaming mode
const sr = await fetch(`${BASE}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: pickModel,
    messages: [{ role: "user", content: "respond with one word only: stream" }],
    stream: true,
  }),
});
const text = await sr.text();
const hasRole = text.includes('"delta":{"role":"assistant"}');
const hasContent = /"delta":\s*\{\s*"content":/.test(text);
const hasDone = text.includes("[DONE]");
check("POST /v1/chat/completions stream", sr.status === 200 && hasRole && hasContent && hasDone,
  `status=${sr.status} role=${hasRole} content=${hasContent} done=${hasDone}`);

console.log(`\n${failed === 0 ? "ALL GREEN" : `${failed} FAIL`}`);
process.exit(failed === 0 ? 0 : 1);
