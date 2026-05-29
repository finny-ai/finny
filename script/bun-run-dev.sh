#!/usr/bin/env bash
# Launch Phoenix collector + Finny with OTEL tracing enabled.
#
# Usage:
#   ./script/bun-run-dev.sh           # start Phoenix, then run finny dev
#   ./script/bun-run-dev.sh --only    # start Phoenix only (use separate terminal for finny)
#
# Phoenix UI:  http://localhost:6006
# Phoenix log: /tmp/phoenix-finny.log

set -euo pipefail

PHOENIX_PORT="${PHOENIX_PORT:-6006}"
PHOENIX_LOG="${PHOENIX_LOG:-/tmp/phoenix-finny.log}"

if [[ -n "${PHOENIX_BIN:-}" ]] && command -v "$PHOENIX_BIN" &>/dev/null; then
  PHOENIX_CMD="$PHOENIX_BIN"
elif command -v phoenix &>/dev/null; then
  PHOENIX_CMD="phoenix"
elif command -v "$HOME/Library/Python/3.9/bin/phoenix" &>/dev/null; then
  PHOENIX_CMD="$HOME/Library/Python/3.9/bin/phoenix"
else
  echo "Phoenix not found. Install: pip3 install arize-phoenix"
  exit 1
fi

if curl -s "http://localhost:${PHOENIX_PORT}" >/dev/null 2>&1; then
  echo "Phoenix already running at http://localhost:${PHOENIX_PORT}"
else
  echo "Starting Phoenix (log: ${PHOENIX_LOG})..."
  PHOENIX_PORT="$PHOENIX_PORT" "$PHOENIX_CMD" serve >"$PHOENIX_LOG" 2>&1 &
  PHOENIX_PID=$!

  for i in {1..20}; do
    if curl -s "http://localhost:${PHOENIX_PORT}" >/dev/null 2>&1; then
      echo "Phoenix ready at http://localhost:${PHOENIX_PORT}"
      break
    fi
    sleep 1
  done

  if ! curl -s "http://localhost:${PHOENIX_PORT}" >/dev/null 2>&1; then
    echo "Phoenix failed to start. Check ${PHOENIX_LOG}"
    exit 1
  fi

  trap "kill $PHOENIX_PID 2>/dev/null" EXIT
fi

if [[ "${1:-}" == "--only" ]]; then
  echo ""
  echo "Phoenix running. In your finny terminal, run:"
  echo "  export PHOENIX_COLLECTOR_ENDPOINT=http://localhost:${PHOENIX_PORT}"
  echo ""
  echo "Then start finny normally. Traces → http://localhost:${PHOENIX_PORT}"
  wait
else
  export PHOENIX_COLLECTOR_ENDPOINT="http://localhost:${PHOENIX_PORT}"
  echo "Traces → http://localhost:${PHOENIX_PORT}"
  bun run dev
fi
