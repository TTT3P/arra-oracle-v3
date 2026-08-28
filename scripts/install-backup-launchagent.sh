#!/bin/bash
# Install the nightly Oracle DB backup as a per-user macOS LaunchAgent (ORA-BACKUP-AUTO-01).
# Deploys scripts/backup-oracle.sh into the runtime data-dir (decoupled from the source checkout)
# and schedules com.tt3p.arra-backup nightly. Rollback: launchctl bootout gui/$(id -u)/com.tt3p.arra-backup.
set -euo pipefail

LABEL="com.tt3p.arra-backup"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${ORACLE_DATA_DIR:-$HOME/.arra-oracle-v2}"
BIN_DIR="$DATA_DIR/bin"
DEPLOYED="$BIN_DIR/backup-oracle.sh"
SRC="$SCRIPT_DIR/backup-oracle.sh"
LAUNCH_AGENT_DIR="${ARRA_BACKUP_LAUNCHAGENT_DIR:-$HOME/Library/LaunchAgents}"
PLIST_PATH="$LAUNCH_AGENT_DIR/$LABEL.plist"
INSTALL_ONLY="${ARRA_BACKUP_INSTALL_ONLY:-0}"
HOUR="${ARRA_BACKUP_HOUR:-3}"
MINUTE="${ARRA_BACKUP_MINUTE:-30}"
# PATH the job runs with: must reach sqlite3, ssh, rsync (Homebrew + system).
JOB_PATH="${ARRA_BACKUP_PATH:-/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

[ -f "$SRC" ] || { echo "error: backup script not found: $SRC" >&2; exit 1; }
for v in "$DATA_DIR" "$DEPLOYED" "$PLIST_PATH"; do
  case "$v" in *$'\n'*|*$'\r'*) echo "error: paths cannot contain newlines" >&2; exit 1;; esac
done
case "$HOUR$MINUTE" in *[!0-9]*) echo "error: HOUR/MINUTE must be integers" >&2; exit 1;; esac

xml_escape(){ printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"; }

# Deploy the committed script to the runtime bin (SOT stays the repo; this is the traceable deploy copy).
mkdir -p "$BIN_DIR" "$LAUNCH_AGENT_DIR" "$DATA_DIR"
install -m 0755 "$SRC" "$DEPLOYED"
echo "deployed: $DEPLOYED (from $SRC)"

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
    <string>/bin/bash</string>
    <string>$(xml_escape "$DEPLOYED")</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ORACLE_DATA_DIR</key>
    <string>$(xml_escape "$DATA_DIR")</string>
    <key>PATH</key>
    <string>$(xml_escape "$JOB_PATH")</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MINUTE</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$(xml_escape "$DATA_DIR/oracle-backup.log")</string>
  <key>StandardErrorPath</key>
  <string>$(xml_escape "$DATA_DIR/oracle-backup.error.log")</string>
</dict>
</plist>
PLIST

plutil -lint "$tmp_plist" >/dev/null
chmod 0644 "$tmp_plist"
mv "$tmp_plist" "$PLIST_PATH"
trap - EXIT
echo "installed: $PLIST_PATH (nightly $HOUR:$MINUTE local)"
[ "$INSTALL_ONLY" = "1" ] && exit 0

domain="gui/$(id -u)"
launchctl print "$domain/$LABEL" >/dev/null 2>&1 && launchctl bootout "$domain/$LABEL" || true
launchctl bootstrap "$domain" "$PLIST_PATH"
launchctl print "$domain/$LABEL" >/dev/null
echo "loaded: $LABEL — nightly at $HOUR:$MINUTE. First run: launchctl kickstart $domain/$LABEL"
