// tools-registry: tracks the list of MCP tools available to the bridge.
//
// In a normal ChatGPT Plus setup, the model "knows" about its tools via a
// system prompt that lists them. OpenCode does NOT inject the live MCP
// catalog into /v1/chat/completions (it only sends `tools` when the AI SDK
// explicitly enabled tool calling on the provider). To make the bridge feel
// like Plus, we maintain a small registry that the OpenCode plugin can
// populate via /v1/tools, and that handleChatCompletions injects into the
// system prompt when the model has no other source of tool awareness.
//
// The registry is in-memory and process-local. A real deployment would
// persist this to ~/.codex/tools_cache.json, but the bridge process is
// short-lived enough (one process per TUI session is overkill; the TUI
// restarts re-register via the plugin) that the in-memory map is fine.

const tools = new Map(); // name -> { server, description, parameters, serverType, command?, url? }

export function registerTool(name, meta) {
  if (!name) return;
  tools.set(name, {
    server: meta.server || "unknown",
    description: meta.description || "",
    parameters: meta.parameters || { type: "object", properties: {} },
    serverType: meta.serverType || "local",
    command: meta.command,
    url: meta.url,
    registeredAt: Date.now(),
  });
}

export function registerTools(list) {
  if (!Array.isArray(list)) return;
  for (const t of list) {
    if (t?.name) registerTool(t.name, t);
  }
}

export function listTools() {
  return Array.from(tools.entries()).map(([name, meta]) => ({ name, ...meta }));
}

export function clearTools() {
  tools.clear();
}

// Render the registry as a system-prompt block. We use a compact format
// the model can parse: each tool on its own line with a JSON schema.
export function renderToolsSystemBlock() {
  if (tools.size === 0) return "";
  const lines = ["You have access to the following tools. To call one, emit a tool_call with the matching name and JSON arguments."];
  for (const [name, meta] of tools.entries()) {
    const params = JSON.stringify(meta.parameters || { type: "object" });
    const desc = meta.description ? ` — ${meta.description}` : "";
    lines.push(`- ${name}${desc}  args=${params}`);
  }
  return lines.join("\n");
}
