#!/usr/bin/env bash
# Reproducible README-asset demo environment.
#
# Boots an ISOLATED DeepSeek Harness (its own DSH_HOME under /tmp, its own
# throwaway vault, its own workspace) and installs this plugin from the local
# checkout. It never reads or writes the real ~/.dsh.
#
# Usage:
#   tools/demo/setup.sh start     # install (first run only), seed, boot, print URL
#   tools/demo/setup.sh stop      # stop the demo server
#   tools/demo/setup.sh reset     # stop + wipe the demo DSH_HOME and vault
#   tools/demo/setup.sh url       # print the authenticated URL of a running demo
#
# Then:
#   DSH_URL="$(tools/demo/setup.sh url)" node tools/demo/capture.mjs shots
#   DSH_URL="$(tools/demo/setup.sh url)" node tools/demo/capture.mjs record
#   node tools/demo/make-gif.mjs
#
# Environment:
#   DEMO_DIR    scratch root (default /tmp/dsh-storefront-demo)
#   DSH_VERSION DSH version to install (default 0.2.1-rc.5)
#   DSH_BIN     use an already-installed dsh CLI instead of npm-installing one
#   PLUGIN_SPEC package spec for `dsh plugin add` (default: this checkout)
#   PROFILE     profile name (default web)
#   PORT        web port (default 5601; never 5599 — the packaging verification owns it)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DEMO_DIR="${DEMO_DIR:-/tmp/dsh-storefront-demo}"
DSH_VERSION="${DSH_VERSION:-0.2.1-rc.5}"
PROFILE="${PROFILE:-web}"
PORT="${PORT:-5601}"
PLUGIN_SPEC="${PLUGIN_SPEC:-$REPO}"
NPM_CACHE="$DEMO_DIR/npm-cache"
DSH_RUNTIME="$DEMO_DIR/dsh-runtime"
DSH_HOME="$DEMO_DIR/home"
VAULT="$DEMO_DIR/vault"
WORKSPACE="$DEMO_DIR/workspace"
LOG="$DEMO_DIR/dsh-web.log"
PID_FILE="$DEMO_DIR/dsh-web.pid"

say() { printf '%s\n' "$*" >&2; }

dsh_bin() {
  if [ -n "${DSH_BIN:-}" ]; then printf '%s' "$DSH_BIN"; return; fi
  printf '%s' "$DSH_RUNTIME/node_modules/@deepseek-ai/dsh/lib/bin.js"
}

ensure_runtime() {
  local bin
  bin="$(dsh_bin)"
  if [ -f "$bin" ]; then return; fi
  if [ -n "${DSH_BIN:-}" ]; then
    say "DSH_BIN=$DSH_BIN does not exist"; exit 1
  fi
  say "== installing @deepseek-ai/dsh@$DSH_VERSION into $DSH_RUNTIME (first run, several minutes) =="
  mkdir -p "$DSH_RUNTIME" "$NPM_CACHE"
  npm_config_cache="$NPM_CACHE" npm install --prefix "$DSH_RUNTIME" --no-audit --no-fund --loglevel=error \
    "@deepseek-ai/dsh@$DSH_VERSION"
}

dsh() {
  local bin
  bin="$(dsh_bin)"
  DSH_HOME="$DSH_HOME" node "$bin" "$@"
}

stop_server() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; fi
    rm -f "$PID_FILE"
  fi
  local port_pid
  port_pid="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
  if [ -n "$port_pid" ]; then
    # shellcheck disable=SC2086
    kill $port_pid 2>/dev/null || true
  fi
  for _ in $(seq 1 40); do
    [ -z "$(lsof -ti "tcp:$PORT" 2>/dev/null || true)" ] && return 0
    sleep 0.25
  done
  say "warning: port $PORT is still in use"
}

