// auth.mjs: load, cache, and refresh the ChatGPT account tokens that
// live in ~/.codex/auth.json. The bridge never writes the password
// back to the file; only the refreshed tokens. The cache TTL is short
// (30s) so an external `codex login` is picked up without a bridge
// restart, and refresh is triggered by 401 from the upstream API.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const AUTH_PATH = join(CODEX_HOME, "auth.json");
const AUTH_TTL_MS = 30_000;

const OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

let _authCache = null;
let _authLoadedAt = 0;

export function loadAuth() {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(`auth.json not found at ${AUTH_PATH}; run \`codex login\` first`);
  }
  if (_authCache && Date.now() - _authLoadedAt < AUTH_TTL_MS) return _authCache;
  const raw = readFileSync(AUTH_PATH, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.auth_mode !== "chatgpt") {
    throw new Error(`auth.json auth_mode=${parsed.auth_mode}; only chatgpt supported`);
  }
  _authCache = parsed.tokens;
  _authLoadedAt = Date.now();
  return _authCache;
}

export async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
    scope: "openid profile email offline-access",
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`oauth refresh failed ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const current = _authCache || loadAuth();
  const updated = {
    ...current,
    access_token: json.access_token,
    refresh_token: json.refresh_token || current.refresh_token,
    id_token: json.id_token || current.id_token,
  };
  try {
    const raw = readFileSync(AUTH_PATH, "utf8");
    const file = JSON.parse(raw);
    file.tokens = updated;
    writeFileSync(AUTH_PATH, JSON.stringify(file, null, 2));
  } catch {
    // best-effort; next refresh will try again
  }
  _authCache = updated;
  _authLoadedAt = Date.now();
  return updated;
}

export async function getAuth() {
  const a = loadAuth();
  if (!a.access_token && a.refresh_token) {
    return refreshAccessToken(a.refresh_token);
  }
  return a;
}
