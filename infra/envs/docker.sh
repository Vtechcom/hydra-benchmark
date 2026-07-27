#!/usr/bin/env bash
# Environment: hydra-node in Docker. Only meaningful on a NATIVE amd64 host —
# under Apple Silicon emulation the image's embedded amd64 etcd crashes
# (Rosetta: "Failed to create temporary file"; QEMU: Go runtime SIGSEGV), and
# even when it boots, emulation caps throughput so the number measures Rosetta.
#
# Invoked by head.sh with DIR/LEDGER_DIR/STATE_DIR/VERSION/ENV_NAME/*_PORT exported.
set -euo pipefail

COMPOSE="$DIR/envs/docker-compose.yaml"
PROJECT="hydra-bench-${VERSION//./-}-${API_PORT}"

export HYDRA_VERSION="$VERSION" LEDGER_DIR STATE_DIR API_PORT LISTEN_PORT MONITORING_PORT

case "${1:-}" in
  start)
    mkdir -p "$STATE_DIR/persistence"
    docker compose -p "$PROJECT" -f "$COMPOSE" up -d
    # Mirror the native env's log location so head.log means the same thing everywhere.
    (docker compose -p "$PROJECT" -f "$COMPOSE" logs -f > "$STATE_DIR/head.log" 2>&1 &) || true
    ;;

  stop)
    docker compose -p "$PROJECT" -f "$COMPOSE" down 2>/dev/null || true
    ;;

  *) echo "usage: docker.sh start|stop (called by head.sh)" >&2; exit 2 ;;
esac
