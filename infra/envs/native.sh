#!/usr/bin/env bash
# Environment: hydra-node running as a native host binary (macOS arm64, Linux x86_64, …).
# Invoked by head.sh with DIR/LEDGER_DIR/STATE_DIR/VERSION/ENV_NAME/*_PORT exported.
#
# Native is the honest default on Apple Silicon: the official image is amd64-only
# and hydra-node embeds an amd64 etcd that crashes under emulation. Rosetta also
# caps sustained throughput, so an emulated head measures the emulator.
set -euo pipefail

BIN="${HYDRA_NODE_BIN:-$DIR/bin/hydra-node-$VERSION}"

case "${1:-}" in
  start)
    if [[ ! -x "$BIN" ]]; then
      echo "hydra-node $VERSION not found at $BIN — run ./infra/fetch-node.sh $VERSION" >&2
      exit 1
    fi

    # Single-party offline head: the hydra key identity is irrelevant, so it is
    # generated per state dir rather than committed.
    KEYS="$STATE_DIR/credentials"
    if [[ ! -f "$KEYS/wallet-hydra.sk" ]]; then
      mkdir -p "$KEYS"
      "$BIN" gen-hydra-key --output-file "$KEYS/wallet-hydra" >/dev/null
    fi

    mkdir -p "$STATE_DIR/persistence"
    nohup "$BIN" \
      --node-id 1 \
      --api-host 0.0.0.0 \
      --api-port "$API_PORT" \
      --listen "0.0.0.0:$LISTEN_PORT" \
      --monitoring-port "$MONITORING_PORT" \
      --hydra-signing-key "$KEYS/wallet-hydra.sk" \
      --persistence-dir "$STATE_DIR/persistence" \
      --persistence-rotate-after 20000 \
      --offline-head-seed 0000000000000000000000000000000000000000000000000000000000000001 \
      --ledger-protocol-parameters "$LEDGER_DIR/protocol-parameters.json" \
      --initial-utxo "$LEDGER_DIR/utxo-1.json" \
      --ledger-genesis "$LEDGER_DIR/shelley-genesis.json" \
      > "$STATE_DIR/head.log" 2>&1 &
    ;;

  stop)
    pkill -f "hydra-node-$VERSION .*--api-port $API_PORT" 2>/dev/null && echo "hydra-node $VERSION stopped." || true
    # An orphan embedded etcd keeps the listen port and breaks the next boot.
    pkill -f "$STATE_DIR/persistence/bin/etcd" 2>/dev/null || true
    ;;

  *) echo "usage: native.sh start|stop (called by head.sh)" >&2; exit 2 ;;
esac
