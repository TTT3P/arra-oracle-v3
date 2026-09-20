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
# Embeds default to the remote CUDA GPU tunnel (:11435, ~307ms) with the local Mac CPU
# ollama (:11434, ~1650ms = 5x slower) as fallback. Explicit env still overrides both.
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11435}"
# ${VAR-default} (no colon): unset → default, but an explicit EMPTY value (deliberate
# no-fallback) is preserved rather than clobbered (consumer: src/vector/ollama-url-chain.ts:21).
export OLLAMA_FALLBACK_BASE_URLS="${OLLAMA_FALLBACK_BASE_URLS-http://127.0.0.1:11434}"
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
