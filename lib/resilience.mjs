// resilience.mjs: backoff retry, circuit breaker, and in-memory metrics
// for the upstream ChatGPT Responses API.
//
// Goals:
//   * Survive transient 429/5xx without surfacing the error to the
//     client when a quick retry would have worked.
//   * Stop hammering the API when it is clearly down (circuit
//     breaker) so the bridge does not amplify an outage.
//   * Surface a small set of counters at /v1/health so an operator
//     can see whether the bridge is healthy without log scraping.
//
// This module is in-memory and process-local. State resets on
// restart, which is fine for a single-process bridge.

import { appendFileSync } from "node:fs";

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_MS = 400;
const DEFAULT_MAX_MS = 8_000;
const CIRCUIT_FAIL_THRESHOLD = 5;        // consecutive failures to open
const CIRCUIT_WINDOW_MS = 30_000;        // failures older than this drop off
const CIRCUIT_COOLDOWN_MS = 15_000;      // how long we stay open before half-open

const state = {
  // metrics
  requests: 0,
  successes: 0,
  failures: 0,
  retries: 0,
  lastError: null,
  lastSuccessAt: 0,
  lastFailureAt: 0,
  // token usage accumulated since process start. The bridge reads
  // `usage` (input_tokens / output_tokens / total_tokens) out of every
  // successful Responses API response and sums it here. This is the
  // closest thing the bridge has to a "credits used" counter: the
  // ChatGPT subscription does not expose a per-account quota, so
  // the only observable usage is what flows through the proxy.
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  // circuit breaker
  failureTimes: [],   // timestamps of recent failures
  circuitOpenedAt: 0, // 0 = closed; >0 = open since this timestamp
  halfOpenProbe: null, // one in-flight probe during half-open
};

export function recordSuccess() {
  state.requests += 1;
  state.successes += 1;
  state.lastSuccessAt = Date.now();
  state.lastError = null;
  // A success closes the circuit if we are in half-open.
  if (state.circuitOpenedAt) {
    state.circuitOpenedAt = 0;
    state.halfOpenProbe = null;
    log("info", "circuit.closed");
  }
}

export function recordFailure(err) {
  state.requests += 1;
  state.failures += 1;
  state.lastFailureAt = Date.now();
  state.lastError = err?.message || String(err);
  const now = Date.now();
  state.failureTimes = state.failureTimes.filter((t) => now - t < CIRCUIT_WINDOW_MS);
  state.failureTimes.push(now);
  if (
    state.circuitOpenedAt === 0 &&
    state.failureTimes.length >= CIRCUIT_FAIL_THRESHOLD
  ) {
    state.circuitOpenedAt = now;
    log("warn", "circuit.opened", { failures: state.failureTimes.length, windowMs: CIRCUIT_WINDOW_MS });
  }
}

// Returns true if the breaker permits a request right now. If the
// breaker is open but the cooldown has elapsed, returns true once
// (half-open probe); the caller must call recordSuccess or
// recordFailure to close or re-open the circuit.
export function circuitPermits() {
  if (state.circuitOpenedAt === 0) return true;
  const now = Date.now();
  const openFor = now - state.circuitOpenedAt;
  if (openFor < CIRCUIT_COOLDOWN_MS) return false;
  if (state.halfOpenProbe) return false;
  state.halfOpenProbe = "in-flight";
  log("info", "circuit.half_open", { openForMs: openFor });
  return true;
}

export function circuitStatus() {
  if (state.circuitOpenedAt === 0) return "closed";
  const openFor = Date.now() - state.circuitOpenedAt;
  if (openFor < CIRCUIT_COOLDOWN_MS) return "open";
  return "half_open";
}

// Compute the backoff delay before the next attempt. attempt is
// 0-indexed: 0 means the first retry, etc.
export function backoffMs(attempt) {
  const exp = Math.min(DEFAULT_MAX_MS, DEFAULT_BASE_MS * 2 ** attempt);
  // Full jitter: random in [0, exp].
  return Math.floor(Math.random() * exp);
}

export function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status);
}

export const retryConfig = {
  maxRetries: DEFAULT_MAX_RETRIES,
  baseMs: DEFAULT_BASE_MS,
  maxMs: DEFAULT_MAX_MS,
};

export function metrics() {
  return {
    requests: state.requests,
    successes: state.successes,
    failures: state.failures,
    retries: state.retries,
    lastError: state.lastError,
    lastSuccessAt: state.lastSuccessAt,
    lastFailureAt: state.lastFailureAt,
    tokens: {
      prompt: state.promptTokens,
      completion: state.completionTokens,
      total: state.totalTokens,
    },
    circuit: circuitStatus(),
    circuitFailuresInWindow: state.failureTimes.length,
  };
}

// Sum the token counts from a successful Responses API response
// into the in-memory counters. The wire shape is
// `{ input_tokens, output_tokens, total_tokens }`; missing fields
// default to 0. Idempotent and safe to call multiple times for the
// same response (callers should only call once per success).
export function recordUsage(usage) {
  if (!usage || typeof usage !== "object") return;
  const prompt = Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
  const completion = Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;
  const total = Number.isFinite(usage.total_tokens)
    ? usage.total_tokens
    : prompt + completion;
  state.promptTokens += prompt;
  state.completionTokens += completion;
  state.totalTokens += total;
}

// Wrap an async function with retry + circuit breaker semantics.
// fn() must throw an Error with .status attached when the response
// is a retryable HTTP error. onRetry(attempt, delayMs, err) is
// called before sleeping between attempts.
export async function withResilience(label, fn, { onRetry, signal } = {}) {
  if (!circuitPermits()) {
    const err = new Error(`circuit open: ${label}`);
    err.status = 503;
    err.code = "circuit_open";
    throw err;
  }
  let lastErr;
  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.code = "aborted";
      throw e;
    }
    try {
      const result = await fn(attempt);
      recordSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      const retryable = isRetryableStatus(status) || err?.code === "fetch_failed";
      if (!retryable || attempt === retryConfig.maxRetries) {
        recordFailure(err);
        throw err;
      }
      state.retries += 1;
      const delay = backoffMs(attempt);
      if (onRetry) onRetry(attempt, delay, err);
      log("warn", "retry", { label, attempt: attempt + 1, status, delayMs: delay, err: err?.message });
      if (signal) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, delay);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(Object.assign(new Error("aborted"), { code: "aborted" }));
          }, { once: true });
        });
      } else {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  recordFailure(lastErr);
  throw lastErr;
}

function log(level, msg, extra) {
  try {
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(extra || {}) });
    appendFileSync(process.env.CODEX_BRIDGE_LOG || "/tmp/codex-bridge.log", line + "\n");
  } catch {
    // best-effort logging; never throw from the resilience layer
  }
}
