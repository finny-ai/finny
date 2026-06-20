#!/usr/bin/env bash
# Launch Phoenix collector + Finny with OTEL tracing enabled.
#
# Usage:
#   ./script/bun-run-dev.sh           # start Phoenix, then run finny dev
#   ./script/bun-run-dev.sh --only    # start Phoenix only (use separate terminal for finny)
#   ./script/bun-run-dev.sh --server  # start Phoenix, then run the HTTP server without TUI
#
# Phoenix UI:  http://localhost:6006
# Phoenix log: /tmp/phoenix-finny.log

set -euo pipefail

PHOENIX_PORT="${PHOENIX_PORT:-6006}"
PHOENIX_LOG="${PHOENIX_LOG:-/tmp/phoenix-finny.log}"
MODE="${1:-dev}"

case "$MODE" in
  --only | --server | dev) ;;
  *)
    echo "Unknown option: $MODE"
    echo "Usage: $0 [--only|--server]"
    exit 2
    ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v bun &>/dev/null; then
  echo "bun not found. Install Bun first: https://bun.sh"
  exit 1
fi

EXPECTED_BUN="$(sed -n 's/.*"packageManager"[[:space:]]*:[[:space:]]*"bun@\([^"]*\)".*/\1/p' "$ROOT_DIR/package.json" | head -1)"
CURRENT_BUN="$(bun --version)"
if [[ -n "$EXPECTED_BUN" && "$CURRENT_BUN" != "$EXPECTED_BUN" && "${FINNY_SKIP_BUN_VERSION_CHECK:-}" != "1" ]]; then
  echo "Bun version mismatch: repo expects bun@$EXPECTED_BUN, but PATH has bun@$CURRENT_BUN."
  echo "Install/use bun@$EXPECTED_BUN, or rerun with FINNY_SKIP_BUN_VERSION_CHECK=1 if you only need a quick smoke run."
  exit 1
fi

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
  PHOENIX_PID=""
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

if [[ "$MODE" == "--only" ]]; then
  echo ""
  echo "Phoenix running. In your finny terminal, run:"
  echo "  export PHOENIX_COLLECTOR_ENDPOINT=http://localhost:${PHOENIX_PORT}"
  echo ""
  echo "Then start finny normally. Traces → http://localhost:${PHOENIX_PORT}"
  if [[ -n "$PHOENIX_PID" ]]; then
    wait "$PHOENIX_PID"
  fi
else
  export PHOENIX_COLLECTOR_ENDPOINT="http://localhost:${PHOENIX_PORT}"
  echo "Traces → http://localhost:${PHOENIX_PORT}"
  cd "$ROOT_DIR/packages/opencode"
  if [[ "$MODE" == "--server" ]]; then
    bun --conditions=browser ./src/index.ts serve
  else
    if [[ ! -t 0 || ! -t 1 ]]; then
      echo "This script launches the interactive TUI and must run in a real terminal."
      echo "For Phoenix + HTTP server only, use: $0 --server"
      exit 1
    fi
    set +e
    bun --conditions=browser ./src/index.ts
    status=$?
    set -e
    if [[ "$status" -eq 133 ]]; then
      echo ""
      echo "Finny dev exited with SIGTRAP. Common causes:"
      echo "  - running outside a real interactive terminal"
      echo "  - using the wrong Bun version"
      echo "Expected bun@$EXPECTED_BUN, current bun@$CURRENT_BUN"
      echo "For a non-TUI server run, use: $0 --server"
    fi
    exit "$status"
  fi
fi
