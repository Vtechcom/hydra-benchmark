#!/usr/bin/env bash
# One entrypoint for every benchmark head, across hydra-node versions and host
# environments.
#
#   ./infra/head.sh start   --version 2.3.0 --env macos-arm64-native
#   ./infra/head.sh start   --version 2.2.0 --port 4004      # side by side
#   ./infra/head.sh status
#   ./infra/head.sh stop    --version 2.2.0
#   ./infra/head.sh list
#
# Version and environment are the two experiment variables; everything else —
# the ledger params, the genesis, the seed UTxO in infra/ledger/ — is shared
# byte-for-byte so a version-to-version delta means the node changed and
# nothing else. State lives in state/<version>/<env>/, results land in
# results/<node-version>/<env>/… (the harness reads the node's own reported
# version, so a mislabelled --version cannot corrupt the result tree).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LEDGER_DIR="$DIR/ledger"

detect_env() {
  case "$(uname -s)/$(uname -m)" in
    Darwin/arm64)  echo "macos-arm64-native" ;;
    Darwin/x86_64) echo "macos-x86_64-native" ;;
    Linux/x86_64)  echo "linux-x86_64-native" ;;
    Linux/aarch64) echo "linux-aarch64-native" ;;
    *)             echo "unknown-native" ;;
  esac
}

CMD="${1:-}"; shift || true
VERSION="${HYDRA_VERSION:-2.3.0}"
ENV_NAME=""
API_PORT="${HYDRA_API_PORT:-4003}"
KEEP_STATE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--version) VERSION="$2"; shift 2 ;;
    -e|--env)     ENV_NAME="$2"; shift 2 ;;
    -p|--port)    API_PORT="$2"; shift 2 ;;
    --keep-state) KEEP_STATE=1; shift ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done
ENV_NAME="${ENV_NAME:-$(detect_env)}"

STATE_DIR="$DIR/state/$VERSION/$ENV_NAME"
LISTEN_PORT=$((API_PORT + 1000))
MONITORING_PORT=$((API_PORT + 2000))

case "$ENV_NAME" in
  docker*) ENV_SCRIPT="$DIR/envs/docker.sh" ;;
  *)       ENV_SCRIPT="$DIR/envs/native.sh" ;;
esac

export DIR LEDGER_DIR STATE_DIR VERSION ENV_NAME API_PORT LISTEN_PORT MONITORING_PORT

case "$CMD" in
  start)
    bash "$ENV_SCRIPT" stop >/dev/null 2>&1 || true
    if [[ "$KEEP_STATE" == "0" ]]; then
      # A finished run leaves thousands of chained UTxOs and a fat snapshot log
      # behind. Re-using that head measures the backlog, not a clean steady
      # state — so a fresh head is the default and keeping state is opt-in.
      rm -rf "$STATE_DIR/persistence"
    fi
    mkdir -p "$STATE_DIR/persistence"
    echo "starting hydra-node $VERSION [$ENV_NAME] on :$API_PORT …"
    bash "$ENV_SCRIPT" start

    # The REST endpoint answers a beat before the seed UTxO is applied; waiting
    # for a non-empty UTxO set is what actually means "ready for a benchmark".
    for i in $(seq 1 90); do
      sleep 1
      UTXO="$(curl -s -m2 "http://127.0.0.1:$API_PORT/snapshot/utxo" 2>/dev/null || true)"
      if [[ -n "$UTXO" && "$UTXO" != "{}" ]]; then
        mkdir -p "$DIR/state"
        printf '{"version":"%s","env":"%s","apiPort":%s,"stateDir":"%s"}\n' \
          "$VERSION" "$ENV_NAME" "$API_PORT" "$STATE_DIR" > "$DIR/state/current.json"
        echo "head Open on :$API_PORT after ${i}s — seed utxo:"
        echo "$UTXO"
        echo
        echo "run against it:  HYDRA_WS=ws://localhost:$API_PORT HYDRA_HTTP=http://localhost:$API_PORT pnpm bench -t perp-state"
        exit 0
      fi
    done
    echo "head did not come up within 90s — see $STATE_DIR/head.log" >&2
    exit 1
    ;;

  stop)
    bash "$ENV_SCRIPT" stop
    rm -f "$DIR/state/current.json"
    ;;

  status)
    if [[ -f "$DIR/state/current.json" ]]; then
      echo "last started: $(cat "$DIR/state/current.json")"
    else
      echo "no head recorded as started by head.sh"
    fi
    for port in $(seq 4000 4010); do
      if curl -s -m1 "http://127.0.0.1:$port/protocol-parameters" >/dev/null 2>&1; then
        echo "  :$port responding"
      fi
    done
    ;;

  list)
    echo "binaries in bin/:"
    ls -1 "$DIR/bin" 2>/dev/null | sed 's/^/  /' || echo "  (none — run ./infra/fetch-node.sh <version>)"
    echo "state dirs:"
    find "$DIR/state" -mindepth 2 -maxdepth 2 -type d 2>/dev/null | sed "s|$DIR/state/|  |" || true
    ;;

  *)
    sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
