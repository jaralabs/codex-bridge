// Reasoning-effort mapping between OpenAI Chat Completions and the
// ChatGPT Responses API.
//
// Chat Completions clients (Pi, OpenCode, the AI SDK) send the thinking
// level as a flat `reasoning_effort` string. The Responses API expects
// `reasoning: { effort }`. The upstream codex endpoint accepts a narrower
// set of efforts than Pi's thinking levels, so the mapping lives here
// instead of being inlined in the request path.

const SUPPORTED_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Pi thinking levels that have no upstream equivalent collapse to the
// closest supported effort. `minimal` and `off` both mean "spend as
// little reasoning as possible".
const ALIASES = {
  off: "low",
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * Resolve a client-supplied reasoning effort into the value the upstream
 * Responses API accepts.
 *
 * @param {unknown} effort - `reasoning_effort` from the chat request.
 * @returns {string|null} The upstream effort, or null when the request
 *   should not carry a reasoning block at all.
 */
export function resolveReasoningEffort(effort) {
  if (typeof effort !== "string") return null;
  const key = effort.trim().toLowerCase();
  if (!key) return null;
  const mapped = ALIASES[key];
  if (mapped) return mapped;
  return SUPPORTED_EFFORTS.includes(key) ? key : null;
}

export { SUPPORTED_EFFORTS, ALIASES };
