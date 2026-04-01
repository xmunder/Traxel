#!/usr/bin/env bash

set -euo pipefail

# Supuestos mínimos:
# - `uv` está disponible y el backend ya tiene su entorno/dependencias resueltas.
# - `pnpm` está disponible y el frontend ya tiene dependencias instaladas.
# - El frontend apunta al backend local vía PUBLIC_VECTORIZE_ENDPOINT.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
FRONTEND_DIR="$ROOT_DIR/frontend"
BACKEND_HOST="${BACKEND_HOST:-127.0.0.1}"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_HOST="${FRONTEND_HOST:-127.0.0.1}"
FRONTEND_PORT="${FRONTEND_PORT:-4321}"
VECTORIZE_ENDPOINT="http://${BACKEND_HOST}:${BACKEND_PORT}/vectorize"

backend_pid=""
frontend_pid=""

cleanup() {
  trap - EXIT INT TERM

  if [[ -n "$frontend_pid" ]] && kill -0 "$frontend_pid" 2>/dev/null; then
    kill "$frontend_pid" 2>/dev/null || true
  fi

  if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" 2>/dev/null; then
    kill "$backend_pid" 2>/dev/null || true
  fi

  wait "$frontend_pid" 2>/dev/null || true
  wait "$backend_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

printf 'Levantando backend en http://%s:%s\n' "$BACKEND_HOST" "$BACKEND_PORT"
(
  cd "$BACKEND_DIR"
  exec uv run uvicorn src.main:app --host "$BACKEND_HOST" --port "$BACKEND_PORT"
) &
backend_pid=$!

printf 'Levantando frontend en http://%s:%s\n' "$FRONTEND_HOST" "$FRONTEND_PORT"
(
  cd "$FRONTEND_DIR"
  export PUBLIC_VECTORIZE_ENDPOINT="$VECTORIZE_ENDPOINT"
  exec pnpm dev --host "$FRONTEND_HOST" --port "$FRONTEND_PORT" --strictPort
) &
frontend_pid=$!

printf 'Backend PID: %s\n' "$backend_pid"
printf 'Frontend PID: %s\n' "$frontend_pid"
printf 'Presioná Ctrl+C para apagar ambos procesos limpiamente.\n'

wait -n "$backend_pid" "$frontend_pid"
