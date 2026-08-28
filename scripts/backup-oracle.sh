#!/bin/bash
# Nightly Oracle DB backup (ORA-BACKUP-AUTO-01).
# online-safe `sqlite3 .backup` -> integrity_check -> retention (7 daily + 4 weekly)
# -> off-Mac sync of the newest copy to the Windows/WSL node over Tailscale.
# Every failure exits non-zero AND writes an ERROR line to the log the RUNBOOK names.
set -euo pipefail

DATA_DIR="${ORACLE_DATA_DIR:-$HOME/.arra-oracle-v2}"
DB="${ORACLE_DB_PATH:-$DATA_DIR/oracle.db}"
BACKUP_DIR="${ARRA_BACKUP_DIR:-$DATA_DIR/backups}"
LOG="${ARRA_BACKUP_LOG:-$DATA_DIR/oracle-backup.log}"
SQLITE="${ARRA_BACKUP_SQLITE:-$(command -v sqlite3 || echo /usr/bin/sqlite3)}"
KEEP_DAILY="${ARRA_BACKUP_KEEP_DAILY:-7}"
KEEP_WEEKLY="${ARRA_BACKUP_KEEP_WEEKLY:-4}"
# off-Mac destination (WSL over Tailscale). Remote rsync runs inside WSL via `wsl -u <user>`.
REMOTE_HOST="${ARRA_BACKUP_REMOTE_HOST:-win}"
REMOTE_WSL_USER="${ARRA_BACKUP_REMOTE_WSL_USER:-tt3p}"
REMOTE_DIR="${ARRA_BACKUP_REMOTE_DIR:-/home/tt3p/arra-oracle-backups}"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=20"

log(){ printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }
fail(){ log "ERROR: $*"; echo "arra-backup ERROR: $*" >&2; exit 1; }
fsize(){ stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null; }

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/oracle.db.$STAMP"
log "START db=$DB dest=$DEST"
[ -f "$DB" ] || fail "source DB not found: $DB"
[ -x "$SQLITE" ] || fail "sqlite3 not executable: $SQLITE"

# 1. online-safe backup copy
"$SQLITE" "$DB" ".backup '$DEST'" || fail "sqlite .backup failed"
[ -s "$DEST" ] || fail "backup copy empty: $DEST"

# 2. integrity_check on the COPY (never the live DB)
IC="$("$SQLITE" "$DEST" 'PRAGMA integrity_check;' 2>&1 | head -1)"
[ "$IC" = "ok" ] || fail "integrity_check on copy != ok: $IC"
log "OK integrity_check=ok size=$(fsize "$DEST") $DEST"

# 3. retention: keep newest KEEP_DAILY + newest-per-ISO-week for KEEP_WEEKLY weeks
prune_retention(){
  local all keep seen wk stamp f wk_count
  all="$(ls -1 "$BACKUP_DIR"/oracle.db.* 2>/dev/null | sort -r)" || return 0
  [ -z "$all" ] && return 0
  keep="$(mktemp)"; printf '%s\n' "$all" | head -n "$KEEP_DAILY" > "$keep"
  seen=" "; wk_count=0
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    stamp="$(basename "$f")"; stamp="${stamp#oracle.db.}"
    wk="$(date -j -u -f "%Y%m%dT%H%M%SZ" "$stamp" +%G-%V 2>/dev/null)" || continue
    case "$seen" in *" $wk "*) continue;; esac
    seen="$seen$wk "; wk_count=$((wk_count+1))
    [ "$wk_count" -le "$KEEP_WEEKLY" ] && printf '%s\n' "$f" >> "$keep"
  done <<< "$all"
  sort -u "$keep" -o "$keep"
  printf '%s\n' "$all" | while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in "$BACKUP_DIR"/oracle.db.*) : ;; *) continue;; esac   # guard: only ever our backups
    grep -qxF -- "$f" "$keep" || { rm -f -- "$f" && log "PRUNE $f"; }
  done
  rm -f "$keep"
}
prune_retention

# 4. off-Mac sync of the newest copy, then verify the remote size matches
if rsync -e "ssh $SSH_OPTS" --rsync-path="wsl -u $REMOTE_WSL_USER -- rsync" "$DEST" "$REMOTE_HOST:$REMOTE_DIR/" >>"$LOG" 2>&1; then
  RSIZE="$(ssh $SSH_OPTS "$REMOTE_HOST" "wsl -u $REMOTE_WSL_USER -- stat -c%s '$REMOTE_DIR/oracle.db.$STAMP'" 2>/dev/null | tr -dc '0-9')"
  LSIZE="$(fsize "$DEST")"
  [ -n "$RSIZE" ] && [ "$RSIZE" = "$LSIZE" ] || fail "off-Mac copy size mismatch (local=$LSIZE remote=${RSIZE:-none})"
  log "OK off-Mac $REMOTE_HOST:$REMOTE_DIR/oracle.db.$STAMP size=$RSIZE"
else
  fail "off-Mac rsync to $REMOTE_HOST:$REMOTE_DIR failed (see log above)"
fi

log "DONE $STAMP"
echo "arra-backup OK: $DEST (integrity ok, synced to $REMOTE_HOST:$REMOTE_DIR)"
