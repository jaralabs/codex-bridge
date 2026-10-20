#!/usr/bin/env node
// Unit tests for the reasoning-effort mapping.
//
// Pure unit: no network, no server. The mapping decides whether the
// bridge forwards a thinking level to the upstream Responses API and
// which upstream effort it uses.

import { resolveReasoningEffort, SUPPORTED_EFFORTS } from "../lib/reasoning.mjs";

let failed = 0;
function check(name, ok, extra) {
  const tag = ok ? "PASS" : "FAIL";
  if (!ok) failed++;
  console.log(`[${tag}] ${name}`, extra ?? "");
}

// --- Pi thinking levels map onto supported upstream efforts ---
check("off -> none", resolveReasoningEffort("off") === "none");
check("minimal -> minimal", resolveReasoningEffort("minimal") === "minimal");
check("low -> low", resolveReasoningEffort("low") === "low");
check("medium -> medium", resolveReasoningEffort("medium") === "medium");
check("high -> high", resolveReasoningEffort("high") === "high");
check("xhigh -> xhigh", resolveReasoningEffort("xhigh") === "xhigh");
check("max -> max", resolveReasoningEffort("max") === "max");

// --- Case and whitespace tolerance ---
check("uppercase is normalized", resolveReasoningEffort("HIGH") === "high");
check("surrounding space is trimmed", resolveReasoningEffort("  medium  ") === "medium");

// --- Values that must not reach the upstream ---
check("undefined -> null", resolveReasoningEffort(undefined) === null);
check("null -> null", resolveReasoningEffort(null) === null);
check("empty string -> null", resolveReasoningEffort("") === null);
check("unknown value -> null", resolveReasoningEffort("banana") === null);
check("non-string -> null", resolveReasoningEffort(42) === null);

// --- Every supported upstream effort survives the mapping unchanged ---
for (const effort of SUPPORTED_EFFORTS) {
  check(`${effort} is supported upstream`, resolveReasoningEffort(effort) === effort);
}

// --- The upstream set is exactly the documented one ---
check(
  "supported efforts are none..max",
  SUPPORTED_EFFORTS.join(",") === "none,minimal,low,medium,high,xhigh,max",
  SUPPORTED_EFFORTS.join(",")
);

if (failed > 0) {
  console.error(`\n${failed} FAILED`);
  process.exit(1);
}
console.log("\nALL GREEN");
