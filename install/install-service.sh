#!/usr/bin/env bash
# Install (or remove) the codex-bridge systemd user service.
#
# The service makes the bridge start on login without anyone running
# `devenv` or `codex-bridge start` by hand, and restarts it if it dies.
#
# Usage:
#   install/install-service.sh            # install + enable + start
#   install/install-service.sh uninstall  # stop, disable, remove
#
# It only touches files under $HOME: the wrapper in ~/.local/bin, the
# unit in ~/.config/systemd/user, and the log in
# ~/.local/state/codex-bridge.

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

WRAPPER_SRC="${REPO_DIR}/bin/codex-bridge-service"
WRAPPER_DST="${HOME}/.local/bin/codex-bridge-service"
UNIT_SRC="${SCRIPT_DIR}/codex-bridge.service"
UNIT_DIR="${HOME}/.config/systemd/user"
UNIT_DST="${UNIT_DIR}/codex-bridge.service"
UNIT_NAME="codex-bridge.service"

log() { printf '\033[1;36m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m⚠\033[0m  %s\n' "$1"; }
fail() { printf '\033[1;31m✗\033[0m  %s\n' "$1" >&2; exit 1; }

have_systemd() { command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; }

uninstall_service() {
  if have_systemd; then
    systemctl --user stop "$UNIT_NAME" 2>/dev/null || true
    systemctl --user disable "$UNIT_NAME" 2>/dev/null || true
  fi
  rm -f "$UNIT_DST" "$WRAPPER_DST"
  if have_systemd; then systemctl --user daemon-reload; fi
  log "codex-bridge service removed"
}

if [ "${1:-install}" = "uninstall" ]; then
  uninstall_service
  exit 0
fi

[ -f "$WRAPPER_SRC" ] || fail "wrapper not found: $WRAPPER_SRC"
[ -f "$UNIT_SRC" ] || fail "unit template not found: $UNIT_SRC"

# 1. The wrapper lives in ~/.local/bin so the unit does not depend on a
#    workspace checkout staying mounted.
mkdir -p "$(dirname "$WRAPPER_DST")" "$UNIT_DIR"
install -m 0755 "$WRAPPER_SRC" "$WRAPPER_DST"
log "wrapper installed at $WRAPPER_DST"

# 2. Render the unit with the resolved wrapper path.
sed "s|@WRAPPER@|$WRAPPER_DST|g" "$UNIT_SRC" > "$UNIT_DST"
log "unit written to $UNIT_DST"

if ! have_systemd; then
  warn "systemd user services are unavailable; the unit was written but not enabled."
  warn "Start the bridge manually with: codex-bridge start"
  exit 0
fi

# 3. Enable and start.
systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME" >/dev/null
systemctl --user restart "$UNIT_NAME"
log "service enabled and started"

# 4. Keep the service running when nobody is logged in. Without lingering
#    the unit stops at logout, which is exactly the gap this service is
#    meant to close.
if loginctl show-user "$USER" --property=Linger 2>/dev/null | grep -q "Linger=no"; then
  if loginctl enable-linger "$USER" 2>/dev/null; then
    log "linger enabled: the bridge now starts at boot, not just at login"
  else
    warn "could not enable linger (needs polkit rights); the bridge starts at login only"
  fi
fi

# 5. Wait for the port to answer.
for _ in $(seq 1 20); do
  if curl -fsS -m 2 "http://127.0.0.1:${PORT:-11434}/healthz" >/dev/null 2>&1; then
    log "bridge is up: $(curl -fsS -m 2 "http://127.0.0.1:${PORT:-11434}/healthz")"
    log "logs: journalctl --user -u $UNIT_NAME -f"
    exit 0
  fi
  sleep 0.5
done

warn "the service did not answer on port ${PORT:-11434} within 10s"
journalctl --user -u "$UNIT_NAME" -n 30 --no-pager || true
exit 1