seed() {
  mkdir -p "$DSH_HOME" "$DEMO_DIR" "$WORKSPACE"
  # 1) vault: always a fresh copy of the committed demo vault
  rm -rf "$VAULT"
  cp -R "$REPO/tools/demo/vault" "$VAULT"

  # 2) vault root for the plugin (its settings file lives under DSH_HOME)
  printf '{\n  "vaultRoot": "%s",\n  "attachmentDir": "attachments",\n  "attachmentMode": "fixed"\n}\n' "$VAULT" \
    > "$DSH_HOME/dsh-obsidian-vault.json"

  # 3) one demo workspace, an English UI, and a first-use directory outside $HOME
  mkdir -p "$DSH_HOME/profiles/$PROFILE" "$DSH_HOME/storages" "$DEMO_DIR/documents"
  cat > "$DSH_HOME/profiles/$PROFILE/cordis.patch.yml" <<EOF
# Demo profile patch layer (applied after the bundle layers).
# 1) The screenshots use an English UI even on a Chinese host.
- id: locale
  config:
    preference: en
# 2) Pin the first-use Workspace under the throwaway demo root, so a demo boot
#    never resolves the real ~/Documents directory.
- id: workspace-controller
  config:
    documentsDirectory: $DEMO_DIR/documents
EOF
  cat > "$DSH_HOME/storages/workspace.json" <<EOF
{
  "unit": { "name": "workspace", "version": 2 },
  "global": {
    "initialized": true,
    "workspaceIds": ["demo-workspace"],
    "archivedSessionIds": [],
    "pinnedSessionIds": [],
    "defaultWorkspaceId": "demo-workspace"
  },
  "tables": {
    "workspaces": {
      "demo-workspace": {
        "path": "$WORKSPACE",
        "title": "demo-project",
        "sessionIds": [],
        "createdAt": "2026-10-31T00:00:00.000Z",
        "updatedAt": "2026-10-31T00:00:00.000Z"
      }
    }
  }
}
EOF
}

install_plugin() {
  say "== installing plugin into isolated profile '$PROFILE': $PLUGIN_SPEC =="
  dsh plugin --profile "$PROFILE" add "$PLUGIN_SPEC"
  local manifest="$DSH_HOME/profiles/$PROFILE/package.json"
  local want
  want="$(node -e 'const p=require(process.argv[1]);console.log(p.name||"")' "$REPO/package.json")"
  if [ -n "$want" ] && node -e '
    const fs = require("fs");
    const [file, name] = process.argv.slice(1);
    const p = JSON.parse(fs.readFileSync(file, "utf8"));
    process.exit((p.dsh?.profile?.bundles ?? []).includes(name) ? 0 : 1);
  ' "$manifest" "$want"; then
    say "   bundle layer registered: $want"
  else
    say "   note: '$want' is not listed in dsh.profile.bundles (a pre-bundle package needs a manual patch row)"
  fi
}

boot() {
  stop_server
  local bin
  bin="$(dsh_bin)"
  say "== booting dsh web on port $PORT (log: $LOG) =="
  DSH_HOME="$DSH_HOME" nohup node "$bin" --profile "$PROFILE" --port "$PORT" --no-open \
    > "$LOG" 2>&1 &
  echo $! > "$PID_FILE"
  for _ in $(seq 1 240); do
    if grep -qE "http://(127\.0\.0\.1|localhost):$PORT/\\?token=" "$LOG" 2>/dev/null; then
      local url
      url="$(sed -nE "s#.*(http://(127\\.0\\.0\\.1|localhost):$PORT/\\?token=[A-Za-z0-9_-]+).*#\\1#p" "$LOG" | head -1)"
      say "   ready: $url"
      say "   (token is local and ephemeral; export DSH_URL to reuse it)"
      return 0
    fi
    if ! kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      say "!! dsh web exited early; last log lines:"
      tail -20 "$LOG" >&2
      exit 1
    fi
    sleep 0.5
  done
  say "!! timed out waiting for the authenticated URL in $LOG"
  exit 1
}

case "${1:-start}" in
  start)
    ensure_runtime
    seed
    install_plugin
    boot
    ;;
  stop)
    stop_server
    say "demo server stopped"
    ;;
  reset)
    stop_server
    rm -rf "$DSH_HOME" "$VAULT" "$WORKSPACE" "$LOG" "$PID_FILE"
    say "removed $DSH_HOME, $VAULT, $LOG"
    ;;
  url)
    if [ ! -f "$LOG" ]; then say "no server log at $LOG"; exit 1; fi
    sed -nE "s#.*(http://(127\\.0\\.0\\.1|localhost):$PORT/\\?token=[A-Za-z0-9_-]+).*#\\1#p" "$LOG" | head -1
    ;;
  *)
    echo "usage: $0 {start|stop|reset|url}" >&2
    exit 2
    ;;
esac
