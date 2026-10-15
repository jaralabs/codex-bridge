#!/usr/bin/env node
// test-resilience.mjs: pure unit tests for lib/resilience.mjs.
// No network required.

import {
  withResilience,
  backoffMs,
  isRetryableStatus,
  circuitStatus,
  circuitPermits,
  metrics,
  recordUsage,
  retryConfig,
} from "../lib/resilience.mjs";

let failed = 0;
function check(name, ok, extra) {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failed++;
  console.log(`[${tag}] ${name}`, extra ?? "");
}

// 1. isRetryableStatus
check("429 is retryable", isRetryableStatus(429));
check("500 is retryable", isRetryableStatus(500));
check("502 is retryable", isRetryableStatus(502));
check("503 is retryable", isRetryableStatus(503));
check("504 is retryable", isRetryableStatus(504));
check("408 is retryable", isRetryableStatus(408));
check("400 is NOT retryable", !isRetryableStatus(400));
check("401 is NOT retryable", !isRetryableStatus(401));
check("404 is NOT retryable", !isRetryableStatus(404));

// 2. backoffMs is bounded
for (let i = 0; i < 100; i++) {
  const b = backoffMs(0);
  if (b < 0 || b > retryConfig.baseMs) {
    check(`backoffMs(0) bounded: ${b}`, false);
    break;
  }
}
check("backoffMs(0) bounded across 100 samples", true);
for (let i = 0; i < 100; i++) {
  const b = backoffMs(20);
  if (b > retryConfig.maxMs + 1) {
    check(`backoffMs(20) capped: ${b}`, false);
    break;
  }
}
check("backoffMs(20) capped at maxMs", true);

// 3. withResilience retries 429 then succeeds
{
  let calls = 0;
  const result = await withResilience("test", async () => {
    calls += 1;
    if (calls < 3) {
      const e = new Error("server error");
      e.status = 429;
      throw e;
    }
    return "ok";
  });
  check("retries until success", result === "ok" && calls === 3, `calls=${calls}`);
}

// 4. withResilience surfaces 4xx immediately
{
  let calls = 0;
  let thrown;
  try {
    await withResilience("test", async () => {
      calls += 1;
      const e = new Error("bad request");
      e.status = 400;
      throw e;
    });
  } catch (e) {
    thrown = e;
  }
  check("400 does NOT retry", calls === 1 && thrown && thrown.status === 400, `calls=${calls}`);
}

// 5. withResilience respects maxRetries
{
  let calls = 0;
  let thrown;
  try {
    await withResilience("test", async () => {
      calls += 1;
      const e = new Error("still down");
      e.status = 503;
      throw e;
    });
  } catch (e) {
    thrown = e;
  }
  check("503 retries up to maxRetries", calls === retryConfig.maxRetries + 1, `calls=${calls} maxRetries=${retryConfig.maxRetries}`);
  check("503 final error preserved", thrown && thrown.status === 503);
}

// 6. fetch_failed is retryable
{
  let calls = 0;
  const result = await withResilience("test", async () => {
    calls += 1;
    if (calls < 2) {
      const e = new Error("ECONNRESET");
      e.code = "fetch_failed";
      throw e;
    }
    return "ok";
  });
  check("fetch_failed is retryable", result === "ok" && calls === 2, `calls=${calls}`);
}

// 7. Metrics: counters move
const m1 = metrics();
check("metrics.requests is a number", typeof m1.requests === "number");
check("metrics.circuit is a string", typeof m1.circuit === "string");
check("metrics.circuitFailuresInWindow is a number", typeof m1.circuitFailuresInWindow === "number");
check("metrics.tokens is an object", m1.tokens && typeof m1.tokens === "object");
check("metrics.tokens.prompt is a number", typeof m1.tokens.prompt === "number");
check("metrics.tokens.completion is a number", typeof m1.tokens.completion === "number");
check("metrics.tokens.total is a number", typeof m1.tokens.total === "number");

// 7b. recordUsage accumulates correctly. The module state is shared
// across tests, so we read the totals, record a known delta, and
// verify the totals moved by exactly that delta.
{
  const before = metrics().tokens;
  const u = { input_tokens: 12, output_tokens: 34, total_tokens: 46 };
  recordUsage(u);
  const after = metrics().tokens;
  check("recordUsage: prompt delta", after.prompt - before.prompt === 12, `delta=${after.prompt - before.prompt}`);
  check("recordUsage: completion delta", after.completion - before.completion === 34, `delta=${after.completion - before.completion}`);
  check("recordUsage: total delta", after.total - before.total === 46, `delta=${after.total - before.total}`);
}

// 7c. recordUsage tolerates missing fields.
{
  const before = metrics().tokens;
  recordUsage({ input_tokens: 5 });
  const after = metrics().tokens;
  check("recordUsage: missing output_tokens defaults to 0", after.completion === before.completion);
  check("recordUsage: missing total_tokens defaults to prompt+0", after.total - before.total === 5);
}

// 7d. recordUsage ignores null / non-object input without throwing.
{
  const before = metrics().tokens;
  recordUsage(null);
  recordUsage(undefined);
  recordUsage(42);
  const after = metrics().tokens;
  check("recordUsage: no-op on bad input", after.total === before.total);
}

// 8. circuitPermits is true by default (the module is fresh, but
// other tests may have failed the circuit; verify we can recover
// via the metrics path: we just check it returns a boolean).
check("circuitPermits returns boolean", typeof circuitPermits() === "boolean");
check("circuitStatus returns string", typeof circuitStatus() === "string");

console.log(failed === 0 ? "\nALL GREEN" : `\n${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
