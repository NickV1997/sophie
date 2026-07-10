#!/usr/bin/env bash
# Launch llama.cpp's llama-server tuned for Sophie.
#
# Beyond the basics, this enables the two llama.cpp features Sophie is built to
# exploit:
#   * prompt-cache reuse (--cache-reuse): Sophie keeps its system prefix
#     byte-stable so the server can reuse the KV cache across rounds;
#   * speculative decoding (-md): a small draft model (e.g. Qwen3-0.6B)
#     proposes tokens the big model verifies — typically 1.5–2.5× faster
#     generation for agent output (JSON tool calls and code draft very well),
#     with IDENTICAL output quality. Set SOPHIE_DRAFT_MODEL_PATH to enable.
#
# Usage:
#   SOPHIE_MODEL_PATH=~/models/Qwen3-9B-Q4_K_M.gguf ./scripts/serve.sh
#   SOPHIE_MODEL_PATH=... SOPHIE_DRAFT_MODEL_PATH=~/models/Qwen3-0.6B-Q8_0.gguf ./scripts/serve.sh
#
# Reads .env from the repo root, so the paths can live there instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$ROOT/.env" ] && set -a && . "$ROOT/.env" && set +a

MODEL="${SOPHIE_MODEL_PATH:-}"
DRAFT="${SOPHIE_DRAFT_MODEL_PATH:-}"
CTX="${SOPHIE_CONTEXT_WINDOW:-32768}"
PORT="${SOPHIE_SERVER_PORT:-8080}"

if [ -z "$MODEL" ]; then
  echo "Set SOPHIE_MODEL_PATH to your main .gguf (in the environment or in .env)." >&2
  exit 1
fi
if ! command -v llama-server >/dev/null 2>&1; then
  echo "llama-server not found. Install llama.cpp (e.g. 'brew install llama.cpp')." >&2
  exit 1
fi

ARGS=(
  -m "$MODEL"
  -c "$CTX"
  --port "$PORT"
  --host 127.0.0.1
  -ngl 99            # full GPU offload; harmless when there's no GPU
  --flash-attn on
  --cache-reuse 256  # reuse cached prefix KV across Sophie's rounds
)

if [ -n "$DRAFT" ]; then
  ARGS+=(
    -md "$DRAFT"
    --draft-max 16   # tokens the draft proposes per step
    --draft-min 1
    --draft-p-min 0.8
    -ngld 99         # offload the draft model too
  )
  echo "Speculative decoding ON (draft: $DRAFT)"
else
  echo "Speculative decoding off — set SOPHIE_DRAFT_MODEL_PATH to a small same-family GGUF (e.g. Qwen3-0.6B) to speed up generation."
fi

echo "Serving $MODEL on http://127.0.0.1:$PORT/v1 (ctx $CTX)"
echo "Point Sophie at it: SOPHIE_BASE_URL=http://127.0.0.1:$PORT/v1"
exec llama-server "${ARGS[@]}"
