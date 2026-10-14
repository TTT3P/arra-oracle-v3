#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="${ARRA_BUN_BIN:-}"
if [[ -z "$BUN_BIN" ]]; then
  if command -v bun >/dev/null 2>&1; then
    BUN_BIN="$(command -v bun)"
  elif [[ -x "$HOME/.bun/bin/bun" ]]; then
    BUN_BIN="$HOME/.bun/bin/bun"
  else
    echo "Oracle owner launcher: bun not found" >&2
    exit 127
  fi
fi

export ORACLE_PROFILE=owner
export ORACLE_READ_ONLY=false
export ORACLE_HTTP_URL="${ORACLE_HTTP_URL:-http://127.0.0.1:47778}"
export ORACLE_DATA_DIR="${ORACLE_DATA_DIR:-$HOME/.arra-oracle-v2}"
export ORACLE_VECTOR_DB="${ORACLE_VECTOR_DB:-lancedb}"
export ORACLE_LANCEDB_PATH="${ORACLE_LANCEDB_PATH:-$ORACLE_DATA_DIR/lancedb}"
export ORACLE_EMBEDDING_MODEL="${ORACLE_EMBEDDING_MODEL:-bge-m3}"
# Embeds use the local Mac CPU ollama (:11434) ONLY — reliable, no VRAM contention with ComfyUI
# (win GPU priority 1) and no SSH-tunnel dependency (BL-229, TINE word 2026-10-09 'ย้าย'). The win
# CUDA GPU tunnel (:11435) is NO LONGER an auto-fallback: a dead tunnel (local listener up, forwarded
# channel broken) silently degraded fleet vector search (BL-B, TINE word 2026-10-15 'แก้'). Explicit
# env still overrides; the tunnel remains usable for an explicit off-peak drain burst if set.
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
# ${VAR-default} (no colon): unset → NO fallback (empty), but an explicit value (incl. a deliberate
# :11435 drain burst) is preserved rather than clobbered (consumer: src/vector/ollama-url-chain.ts:21).
export OLLAMA_FALLBACK_BASE_URLS="${OLLAMA_FALLBACK_BASE_URLS-}"
# Apply the retrieve-depth default only when NEITHER the current var NOR the legacy
# ORACLE_SEARCH_RETRIEVE_DEPTH is set — the consumer (src/search/retrieve-depth.ts:4-6) reads
# both, so a seat that explicitly set the legacy var must not be shadowed.
if [[ -z "${ORACLE_RETRIEVE_DEPTH:-}" && -z "${ORACLE_SEARCH_RETRIEVE_DEPTH:-}" ]]; then
  export ORACLE_RETRIEVE_DEPTH=60
fi
# Bound concurrent searches/embeds (admission gate; SearchOverloadedError beyond the limit).
export ORACLE_SEARCH_MAX_INFLIGHT="${ORACLE_SEARCH_MAX_INFLIGHT:-4}"
export ORACLE_TOOL_GROUPS_HOT_RELOAD="${ORACLE_TOOL_GROUPS_HOT_RELOAD:-0}"
unset ORACLE_REMOTE_WRITE_URL

exec "$BUN_BIN" "$ROOT/bin/mcp.ts" "$@"
