#!/bin/bash
# Install the vector-drain indexer daemon as a per-user macOS LaunchAgent.
# Parallels install-vector-launchagent.sh (same KeepAlive/bootout/health pattern)
# so enqueued indexing_jobs never rot when no operator runs index-model manually.

set -euo pipefail

LABEL="com.tt3p.arra-indexer"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${ARRA_INDEXER_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
BUN_BIN="${ARRA_INDEXER_BUN_BIN:-$(command -v bun || true)}"
DATA_DIR="${ORACLE_DATA_DIR:-$HOME/.arra-oracle-v2}"
LAUNCH_AGENT_DIR="${ARRA_INDEXER_LAUNCHAGENT_DIR:-$HOME/Library/LaunchAgents}"
PLIST_PATH="$LAUNCH_AGENT_DIR/$LABEL.plist"
INSTALL_ONLY="${ARRA_INDEXER_INSTALL_ONLY:-0}"
PORT="${ARRA_INDEXER_PORT:-47779}"
OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"
VECTOR_DB="${ORACLE_VECTOR_DB:-lancedb}"

if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
  echo "error: Bun executable not found; set ARRA_INDEXER_BUN_BIN" >&2
  exit 1
fi
if [[ ! -f "$REPO_ROOT/src/indexer/daemon.ts" ]]; then
  echo "error: indexer daemon source not found under $REPO_ROOT" >&2
  exit 1
fi
if [[ ! "$PORT" =~ ^[0-9]+$ || "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
  echo "error: ARRA_INDEXER_PORT must be an integer from 1 to 65535" >&2
  exit 1
fi

for value in "$BUN_BIN" "$REPO_ROOT" "$DATA_DIR" "$PLIST_PATH" "$PORT" "$OLLAMA_URL" "$VECTOR_DB"; do
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    echo "error: LaunchAgent paths cannot contain newlines" >&2
    exit 1
  fi
done

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

# Fail CLOSED before any plist mutation if a FOREIGN process owns the port. A
# listener that is not our managed label (which we would bootout+replace) means
# something else holds :$PORT — silently "scheduling for next login" (the
# vector-installer quirk, RUNBOOK §3) would leave the operator believing the
# daemon is installed while a stranger serves the port. Refuse instead.
domain="gui/$(id -u)"
port_pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
if [[ -n "$port_pids" ]] && ! launchctl print "$domain/$LABEL" >/dev/null 2>&1; then
  echo "error: port $PORT is held by a foreign process (pids: ${port_pids//$'\n'/ }); refusing to install $LABEL" >&2
  exit 1
fi

BUN_DIR="$(dirname "$BUN_BIN")"
mkdir -p "$LAUNCH_AGENT_DIR" "$DATA_DIR"
tmp_plist="$(mktemp "$LAUNCH_AGENT_DIR/.${LABEL}.XXXXXX")"
trap 'rm -f "$tmp_plist"' EXIT

cat > "$tmp_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$BUN_BIN")</string>
    <string>src/indexer/daemon.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$(xml_escape "$REPO_ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$BUN_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")</string>
    <key>ORACLE_DATA_DIR</key>
    <string>$(xml_escape "$DATA_DIR")</string>
    <key>ORACLE_DB_PATH</key>
    <string>$(xml_escape "$DATA_DIR/oracle.db")</string>
    <key>ORACLE_VECTOR_DB</key>
    <string>$(xml_escape "$VECTOR_DB")</string>
    <key>OLLAMA_BASE_URL</key>
    <string>$(xml_escape "$OLLAMA_URL")</string>
    <key>INDEXER_PORT</key>
    <string>$(xml_escape "$PORT")</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$DATA_DIR/arra-indexer.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$DATA_DIR/arra-indexer.error.log")</string>
</dict>
</plist>
PLIST

plutil -lint "$tmp_plist" >/dev/null
chmod 0644 "$tmp_plist"
mv "$tmp_plist" "$PLIST_PATH"
trap - EXIT

echo "installed: $PLIST_PATH"
if [[ "$INSTALL_ONLY" == "1" ]]; then
  exit 0
fi

# We already fail-closed above if a foreign process owns the port. Here the port
# is either free or held by our own managed label — bootout our own before reload.
if launchctl print "$domain/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$domain/$LABEL"
fi
launchctl bootstrap "$domain" "$PLIST_PATH"
launchctl kickstart -k "$domain/$LABEL"
launchctl print "$domain/$LABEL" >/dev/null
# Identity-validate health: any 2xx is not enough — the response must be OUR
# daemon (`service: arra-indexer`), else a stranger on the port would pass.
for _ in {1..40}; do
  body="$(/usr/bin/curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
  if [[ "$body" == *'"service":"arra-indexer"'* ]]; then
    echo "running: $LABEL (http://127.0.0.1:$PORT)"
    exit 0
  fi
  sleep 0.25
done
# Rollback: do not leave a broken managed job loaded.
launchctl bootout "$domain/$LABEL" >/dev/null 2>&1 || true
echo "error: $LABEL loaded but /health did not identify as arra-indexer; booted out. Inspect $DATA_DIR/arra-indexer.error.log" >&2
exit 1
