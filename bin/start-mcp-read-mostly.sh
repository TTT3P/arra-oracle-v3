#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN_BIN="${ARRA_BUN_BIN:-}"

if [[ -z "$BUN_BIN" ]]; then
  BUN_BIN="$(command -v bun || true)"
fi
if [[ -z "$BUN_BIN" && -x "${HOME:-}/.bun/bin/bun" ]]; then
  BUN_BIN="${HOME}/.bun/bin/bun"
fi
if [[ -z "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
  echo "Arra MCP launcher: Bun executable not found" >&2
  exit 1
fi

ORACLE_DATA_DIR="${ORACLE_DATA_DIR:-${HOME}/.arra-oracle-v2}"
export ORACLE_DATA_DIR
export ORACLE_READ_ONLY=true

# Delegates own no memory and receive no remote-write route. Read-mostly seats
# retain the single bounded owner-core exception implemented by Oracle itself.
#
# Search/read stay LOCAL (embedded) on read-mostly + delegate seats BY DESIGN — do NOT set
# ORACLE_HTTP_URL to proxy them. Documented reason (Riddler R1 verification 2026-08-18,
# src/mcp/http-proxy.ts): ORACLE_REMOTE_WRITE_URL routes ONLY remoteWriteSafe (write) tools to
# the owner core; "unlike ORACLE_HTTP_URL it must NOT flip every remoteable tool into HTTP-proxy
# mode — search/read stay local." So local search is intentional; the fix for its concurrent-embed
# collapse is the fast-GPU embed default + admission gate below, not a proxy switch.
if [[ "${ORACLE_PROFILE:-}" == "delegate" ]]; then
  unset ORACLE_REMOTE_WRITE_URL
  unset ORACLE_HTTP_URL
  unset ORACLE_API
  unset NEO_ARRA_API
else
  export ORACLE_REMOTE_WRITE_URL="${ORACLE_REMOTE_WRITE_URL:-http://127.0.0.1:47778}"
fi

export ORACLE_VECTOR_DB="${ORACLE_VECTOR_DB:-lancedb}"
export ORACLE_VECTOR_DB_PATH="${ORACLE_VECTOR_DB_PATH:-$ORACLE_DATA_DIR/lancedb}"
export ORACLE_EMBEDDER="${ORACLE_EMBEDDER:-ollama}"
export ORACLE_EMBEDDING_MODEL="${ORACLE_EMBEDDING_MODEL:-bge-m3}"
# Local search embeds here (read-mostly search does not proxy — see above). Default to the local Mac
# CPU ollama (:11434) — reliable, no VRAM contention with ComfyUI (BL-229, TINE word 2026-10-09). The
# win CUDA GPU tunnel (:11435) stays available as a fallback / explicit drain burst, NOT the default.
export OLLAMA_BASE_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
# ${VAR-default} (no colon): unset → default, but an explicit EMPTY value (deliberate
# no-fallback) is preserved rather than clobbered (consumer: src/vector/ollama-url-chain.ts:21).
export OLLAMA_FALLBACK_BASE_URLS="${OLLAMA_FALLBACK_BASE_URLS-http://127.0.0.1:11435}"
# Apply the retrieve-depth default only when NEITHER the current var NOR the legacy
# ORACLE_SEARCH_RETRIEVE_DEPTH is set — the consumer (src/search/retrieve-depth.ts:4-6) reads
# both, so a seat that explicitly set the legacy var must not be shadowed.
if [[ -z "${ORACLE_RETRIEVE_DEPTH:-}" && -z "${ORACLE_SEARCH_RETRIEVE_DEPTH:-}" ]]; then
  export ORACLE_RETRIEVE_DEPTH=60
fi
# Bound concurrent local searches/embeds so N-parallel oracle_search cannot pile embeds onto the
# tunnel (admission gate; SearchOverloadedError beyond the limit). Tune per seat.
export ORACLE_SEARCH_MAX_INFLIGHT="${ORACLE_SEARCH_MAX_INFLIGHT:-4}"
export ORACLE_TOOL_GROUPS_HOT_RELOAD="${ORACLE_TOOL_GROUPS_HOT_RELOAD:-0}"
export ARRA_PLUGIN_HOT_RELOAD="${ARRA_PLUGIN_HOT_RELOAD:-0}"

exec "$BUN_BIN" "$ROOT/bin/mcp.ts"
